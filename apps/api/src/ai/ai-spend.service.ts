import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiModelRef, AiModelView, AiSpendTurnView, AiSpendView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import type { AiInputMode, AiTurnStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_OUTPUT_TOKENS } from './providers/ai-sdk.provider';
import { AI_ENV, type AiEnvironment } from './providers/llm-provider.factory';
import type { LlmImage, LlmMessage, ToolDefinition } from './providers/llm-provider.interface';

/**
 * El libro de gasto (design D3). Es el freno que existe ANTES de que exista un
 * llamador real: reserva antes de tocar la red, liquida con lo que el proveedor
 * reportó, y ante cualquier duda queda CERRADO.
 *
 * ── La regla del dinero ─────────────────────────────────────────────────────
 *
 * Los precios viven como `string` en el catálogo (D1) y toda la aritmética de
 * acá adentro es `Prisma.Decimal` — NUNCA `number`. Un techo calculado con
 * punto flotante binario deriva, y un techo que deriva no es un techo
 * (`schema.prisma:670-672`). Los CONTADORES (caracteres, tokens) sí son
 * `number`, porque son cuentas discretas; entran a la aritmética ya convertidos
 * a `Decimal`.
 *
 * ── Fail-closed, en las dos direcciones ─────────────────────────────────────
 *
 * 1. Sin `AI_SPEND_CEILING_USD` configurado NO se asume un default: todo turno
 *    se rechaza con `ceiling_not_configured` (design D5, PO-4). Tres entornos
 *    cayendo cada uno a US$25 contra un presupuesto de US$30 es exactamente el
 *    modo de falla que esa decisión evita.
 * 2. Si `settleCall` no recibe uso real (el proveedor no lo reportó, o el
 *    intento falló), la reserva se queda como está: nunca se cobra cero por
 *    ignorancia.
 *
 * El gasto suma `cost_usd` de TODOS los estados (PO-3): un `PENDING` es una
 * reserva que ya comprometió presupuesto, y un `CANCELLED` es plata gastada.
 * El gasto con la clave propia del proyecto (FR-D11) cuenta igual: la suma no
 * distingue la fuente de la clave (design D8, tarea 4.6).
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "El gasto se reserva
 * antes de llamar…" y "Límite de ritmo por usuario y por proyecto".
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/**
 * Clave del advisory lock GLOBAL del libro de gasto (design D3). Es global y no
 * por proyecto porque el techo también lo es: uno por entorno (PO-4). Con
 * `ReadCommitted`, la suma que se lee después de tomarlo ya incluye todas las
 * reservas confirmadas antes.
 */
export const AI_SPEND_LOCK_KEY = 418_024_001;

/** Últimos turnos que expone la vista de FR-D12 (tarea 7.1). */
const RECENT_TURNS_LIMIT = 10;

/** Ventana del límite de ritmo: la última hora (FR-D15b.4). */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * `prompt_text` de toda fila de transcripción (PO-3, D4). Es el marcador con el
 * que el libro distingue una transcripción de un turno: NUNCA guarda el texto
 * reconocido. El servicio lo escribe y el conteo de turnos lo EXCLUYE.
 */
export const TRANSCRIPTION_PROMPT_TEXT = '[transcription]';

/**
 * No-transcripción, con el `null` explícito.
 *
 * El `OR` NO es adorno: en SQL `prompt_text <> '[transcription]'` es NULL para
 * las filas con `prompt_text` nulo, así que un `{ not: ... }` a secas las
 * descartaría de los dos conteos. Con el `OR` una fila sin texto sigue contando
 * como turno, que es su lugar.
 */
const NOT_TRANSCRIPTION_WHERE: Prisma.AiTurnWhereInput = {
  OR: [{ promptText: null }, { promptText: { not: TRANSCRIPTION_PROMPT_TEXT } }],
};

/** Qué cuenta una reserva: un turno normal o una transcripción de voz (D4). */
export type SpendKind = 'turn' | 'transcription';

/** Las dimensiones del límite de ritmo, sin arrastrar toda la fila a reservar. */
interface RateLimitSubject {
  readonly kind: SpendKind;
  readonly projectId: string;
  readonly userId: string;
  readonly inputMode: AiInputMode;
}

/** Un millón de tokens, como `Decimal`: nunca como `number` en la aritmética. */
const MTOK = new Prisma.Decimal(1_000_000);

/** Igual que el pipeline de operaciones: una transacción patológica muere con `P2028`, ruidosa y acotada. */
const TRANSACTION_TIMEOUT_MS = 5_000;
const TRANSACTION_MAX_WAIT_MS = 2_000;

/**
 * ── La cota de tokens de una imagen (D9.2, CORREGIDA el 2026-09-18) ──────────
 *
 * El diseño original asumía `ceil(w·h / 500)`. Esa fórmula NO es la regla
 * oficial y, en el caso documentado, SUBESTIMABA: una reserva corta es un turno
 * que se pasa del techo sin que nada lo frene, porque el techo se comprueba
 * ANTES del llamado y la liquidación posterior no puede deshacer lo gastado.
 *
 * La regla oficial del proveedor por defecto (Gemini), verificada contra
 * `https://ai.google.dev/gemini-api/docs/tokens` y
 * `https://ai.google.dev/gemini-api/docs/image-understanding`:
 *
 * 1. Una imagen de **≤ 384 px de cada lado** cuenta **258 tokens** planos.
 * 2. Cualquier imagen más grande se tesela: la unidad de recorte es
 *    `min(floor(min(w, h) / 1.5), 768)` y la grilla es
 *    `ceil(w / unidad) × ceil(h / unidad)`, con **258 tokens por tesela**.
 *    El ejemplo documentado: `960×540` → unidad `360` → grilla `3×2` →
 *    **6 teselas ≈ 1 548 tokens** (la fórmula vieja daba 1 037, un 27% menos).
 * 3. Lo que supera el máximo del modelo se escala a lo sumo a **3072×3072**
 *    ANTES de contar, así que las dimensiones se acotan ahí primero.
 *
 * El `768` reconcilia las dos frases de la documentación: el ejemplo fija la
 * unidad en `min(1.5)` y la doc dice que las teselas son de `768×768`. Cuando
 * discrepan se toma la tesela MÁS CHICA, que da MÁS teselas y por lo tanto una
 * cota más alta: la dirección segura es sobreestimar.
 *
 * Caveats anotados, no accionados: (a) la misma imagen puede contar distinto en
 * Vertex AI que en la API de Gemini (un `700×1003` reportado como ~258 contra
 * ~1806); (b) el cuerpo inline del pedido está acotado a **20 MB en total**
 * (prompt + sistema + imagen), no solo por imagen.
 */
const IMAGE_FLAT_MAX_SIDE = 384;
const IMAGE_TILE_MAX_SIDE = 768;
const IMAGE_TILE_TOKENS = 258;

/** Lado máximo del proveedor por defecto antes de contar: por encima se escala. */
export const IMAGE_MAX_SIDE_BEFORE_COUNT = 3_072;

/**
 * Cota superior de tokens de UNA imagen, con la regla de teselas oficial.
 *
 * Una dimensión inválida (`NaN`, negativa o cero) NO cae a una cota chica: se
 * trata como el máximo del modelo, porque un dato roto no puede abaratar la
 * reserva.
 */
export function imageTokenBound(width: number, height: number): number {
  const w = clampImageSide(width);
  const h = clampImageSide(height);

  if (w <= IMAGE_FLAT_MAX_SIDE && h <= IMAGE_FLAT_MAX_SIDE) return IMAGE_TILE_TOKENS;

  const cropUnit = Math.min(Math.floor(Math.min(w, h) / 1.5), IMAGE_TILE_MAX_SIDE);
  const columns = Math.ceil(w / cropUnit);
  const rows = Math.ceil(h / cropUnit);
  return columns * rows * IMAGE_TILE_TOKENS;
}

/** El lado, ya escalado al máximo del modelo (regla 3 de la cota). */
function clampImageSide(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return IMAGE_MAX_SIDE_BEFORE_COUNT;
  return Math.min(Math.floor(value), IMAGE_MAX_SIDE_BEFORE_COUNT);
}

/** Motivo por el que el libro rechaza un turno. Ni `ceiling` ni `ceiling_not_configured` escriben fila. */
export type SpendRejection =
  | { readonly ok: false; readonly reason: 'ceiling' }
  | { readonly ok: false; readonly reason: 'ceiling_not_configured' }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAt: Date };

/** Resultado de `openTurn`/`reserveCall`: mismo patrón de unión discriminada que `LockOutcome`. */
export type SpendOutcome = { readonly ok: true; readonly turnId: string } | SpendRejection;

/** Costo real de un intento, calculado desde el `usage` que reportó el proveedor. */
export interface ActualCallCost {
  readonly costUsd: Prisma.Decimal;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Lo que hay que estimar para reservar: instrucciones, mensajes, herramientas e imágenes. */
export interface EstimatePayload {
  readonly instructions?: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDefinition[];
  /**
   * Las imágenes del turno, con sus dimensiones (D9.2). Un turno de texto no las
   * trae y su estimación no cambia.
   */
  readonly images?: readonly LlmImage[];
  /**
   * Iteraciones ESPERADAS del bucle que va a reenviar esas imágenes. La reserva
   * de un turno de imagen se hace una sola vez, antes de la primera iteración,
   * así que tiene que cubrir todas: contar la imagen una vez subestima la
   * reserva por un factor igual a la cantidad de iteraciones. Por defecto 1, que
   * es lo correcto para el costo de UN llamado.
   */
  readonly imageIterations?: number;
}

export interface OpenTurnInput {
  readonly projectId: string;
  readonly diagramId: string;
  readonly userId: string;
  readonly inputMode: AiInputMode;
  readonly promptText: string | null;
  /**
   * El proveedor/modelo de la fila. Es `AiModelRef` y no `AiModelView` porque
   * una transcripción no tiene una vista de tokens: la fila solo necesita los
   * dos nombres. Un `AiModelView` sigue encajando (es un superconjunto).
   */
  readonly model: AiModelRef;
  readonly estimate: Prisma.Decimal;
  /**
   * Qué cuenta esta reserva (D4). `transcription` cuenta contra su límite
   * propio y solo las filas con `prompt_text = '[transcription]'`; el conteo de
   * `turn` las excluye. Por defecto `turn`, así que los llamadores anteriores
   * no cambian.
   */
  readonly kind?: SpendKind;
}

export interface ReserveCallInput {
  readonly turnId: string;
  readonly estimate: Prisma.Decimal;
}

export interface SettleCallInput {
  readonly turnId: string;
  readonly estimate: Prisma.Decimal;
  /**
   * `null` = sin uso reportado o intento fallido. En ese caso la reserva se
   * queda COMO ESTÁ: es la dirección fail-closed de la liquidación.
   */
  readonly actual: ActualCallCost | null;
}

export interface CloseTurnInput {
  readonly turnId: string;
  readonly status: AiTurnStatus;
  readonly provider: string;
  readonly model: string;
  readonly fallbackFired: boolean;
  readonly fallbackFrom: string | null;
  readonly latencyMs: number | null;
  /**
   * Iteraciones de tool-calling que consumió el turno (`ai_turns.iterations`,
   * FR-D15b.3). Lo agrega `ai-text-instructions`: es el número que SC-D14 exige
   * (`iterations = 25`) y el que hace auditable un turno que se comió el tope.
   * Un turno sin bucle (salud, un solo llamado) cierra con 1.
   */
  readonly iterations: number;
  readonly errorMessage: string | null;
}

@Injectable()
export class AiSpendService {
  private readonly log = new Logger(AiSpendService.name);

  /**
   * El techo se lee UNA vez, al construir (design D5). `null` significa "sin
   * techo configurado", no "sin límite": con `null` se rechaza todo turno.
   * Un valor mal formado se reporta y se trata como ausente.
   */
  private readonly ceilingUsd: Prisma.Decimal | null;
  private readonly turnsPerHour: number;
  private readonly imageTurnsPerHour: number;
  /** Límite propio de la transcripción, resuelto por el entorno al arrancar (tarea 1.3). */
  private readonly transcriptionsPerHour: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Inject(AI_ENV) env: AiEnvironment,
  ) {
    this.ceilingUsd = this.readCeiling(config);
    this.turnsPerHour = this.readLimit(config, 'AI_RATE_LIMIT_TURNS_PER_HOUR', 20);
    this.imageTurnsPerHour = this.readLimit(config, 'AI_RATE_LIMIT_IMAGE_TURNS_PER_HOUR', 5);
    // Única fuente del límite (tarea 1.3): lo leyó el entorno de IA al arrancar.
    this.transcriptionsPerHour = env.transcription.transcriptionsPerHour;
  }

  /**
   * Pre-chequeo del límite de ritmo PROPIO de la transcripción (D4).
   *
   * Es ADVISORY: el chequeo autoritativo vuelve a correr dentro de `openTurn`,
   * junto con el lock y la reserva, así que dos pedidos simultáneos no pueden
   * pasar los dos. Existe para que la guarda de ritmo corra ANTES de la
   * disponibilidad y de la firma de bytes, que es el orden que fija la spec: un
   * 429 no debe costar una lectura de bytes ni una consulta al proveedor.
   */
  async transcriptionRateLimit(projectId: string, userId: string): Promise<SpendRejection | null> {
    const windowStart = new Date(Date.now() - RATE_WINDOW_MS);
    return this.checkRateLimit(
      this.prisma,
      { kind: 'transcription', projectId, userId, inputMode: 'VOICE' },
      windowStart,
    );
  }

  /**
   * Abre el turno: toma el lock, comprueba el límite de ritmo y el techo con la
   * estimación del primer intento, e inserta la fila `PENDING` con `cost_usd`
   * igual al estimado. Un rechazo devuelve la unión discriminada y NO escribe
   * ninguna fila (design D3, tarea 4.5).
   */
  async openTurn(input: OpenTurnInput): Promise<SpendOutcome> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_WINDOW_MS);

    return this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx);

        if (this.ceilingUsd === null) {
          return this.reject('ceiling_not_configured', {
            turnId: null,
            detail: 'AI_SPEND_CEILING_USD no está configurado; no se asume ningún techo por defecto',
          });
        }

        const limited = await this.checkRateLimit(
          tx,
          {
            kind: input.kind ?? 'turn',
            projectId: input.projectId,
            userId: input.userId,
            inputMode: input.inputMode,
          },
          windowStart,
        );
        if (limited !== null) return limited;

        const spent = await this.spentTotal(tx);
        if (spent.add(input.estimate).gt(this.ceilingUsd)) {
          return this.reject('ceiling', {
            turnId: null,
            detail: `gastado ${spent.toString()} + estimado ${input.estimate.toString()} supera el techo ${this.ceilingUsd.toString()}`,
          });
        }

        const row = await tx.aiTurn.create({
          data: {
            diagramId: input.diagramId,
            userId: input.userId,
            inputMode: input.inputMode,
            promptText: input.promptText,
            provider: input.model.provider,
            model: input.model.model,
            // La reserva ES la estimación: una cota superior de este intento.
            costUsd: input.estimate,
            status: 'PENDING',
          },
          select: { id: true },
        });

        return { ok: true as const, turnId: row.id };
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  /**
   * Reserva del 2.º intento en adelante (design D3): mismo lock, comprueba el
   * techo y suma la estimación a `cost_usd` de la fila ya abierta.
   */
  async reserveCall(input: ReserveCallInput): Promise<SpendOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx);

        if (this.ceilingUsd === null) {
          return this.reject('ceiling_not_configured', {
            turnId: input.turnId,
            detail: 'AI_SPEND_CEILING_USD no está configurado; no se asume ningún techo por defecto',
          });
        }

        const spent = await this.spentTotal(tx);
        if (spent.add(input.estimate).gt(this.ceilingUsd)) {
          return this.reject('ceiling', {
            turnId: input.turnId,
            detail: `gastado ${spent.toString()} + estimado ${input.estimate.toString()} supera el techo ${this.ceilingUsd.toString()}`,
          });
        }

        await tx.aiTurn.update({
          where: { id: input.turnId },
          data: { costUsd: { increment: input.estimate } },
        });

        return { ok: true as const, turnId: input.turnId };
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  }

  /**
   * Liquida el intento: `cost_usd += real − estimado` y suma los tokens.
   *
   * **Si `usage` vino indefinido o el intento falló (`actual === null`), la
   * reserva se queda como está.** Es la dirección fail-closed: cobrar cero por
   * no saber es lo único que rompería el techo (tarea 4.4).
   */
  async settleCall(input: SettleCallInput): Promise<void> {
    if (input.actual === null) {
      this.log.warn(
        `turno ${input.turnId}: sin uso real reportado (o intento fallido); ` +
          `la reserva ${input.estimate.toString()} USD se mantiene sin tocar`,
      );
      return;
    }

    const delta = input.actual.costUsd.minus(input.estimate);
    await this.prisma.aiTurn.update({
      where: { id: input.turnId },
      data: {
        costUsd: { increment: delta },
        inputTokens: { increment: input.actual.inputTokens },
        outputTokens: { increment: input.actual.outputTokens },
      },
    });
  }

  /**
   * Cierra el turno: `status`, latencia, eslabón que respondió, iteraciones y
   * error concatenado. Devuelve el `cost_usd` que quedó en la fila — el turno
   * de IA lo necesita para el `AiTurnResult` (FR-D12) sin volver a leerla, y el
   * cobro NO cambia acá: un `FAILED` conserva su reserva (SC-D14: la plata se
   * gastó aunque el turno no haya llegado a aplicarse).
   */
  async closeTurn(input: CloseTurnInput): Promise<string> {
    const row = await this.prisma.aiTurn.update({
      where: { id: input.turnId },
      data: {
        status: input.status,
        provider: input.provider,
        model: input.model,
        fallbackFired: input.fallbackFired,
        fallbackFrom: input.fallbackFrom,
        latencyMs: input.latencyMs,
        iterations: input.iterations,
        errorMessage: input.errorMessage,
      },
      select: { costUsd: true },
    });
    return row.costUsd.toString();
  }

  /**
   * Estimación del turno (tarea 4.3): `ceil(chars/3)` de instrucciones,
   * mensajes y `JSON.stringify(tools)`, por el precio de entrada, más
   * `MAX_OUTPUT_TOKENS` por el precio de salida, más la cota de tokens de cada
   * imagen por la cantidad de iteraciones esperadas (D9.2). Es una COTA
   * SUPERIOR: si la heurística se queda corta, la liquidación puede pasar el
   * techo por centavos y el turno siguiente ya se rechaza.
   *
   * La imagen se cuenta aparte del texto porque el proveedor la cobra aparte: no
   * viaja como caracteres en `messages`. Y se cuenta POR ITERACIÓN porque el
   * bucle la reenvía entera en cada vuelta.
   */
  estimateCost(
    model: AiModelView,
    payload: EstimatePayload,
    maxOutputTokens: number = MAX_OUTPUT_TOKENS,
  ): Prisma.Decimal {
    const chars =
      (payload.instructions?.length ?? 0) +
      payload.messages.reduce((sum, message) => sum + message.content.length, 0) +
      JSON.stringify(payload.tools).length;

    // `chars` es una CUENTA, no un monto: entra a la aritmética de dinero ya
    // convertido a `Decimal`. Los tokens de imagen también: son cuentas enteras.
    const textTokens = new Prisma.Decimal(chars).div(3).ceil();
    const imageTokens = this.imageTokensOf(payload);
    const inputTokens = textTokens.add(imageTokens);
    const inputCost = inputTokens.mul(model.price.inputPerMtokUsd).div(MTOK);
    const outputCost = new Prisma.Decimal(maxOutputTokens)
      .mul(model.price.outputPerMtokUsd)
      .div(MTOK);

    return inputCost.add(outputCost);
  }

  /**
   * La cota de tokens de las imágenes del turno, ya multiplicada por las
   * iteraciones esperadas (D9.2). Sin imágenes devuelve cero, así que un turno
   * de texto estima exactamente lo mismo que antes.
   */
  private imageTokensOf(payload: EstimatePayload): Prisma.Decimal {
    const images = payload.images ?? [];
    if (images.length === 0) return new Prisma.Decimal(0);

    const onePass = images.reduce((sum, image) => sum + imageTokenBound(image.width, image.height), 0);
    // `Math.max(1, ...)` y no el valor crudo: una reserva de cero iteraciones
    // sería una reserva de cero tokens para una imagen que igual se va a mandar.
    const iterations = Math.max(1, Math.floor(payload.imageIterations ?? 1));
    return new Prisma.Decimal(onePass * iterations);
  }

  /**
   * Costo real desde el `usage` reportado. Devuelve `null` cuando el proveedor
   * no reportó NINGÚN token: `undefined` en el SDK significa "no sé", y eso
   * deja la reserva en pie en vez de liquidarla en cero.
   */
  actualCostOf(
    model: AiModelView,
    usage: { readonly inputTokens: number | null; readonly outputTokens: number | null },
  ): ActualCallCost | null {
    if (usage.inputTokens === null && usage.outputTokens === null) return null;

    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const costUsd = new Prisma.Decimal(inputTokens)
      .mul(model.price.inputPerMtokUsd)
      .div(MTOK)
      .add(new Prisma.Decimal(outputTokens).mul(model.price.outputPerMtokUsd).div(MTOK));

    return { costUsd, inputTokens, outputTokens };
  }

  /**
   * Vista de gasto (D6): el gasto del entorno y el del proyecto contra el
   * techo, más los últimos 10 turnos del proyecto (tarea 7.1).
   *
   * `ceilingUsd: null` NO es "sin techo", es "techo ausente" — con él todo
   * turno se rechaza.
   *
   * `recentTurns` sale de `ai_turns` con el mismo join a `diagrams` que usa el
   * agregado del proyecto, ordenado por `createdAt` descendente. `reserved` es
   * `status === 'PENDING'`: la fila que todavía es una reserva sin liquidar
   * (design D3). No se filtra por estado — el turno rechazado que nunca se
   * escribió no existe, y el fallido sí gastó su reserva.
   */
  async spendView(projectId: string): Promise<AiSpendView> {
    const [environment, project, turns] = await Promise.all([
      this.prisma.aiTurn.aggregate({ _sum: { costUsd: true } }),
      this.prisma.aiTurn.aggregate({
        where: { diagram: { projectId } },
        _sum: { costUsd: true },
      }),
      this.prisma.aiTurn.findMany({
        where: { diagram: { projectId } },
        orderBy: { createdAt: 'desc' },
        take: RECENT_TURNS_LIMIT,
        select: {
          id: true,
          createdAt: true,
          costUsd: true,
          status: true,
          provider: true,
          model: true,
          diagram: { select: { name: true } },
        },
      }),
    ]);

    return {
      ceilingUsd: this.ceilingUsd === null ? null : this.ceilingUsd.toString(),
      environmentSpentUsd: (environment._sum.costUsd ?? new Prisma.Decimal(0)).toString(),
      projectSpentUsd: (project._sum.costUsd ?? new Prisma.Decimal(0)).toString(),
      recentTurns: turns.map(
        (turn): AiSpendTurnView => ({
          turnId: turn.id,
          createdAt: turn.createdAt.toISOString(),
          diagramName: turn.diagram.name,
          model: { provider: turn.provider as AiModelRef['provider'], model: turn.model },
          costUsd: turn.costUsd.toString(),
          status: turn.status,
          reserved: turn.status === 'PENDING',
        }),
      ),
    };
  }

  /**
   * El advisory lock, SIEMPRE dentro de una transacción (`xact`).
   *
   * Va con `$executeRaw` y no con `$queryRaw` a propósito: `pg_advisory_xact_lock`
   * devuelve `void`, y Prisma no puede deserializar una columna de tipo `void`
   * (`Failed to deserialize column of type 'void'`), mientras que el camino de
   * ejecución solo cuenta filas y no deserializa nada.
   */
  private async lock(tx: Prisma.TransactionClient): Promise<void> {
    // El cast a `bigint` no es cosmético: sin él el driver adapter manda el
    // parámetro como `text` y Postgres no resuelve la sobrecarga.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AI_SPEND_LOCK_KEY}::bigint)`;
  }

  /** Suma de `cost_usd` de TODOS los estados (PO-3): sin filtrar por `status`. */
  private async spentTotal(tx: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const aggregate = await tx.aiTurn.aggregate({ _sum: { costUsd: true } });
    return aggregate._sum.costUsd ?? new Prisma.Decimal(0);
  }

  /**
   * Límite de ritmo por usuario Y por proyecto (FR-D15b.4, D4).
   *
   * Tres cuentas sobre la MISMA tabla, sin pisarse:
   *
   * | `kind` | Filas contadas | Límite |
   * |---|---|---|
   * | `transcription` | solo `prompt_text = '[transcription]'` | `transcriptionsPerHour` |
   * | `turn` + `IMAGE` | imagen, excluyendo transcripciones | `imageTurnsPerHour` |
   * | `turn` + texto/voz | no-imagen, excluyendo transcripciones | `turnsPerHour` |
   *
   * El filtro de `turn` excluye las transcripciones a propósito: sin eso, cada
   * dictado consumiría una cuota de turno de texto y el techo declarado mentiría.
   * `retryAt` es la fila más vieja de la ventana más una hora.
   */
  private async checkRateLimit(
    tx: Prisma.TransactionClient,
    subject: RateLimitSubject,
    windowStart: Date,
  ): Promise<SpendRejection | null> {
    const limit = this.limitFor(subject);
    const filter = this.rateFilterFor(subject);

    const userWhere = { ...filter, userId: subject.userId, createdAt: { gte: windowStart } };
    const userCount = await tx.aiTurn.count({ where: userWhere });
    if (userCount >= limit) {
      return this.reject('rate_limited', {
        turnId: null,
        detail: `usuario ${subject.userId}: ${userCount} ${subject.kind}(s) en la última hora (límite ${limit})`,
        retryAt: await this.retryAtFor(tx, userWhere, windowStart),
      });
    }

    const projectWhere = {
      ...filter,
      diagram: { projectId: subject.projectId },
      createdAt: { gte: windowStart },
    };
    const projectCount = await tx.aiTurn.count({ where: projectWhere });
    if (projectCount >= limit) {
      return this.reject('rate_limited', {
        turnId: null,
        detail: `proyecto ${subject.projectId}: ${projectCount} ${subject.kind}(s) en la última hora (límite ${limit})`,
        retryAt: await this.retryAtFor(tx, projectWhere, windowStart),
      });
    }

    return null;
  }

  /** El tope que aplica a esta reserva. */
  private limitFor(subject: RateLimitSubject): number {
    if (subject.kind === 'transcription') return this.transcriptionsPerHour;
    return subject.inputMode === 'IMAGE' ? this.imageTurnsPerHour : this.turnsPerHour;
  }

  /** El filtro de filas que cuenta esta reserva. */
  private rateFilterFor(subject: RateLimitSubject): Prisma.AiTurnWhereInput {
    if (subject.kind === 'transcription') return { promptText: TRANSCRIPTION_PROMPT_TEXT };
    const isImage = subject.inputMode === 'IMAGE';
    return {
      ...(isImage ? { inputMode: 'IMAGE' as const } : { inputMode: { not: 'IMAGE' as const } }),
      ...NOT_TRANSCRIPTION_WHERE,
    };
  }

  private async retryAtFor(
    tx: Prisma.TransactionClient,
    where: Prisma.AiTurnWhereInput,
    windowStart: Date,
  ): Promise<Date> {
    const oldest = await tx.aiTurn.findFirst({
      where,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return new Date((oldest?.createdAt ?? windowStart).getTime() + RATE_WINDOW_MS);
  }

  /**
   * Registra el rechazo y lo devuelve. Un rechazo NO gasta nada, así que no
   * escribe ninguna fila; el `Logger.warn` es la única huella (design D3).
   */
  private reject(
    reason: SpendRejection['reason'],
    detail: { turnId: string | null; detail: string; retryAt?: Date },
  ): SpendRejection {
    const suffix = reason === 'rate_limited' ? `; reintentar después de ${detail.retryAt?.toISOString()}` : '';
    this.log.warn(
      `turno rechazado (${reason})${detail.turnId === null ? '' : ` para ${detail.turnId}`}: ${detail.detail}${suffix}`,
    );
    if (reason === 'rate_limited') {
      return { ok: false, reason, retryAt: detail.retryAt ?? new Date() };
    }
    return { ok: false, reason };
  }

  /** `AI_SPEND_CEILING_USD` como `Decimal`. Ausente o mal formado → `null` (fail-closed). */
  private readCeiling(config: ConfigService): Prisma.Decimal | null {
    const raw = config.get<string>('AI_SPEND_CEILING_USD');
    if (raw === undefined || raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    try {
      const value = new Prisma.Decimal(trimmed);
      if (!value.isFinite() || value.isNegative()) {
        this.log.error(
          `AI_SPEND_CEILING_USD inválido: "${trimmed}"; se trata como ausente y todo turno se rechaza`,
        );
        return null;
      }
      return value;
    } catch {
      this.log.error(
        `AI_SPEND_CEILING_USD inválido: "${trimmed}"; se trata como ausente y todo turno se rechaza`,
      );
      return null;
    }
  }

  /** Límite de ritmo entero. Ausente o mal formado → default, con `Logger.error` (design D5). */
  private readLimit(config: ConfigService, key: string, fallback: number): number {
    const raw = config.get<string>(key);
    if (raw === undefined || raw === null) return fallback;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return fallback;

    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.log.error(`${key} inválido: "${trimmed}"; se usa el default ${fallback}`);
      return fallback;
    }
    return parsed;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiModelView, AiSpendView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import type { AiInputMode, AiTurnStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_OUTPUT_TOKENS } from './providers/ai-sdk.provider';
import type { LlmMessage, ToolDefinition } from './providers/llm-provider.interface';

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

/** Ventana del límite de ritmo: la última hora (FR-D15b.4). */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Un millón de tokens, como `Decimal`: nunca como `number` en la aritmética. */
const MTOK = new Prisma.Decimal(1_000_000);

/** Igual que el pipeline de operaciones: una transacción patológica muere con `P2028`, ruidosa y acotada. */
const TRANSACTION_TIMEOUT_MS = 5_000;
const TRANSACTION_MAX_WAIT_MS = 2_000;

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

/** Lo que hay que estimar para reservar: instrucciones, mensajes y herramientas. */
export interface EstimatePayload {
  readonly instructions?: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDefinition[];
}

export interface OpenTurnInput {
  readonly projectId: string;
  readonly diagramId: string;
  readonly userId: string;
  readonly inputMode: AiInputMode;
  readonly promptText: string | null;
  readonly model: AiModelView;
  readonly estimate: Prisma.Decimal;
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

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ceilingUsd = this.readCeiling(config);
    this.turnsPerHour = this.readLimit(config, 'AI_RATE_LIMIT_TURNS_PER_HOUR', 20);
    this.imageTurnsPerHour = this.readLimit(config, 'AI_RATE_LIMIT_IMAGE_TURNS_PER_HOUR', 5);
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

        const limited = await this.checkRateLimit(tx, input, windowStart);
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

  /** Cierra el turno: `status`, latencia, eslabón que respondió y error concatenado. */
  async closeTurn(input: CloseTurnInput): Promise<void> {
    await this.prisma.aiTurn.update({
      where: { id: input.turnId },
      data: {
        status: input.status,
        provider: input.provider,
        model: input.model,
        fallbackFired: input.fallbackFired,
        fallbackFrom: input.fallbackFrom,
        latencyMs: input.latencyMs,
        errorMessage: input.errorMessage,
      },
    });
  }

  /**
   * Estimación del turno (tarea 4.3): `ceil(chars/3)` de instrucciones,
   * mensajes y `JSON.stringify(tools)`, por el precio de entrada, más
   * `MAX_OUTPUT_TOKENS` por el precio de salida. Es una COTA SUPERIOR: si la
   * heurística se queda corta, la liquidación puede pasar el techo por centavos
   * y el turno siguiente ya se rechaza.
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
    // convertido a `Decimal`.
    const inputTokens = new Prisma.Decimal(chars).div(3).ceil();
    const inputCost = inputTokens.mul(model.price.inputPerMtokUsd).div(MTOK);
    const outputCost = new Prisma.Decimal(maxOutputTokens)
      .mul(model.price.outputPerMtokUsd)
      .div(MTOK);

    return inputCost.add(outputCost);
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
   * techo. `ceilingUsd: null` NO es "sin techo", es "techo ausente" — con él
   * todo turno se rechaza.
   *
   * `recentTurns` queda vacío: los últimos 10 turnos del proyecto son la tarea
   * 7.1 (`Fase 7`, fuera de alcance de esta corrida).
   */
  async spendView(projectId: string): Promise<AiSpendView> {
    const [environment, project] = await Promise.all([
      this.prisma.aiTurn.aggregate({ _sum: { costUsd: true } }),
      this.prisma.aiTurn.aggregate({
        where: { diagram: { projectId } },
        _sum: { costUsd: true },
      }),
    ]);

    return {
      ceilingUsd: this.ceilingUsd === null ? null : this.ceilingUsd.toString(),
      environmentSpentUsd: (environment._sum.costUsd ?? new Prisma.Decimal(0)).toString(),
      projectSpentUsd: (project._sum.costUsd ?? new Prisma.Decimal(0)).toString(),
      recentTurns: [],
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
   * Límite de ritmo por usuario Y por proyecto, con las de imagen contadas
   * aparte (FR-D15b.4). `retryAt` es la fila más vieja de la ventana más una
   * hora: el momento en que ese turno sale de la ventana.
   */
  private async checkRateLimit(
    tx: Prisma.TransactionClient,
    input: OpenTurnInput,
    windowStart: Date,
  ): Promise<SpendRejection | null> {
    const isImage = input.inputMode === 'IMAGE';
    const limit = isImage ? this.imageTurnsPerHour : this.turnsPerHour;
    const modeFilter = isImage ? { inputMode: 'IMAGE' as const } : { inputMode: { not: 'IMAGE' as const } };

    const userWhere = { ...modeFilter, userId: input.userId, createdAt: { gte: windowStart } };
    const userCount = await tx.aiTurn.count({ where: userWhere });
    if (userCount >= limit) {
      return this.reject('rate_limited', {
        turnId: null,
        detail: `usuario ${input.userId}: ${userCount} turno(s) en la última hora (límite ${limit})`,
        retryAt: await this.retryAtFor(tx, userWhere, windowStart),
      });
    }

    const projectWhere = {
      ...modeFilter,
      diagram: { projectId: input.projectId },
      createdAt: { gte: windowStart },
    };
    const projectCount = await tx.aiTurn.count({ where: projectWhere });
    if (projectCount >= limit) {
      return this.reject('rate_limited', {
        turnId: null,
        detail: `proyecto ${input.projectId}: ${projectCount} turno(s) en la última hora (límite ${limit})`,
        retryAt: await this.retryAtFor(tx, projectWhere, windowStart),
      });
    }

    return null;
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

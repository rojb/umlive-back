import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_ERROR, type AiCapabilities, type AiHealthCheckResult, type AiHealthCheckStep, type AiHealthCheckStepKind, type AiModelRef, type AiModelView, type AiProviderId } from '@umlive/contracts';
import type { AiInputMode, AiTurnStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AiConfigService } from './ai-config.service';
import { AiSpendService, type SpendRejection } from './ai-spend.service';
import { AI_ENV, type AiEnvironment, type ProviderCredential } from './providers/llm-provider.factory';
import type {
  LlmCompletion,
  LlmImage,
  LlmMessage,
  ToolDefinition,
} from './providers/llm-provider.interface';

/**
 * Orquestación del turno (design D4, FR-D08): resuelve la configuración, arma
 * la cadena de reserva, y reserva y liquida CADA intento por separado.
 *
 * ── La cadena ───────────────────────────────────────────────────────────────
 *
 * Primario + hasta 3 eslabones, sin repetidos, y **filtrada antes de abrir el
 * turno**: se saltean los eslabones no disponibles (el proveedor no se puede
 * construir) y los que no declaran la capacidad que el turno exige (`vision`
 * si hay imágenes, `toolCalling` si hay herramientas). Se filtra en
 * `startTurn` y no en el bucle para no reservar por un eslabón que jamás se
 * va a llamar.
 *
 * ── Cualquier error pasa al siguiente eslabón… menos el abort ───────────────
 *
 * `APICallError`, timeout o error de red del intento activo mueven al
 * siguiente (FR-D08). La ÚNICA excepción es el `abortSignal` del llamador:
 * ahí se corta todo, porque cancelar no es fallar (design D4).
 *
 * ── Con qué clave se paga cada intento (tarea 7.10) ─────────────────────────
 *
 * `startTurn` pide a `AiConfigService` la credencial de CADA proveedor
 * (`resolveForCall`) y la congela en el turno. De ahí en más es la misma que
 * usa el filtro de la cadena y la que recibe `createProvider`: la clave propia
 * del proyecto para el proveedor del proyecto, la del entorno para el resto.
 * `unreadable` —clave BYO que no se pudo descifrar— no construye adaptador, así
 * que ese proveedor queda fuera de la cadena en vez de gastar la clave del
 * entorno. Nada de esto toca `process.env`.
 *
 * Cada intento fallido deja su reserva EN PIE (`settleCall` con `actual:
 * null`): no se cobra cero por ignorancia, y el turno queda cerrado con el
 * error concatenado en `error_message` más un `Logger.warn`.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Cadena de reserva
 * ante error, timeout o rate limit". `apps/api` es CommonJS: sin `.js`.
 */

/** Primario + 3 eslabones de reserva como máximo (design D4). */
const MAX_CHAIN_LINKS = 4;

/**
 * Iteraciones que la reserva de un turno de imagen tiene que cubrir (D9.2).
 *
 * El bucle de imagen se corta a 6 iteraciones (D5) y **cada una reenvía la
 * imagen entera**. La reserva se hace UNA vez, antes de la primera iteración, así
 * que contar la imagen una sola vez la deja corta por un factor de 6. Este
 * número es el tope de D5, no una medición: la reserva es una cota superior y la
 * liquidación la ajusta después con el uso real.
 */
export const IMAGE_EXPECTED_ITERATIONS = 6;

/**
 * `prompt_text` de toda fila del chequeo de salud (tarea 7.7). Es también el
 * contenido mínimo del llamado: el saludable no gasta en un prompt largo.
 */
export const HEALTH_CHECK_PROMPT = '[health-check]';

/**
 * PNG de 1×1 transparente (68 bytes). Una imagen de verdad, mínima, para el
 * paso de visión de FR-D13 — no es una clave ni una credencial, es un fixture
 * de bytes constante.
 */
const HEALTH_CHECK_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Herramienta mínima del paso `toolCalling`: se declara, no se ejecuta (design D2). */
const HEALTH_CHECK_TOOL: ToolDefinition = {
  name: 'health_check_echo',
  description: 'Devuelve el mismo texto que recibe; existe solo para probar la conexión (FR-D13).',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Texto a devolver tal cual.' } },
    required: ['text'],
  },
};

export interface AiCallRequest {
  readonly projectId: string;
  readonly diagramId: string;
  readonly userId: string;
  readonly inputMode: AiInputMode;
  readonly promptText: string | null;
  /** Instrucciones de sistema del turno; se estiman junto con los mensajes. */
  readonly instructions?: string;
  readonly messages: readonly LlmMessage[];
  readonly images?: readonly LlmImage[];
  readonly tools?: readonly ToolDefinition[];
  /** Del llamador: corta TODA la cadena, a diferencia de un error de proveedor. */
  readonly abortSignal?: AbortSignal;
}

/** El turno ya abierto (reserva hecha), listo para `call`. */
export interface AiTurn {
  readonly turnId: string;
  readonly primary: AiModelView;
  readonly chain: readonly AiModelView[];
  readonly requiresVision: boolean;
  readonly requiresToolCalling: boolean;
  readonly startedAt: number;
  /**
   * Credencial por proveedor, CONGELADA al abrir el turno (tarea 7.10): la
   * misma que filtró la cadena es la que construye el adaptador en `call`. Sin
   * esto, borrar o romper la clave del proyecto entre `startTurn` y `call`
   * haría que el llamado cayera a la clave del entorno sin que nadie lo decida.
   */
  readonly credentialFor: (provider: AiProviderId) => ProviderCredential;
  /**
   * ¿La reserva que abrió el turno ya fue consumida por un llamado?
   *
   * Mutable a propósito, y el único campo que lo es. `openTurn` reserva UN
   * llamado (`expectedIterations` da 1 fuera de imagen), pero `call` se invoca
   * una vez POR ITERACIÓN del bucle de herramientas, que en texto llega a 25.
   * Sin esta marca, de la segunda iteración en adelante `settleCall` restaba
   * una estimación que nadie había reservado y `cost_usd` se iba abajo de cero:
   * `ck_ai_cost_nonneg` abortaba el UPDATE, el turno entero se reportaba como
   * «intento del modelo falló» y no se aplicaba ningún cambio.
   */
  openingReserveUsed: boolean;
}

export type StartTurnResult =
  | { readonly ok: true; readonly turn: AiTurn }
  | SpendRejection
  | { readonly ok: false; readonly reason: 'no_capable_provider' };

export type AiCallResult =
  | {
      readonly ok: true;
      readonly completion: LlmCompletion;
      readonly model: AiModelView;
      readonly fallbackFired: boolean;
      readonly fallbackFrom: string | null;
    }
  | {
      readonly ok: false;
      readonly aborted: boolean;
      readonly errorMessage: string;
      readonly fallbackFired: boolean;
      readonly fallbackFrom: string | null;
    };

/**
 * Cómo se cierra la fila `ai_turns` de un turno. `status` sale del LLAMADOR y no
 * se deriva del `AiCallResult`: desde `ai-text-instructions` el estado final del
 * turno lo decide la APLICACIÓN (un `REJECTED` por lock ajeno tuvo un último
 * llamado exitoso), no el último `call`. El chequeo de salud sigue derivándolo
 * del resultado, que para él es lo mismo.
 */
export interface CloseCallInput {
  readonly status: AiTurnStatus;
  /** Iteraciones de tool-calling que consumió el turno (SC-D14). */
  readonly iterations: number;
  readonly errorMessage: string | null;
}

/**
 * Lo que `finishTurn` deja para armar el resultado del turno: el costo que ya
 * quedó escrito y el eslabón que respondió (FR-D12, D10).
 */
export interface AiTurnClose {
  readonly costUsd: string;
  readonly provider: string;
  readonly model: string;
  readonly fallbackFired: boolean;
  readonly fallbackFrom: string | null;
}

/**
 * Resultado de un chequeo de salud (FR-D13) tal como lo necesita el
 * controlador. Tres formas, porque tres cosas distintas puede hacer la ruta:
 *
 * - `result`: hay `AiHealthCheckResult` — sea éxito, sea un fallo del proveedor
 *   (`200` con `ok:false`). La ruta NO necesita traducir nada.
 * - `needs_diagram`: el proyecto no tiene diagramas y `ai_turns.diagram_id` es
 *   `NOT NULL`; la ruta responde `409 ai_health_check_needs_diagram` SIN abrir
 *   ningún turno ni tocar la red (design D8).
 * - `rejected`: el libro de gasto dijo que no (techo, sin techo, límite de
 *   ritmo). La ruta reusa `spendRejectionToHttp`.
 */
export type HealthCheckOutcome =
  | { readonly kind: 'result'; readonly result: AiHealthCheckResult }
  | { readonly kind: 'needs_diagram' }
  | { readonly kind: 'rejected'; readonly rejection: SpendRejection };

/** Lo que devuelve un paso del chequeo: o su resultado, o un rechazo del libro. */
type HealthCheckStepOutcome =
  | { readonly kind: 'step'; readonly step: AiHealthCheckStep }
  | { readonly kind: 'rejected'; readonly rejection: SpendRejection };

@Injectable()
export class AiCallService {
  private readonly log = new Logger(AiCallService.name);

  constructor(
    @Inject(AI_ENV) private readonly env: AiEnvironment,
    private readonly config: AiConfigService,
    private readonly spend: AiSpendService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Abre el turno: resuelve la configuración fresca, arma la cadena y reserva
   * el primer intento. Sin reserva no hay red (FR-D15b.2).
   */
  async startTurn(request: AiCallRequest): Promise<StartTurnResult> {
    const resolved = await this.config.resolveForCall(request.projectId);
    const images = request.images ?? [];
    const requiresVision = images.length > 0;
    const requiresToolCalling = (request.tools?.length ?? 0) > 0;

    const chain = this.buildChain(
      resolved.view.primary,
      resolved.view.fallbackChain,
      requiresVision,
      requiresToolCalling,
      resolved.credentialFor,
      // La primera imagen es la del turno (`files: 1` en multer, D1): con ella se
      // descartan los eslabones cuyo límite declarado no entra.
      images[0],
    );
    if (chain.length === 0) {
      this.log.warn(
        `proyecto ${request.projectId}: ningún eslabón del catálogo declara ` +
          `vision=${requiresVision} toolCalling=${requiresToolCalling}`,
      );
      return { ok: false, reason: 'no_capable_provider' };
    }

    const primary = chain[0]!;
    const opened = await this.spend.openTurn({
      projectId: request.projectId,
      diagramId: request.diagramId,
      userId: request.userId,
      inputMode: request.inputMode,
      promptText: request.promptText,
      model: primary,
      // La reserva del turno cubre TODAS las iteraciones esperadas del bucle, que
      // en un turno de imagen reenvían la imagen entera (D9.2).
      estimate: this.spend.estimateCost(primary, this.payloadOf(request, this.expectedIterations(requiresVision))),
    });
    if (!opened.ok) return opened;

    return {
      ok: true,
      turn: {
        turnId: opened.turnId,
        primary,
        chain,
        requiresVision,
        requiresToolCalling,
        startedAt: Date.now(),
        credentialFor: resolved.credentialFor,
        openingReserveUsed: false,
      },
    };
  }

  /**
   * Recorre la cadena. El PRIMER llamado del turno ya está reservado por
   * `startTurn`; todo llamado posterior —otro eslabón de la cadena, u otra
   * iteración del bucle de herramientas— se reserva con `reserveCall` ANTES
   * de llamar.
   *
   * La distinción entre «intento» e «iteración» es lo que estaba roto: este
   * método se invoca una vez por ITERACIÓN, no una vez por turno, así que
   * reservar solo en el fallback dejaba sin cubrir las iteraciones 2..25.
   */
  async call(turn: AiTurn, request: AiCallRequest): Promise<AiCallResult> {
    // La reserva de apertura la reclama el primer llamado del turno y nadie
    // más. Se marca acá, antes de cualquier salida temprana: si se marcara
    // recién al liquidar, un primer llamado que se saltea todos los eslabones
    // dejaría la marca en falso y la iteración siguiente volvería a gastar
    // una reserva que ya no existe.
    const coveredByOpeningReserve = !turn.openingReserveUsed;
    turn.openingReserveUsed = true;
    // Cada intento de la cadena se estima por UN llamado: la reserva del primer
    // intento ya cubría las iteraciones esperadas del bucle (D9.2), y acá se
    // liquida el uso real de este llamado.
    const payload = this.payloadOf(request, 1);
    const images = request.images ?? [];
    const tools = request.tools ?? [];
    let fallbackFrom: string | null = null;
    let lastError: string | null = null;

    for (const model of turn.chain) {
      const ref = `${model.provider}:${model.model}`;
      // La credencial del proveedor va EXPLÍCITA al adaptador (tarea 7.10): la
      // del proyecto si este proyecto guardó la suya, la del entorno si no. Es
      // la MISMA credencial congelada que filtró la cadena, así que un
      // `unreadable` no puede llegar hasta acá.
      const provider = this.env.createProvider(model, turn.credentialFor(model.provider));
      if (provider === null) {
        // No debería pasar: `buildChain` ya filtró por disponibilidad y por
        // credencial con este mismo resolutor. Si pasa, se saltea igual y se
        // registra (mismo camino fail-closed).
        this.log.warn(`turno ${turn.turnId}: eslabón ${ref} no disponible; se saltea`);
        fallbackFrom ??= ref;
        continue;
      }

      const estimate = this.spend.estimateCost(model, payload);
      if (fallbackFrom !== null || !coveredByOpeningReserve) {
        const reserved = await this.spend.reserveCall({ turnId: turn.turnId, estimate });
        if (!reserved.ok) {
          lastError = `reserva rechazada antes de ${ref} (${reserved.reason})`;
          this.log.warn(`turno ${turn.turnId}: ${lastError}`);
          break;
        }
      }

      try {
        const completion =
          images.length > 0
            ? await provider.completeWithImages(request.messages, images, tools, {
                abortSignal: request.abortSignal,
              })
            : await provider.complete(request.messages, tools, {
                abortSignal: request.abortSignal,
              });

        await this.spend.settleCall({
          turnId: turn.turnId,
          estimate,
          actual: this.spend.actualCostOf(model, completion.usage),
        });

        return {
          ok: true,
          completion,
          model,
          fallbackFired: fallbackFrom !== null,
          fallbackFrom,
        };
      } catch (error) {
        const message = describeError(error);

        if (request.abortSignal?.aborted === true) {
          // Cortar no es fallar: la reserva queda en pie y no se prueba el
          // siguiente eslabón.
          await this.spend.settleCall({ turnId: turn.turnId, estimate, actual: null });
          return {
            ok: false,
            aborted: true,
            errorMessage: message,
            fallbackFired: fallbackFrom !== null,
            fallbackFrom,
          };
        }

        lastError = message;
        fallbackFrom ??= ref;
        this.log.warn(`turno ${turn.turnId}: intento ${ref} falló (${message}); se pasa al siguiente eslabón`);
        // La reserva del intento fallido se queda como está (fail-closed).
        await this.spend.settleCall({ turnId: turn.turnId, estimate, actual: null });
      }
    }

    return {
      ok: false,
      aborted: false,
      errorMessage: lastError ?? 'ningún eslabón de la cadena pudo completar el turno',
      fallbackFired: fallbackFrom !== null,
      fallbackFrom,
    };
  }

  /**
   * Cierra la fila con el eslabón que respondió (o con el error), la latencia
   * real, el estado final y las iteraciones. Devuelve el costo YA escrito, que
   * el turno de IA necesita para su `AiTurnResult`.
   */
  async finishTurn(turn: AiTurn, result: AiCallResult, close: CloseCallInput): Promise<AiTurnClose> {
    const latencyMs = Date.now() - turn.startedAt;
    // El eslabón que respondió si lo hubo; el primario si el turno no llegó a
    // que ninguno contestara.
    const provider = result.ok ? result.model.provider : turn.primary.provider;
    const model = result.ok ? result.model.model : turn.primary.model;

    const costUsd = await this.spend.closeTurn({
      turnId: turn.turnId,
      status: close.status,
      provider,
      model,
      fallbackFired: result.fallbackFired,
      fallbackFrom: result.fallbackFrom,
      latencyMs,
      iterations: close.iterations,
      errorMessage: close.errorMessage,
    });

    return { costUsd, provider, model, fallbackFired: result.fallbackFired, fallbackFrom: result.fallbackFrom };
  }

  /**
   * Chequeo de salud (FR-D13, tarea 7.6): un llamado REAL y mínimo contra el
   * primario resuelto, con el libro de gasto completo por delante.
   *
   * ── Por qué son uno a tres turnos y no "un turno con tres llamados" ────────
   *
   * El libro de gasto abre un turno por intento con `openTurn` y cobra cada
   * intento ADICIONAL con `reserveCall`. La API de este servicio reserva por
   * turno, no por llamado: no existe un camino que emita tres llamados dentro
   * de un mismo turno sin inventar una reserva paralela. Así que cada paso
   * (`text`, `toolCalling`, `vision`) corre como un turno COMPLETO —
   * `startTurn` / `call` / `finishTurn`—, con su propia reserva, su propia
   * liquidación y su propia cuota de límite de ritmo. Todas las filas quedan
   * en el mismo diagrama con `prompt_text = '[health-check]'`.
   *
   * ── Lo que NO gasta ───────────────────────────────────────────────────────
   *
   * Sin diagramas responde `needs_diagram` antes de tocar nada. Un primario no
   * disponible (sin clave, `byo_key_unreadable`, fuera de catálogo) corta ANTES
   * de abrir el turno: cero reservas y cero pedidos de red. Un rechazo del libro
   * (techo, sin techo, ritmo) corta y se devuelve tal cual para que la ruta lo
   * traduzca — el `429`/`409` de 7.8.
   */
  async healthCheck(projectId: string, userId: string): Promise<HealthCheckOutcome> {
    // `ai_turns.diagram_id` es NOT NULL: sin diagrama no existe turno posible,
    // así que la falta de diagrama se comprueba PRIMERO. Es la precondición más
    // barata (una consulta local) y la que ningún proveedor puede arreglar.
    const diagram = await this.prisma.diagram.findFirst({
      where: { projectId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (diagram === null) return { kind: 'needs_diagram' };

    const resolved = await this.config.resolve(projectId);
    const primary: AiModelRef = { provider: resolved.primary.provider, model: resolved.primary.model };
    const providerView = resolved.providers.find((candidate) => candidate.id === primary.provider);

    if (providerView === undefined || !providerView.available) {
      const reason = providerView?.unavailableReason ?? AI_ERROR.MODEL_NOT_IN_CATALOG;
      this.log.warn(`chequeo de salud del proyecto ${projectId}: ${primary.provider} no disponible (${reason})`);
      return {
        kind: 'result',
        result: { ok: false, primary, steps: [], failureReason: reason },
      };
    }

    const steps: AiHealthCheckStep[] = [];
    for (const kind of this.healthCheckPlan(resolved.primary)) {
      const outcome = await this.runHealthCheckStep(kind, projectId, diagram.id, userId);
      if (outcome.kind === 'rejected') return { kind: 'rejected', rejection: outcome.rejection };

      steps.push(outcome.step);
      if (!outcome.step.ok) {
        return {
          kind: 'result',
          result: { ok: false, primary, steps, failureReason: outcome.step.detail },
        };
      }
    }

    return { kind: 'result', result: { ok: true, primary, steps, failureReason: null } };
  }

  /**
   * Los pasos del chequeo: texto siempre; herramienta y visión solo si el
   * modelo las declara (FR-D13). Se decide con el booleano de capacidades, la
   * misma regla que usa `buildChain` (nota [3.2] de `tasks.md`).
   */
  private healthCheckPlan(model: AiModelView): readonly AiHealthCheckStepKind[] {
    const plan: AiHealthCheckStepKind[] = ['text'];
    if (model.capabilities.toolCalling) plan.push('toolCalling');
    if (model.capabilities.vision) plan.push('vision');
    return plan;
  }

  /** Un paso = un turno completo. El paso de visión entra como `IMAGE`. */
  private async runHealthCheckStep(
    kind: AiHealthCheckStepKind,
    projectId: string,
    diagramId: string,
    userId: string,
  ): Promise<HealthCheckStepOutcome> {
    const request: AiCallRequest = {
      projectId,
      diagramId,
      userId,
      inputMode: (kind === 'vision' ? 'IMAGE' : 'TEXT') as AiInputMode,
      promptText: HEALTH_CHECK_PROMPT,
      messages: [{ role: 'user', content: HEALTH_CHECK_PROMPT }],
      ...(kind === 'vision'
        ? { images: [{ mediaType: 'image/png', data: HEALTH_CHECK_IMAGE_BASE64, width: 1, height: 1 }] }
        : {}),
      ...(kind === 'toolCalling' ? { tools: [HEALTH_CHECK_TOOL] } : {}),
    };

    const started = await this.startTurn(request);
    if (!started.ok) {
      if (started.reason === 'no_capable_provider') {
        return { kind: 'step', step: { kind, ok: false, detail: 'no_capable_provider' } };
      }
      return { kind: 'rejected', rejection: started };
    }

    const result = await this.call(started.turn, request);
    // Un paso es un turno de un solo llamado: `iterations = 1`. El estado sigue
    // saliendo del resultado, que para un único llamado es lo mismo que decide
    // el llamador del turno real.
    await this.finishTurn(started.turn, result, {
      status: result.ok ? 'APPLIED' : result.aborted ? 'CANCELLED' : 'FAILED',
      iterations: 1,
      errorMessage: result.ok ? null : result.errorMessage,
    });

    return {
      kind: 'step',
      step: { kind, ok: result.ok, detail: result.ok ? null : result.errorMessage },
    };
  }

  /**
   * Primario + eslabones, sin repetidos, hasta 4, salteando lo no disponible
   * (incluida una credencial `unreadable`) y lo que no declara la capacidad
   * exigida.
   *
   * Nota [3.2] de `tasks.md` (respuesta de D9.3): el filtro usa el booleano
   * `capabilities.vision`, no `maxImageBytes === null`. Los límites SIN DECLARAR
   * (`null`) no excluyen a nadie —si excluyeran, ningún modelo del catálogo
   * podría recibir una imagen y FR-D13 quedaría inejercitable—; lo que excluye
   * es violar un límite DECLARADO, porque ese eslabón devolvería un error del
   * proveedor DESPUÉS de haber reservado el gasto. `openai-compatible` declara
   * los dos límites o ninguno (D9.1), así que ahí no hay medio camino.
   */
  private buildChain(
    primary: AiModelView,
    fallbackChain: readonly AiModelView[],
    requiresVision: boolean,
    requiresToolCalling: boolean,
    credentialFor: (provider: AiProviderId) => ProviderCredential,
    image: LlmImage | undefined,
  ): AiModelView[] {
    const seen = new Set<string>();
    const chain: AiModelView[] = [];

    for (const model of [primary, ...fallbackChain]) {
      const ref = `${model.provider}:${model.model}`;
      if (seen.has(ref)) continue;
      seen.add(ref);

      if (requiresVision && !model.capabilities.vision) continue;
      if (requiresToolCalling && !model.capabilities.toolCalling) continue;
      // D9.3: la imagen descarta los eslabones que la rechazarían por bytes o por
      // dimensión. Se saltea acá y no en el bucle para no reservar por un eslabón
      // que jamás se va a llamar.
      if (image !== undefined && !imageFitsDeclaredLimits(image, model.capabilities)) {
        this.log.warn(
          `eslabón ${ref} descartado: la imagen de ${image.width}×${image.height} no entra en ` +
            `sus límites declarados (${describeLimits(model.capabilities)})`,
        );
        continue;
      }
      // El filtro mira la CREDENCIAL, no solo la disponibilidad del entorno: un
      // proyecto con clave BYO ilegible para `anthropic` no puede terminar
      // llamando a Anthropic con `ANTHROPIC_API_KEY` (parada dura de 7.10).
      if (this.env.createProvider(model, credentialFor(model.provider)) === null) continue;

      chain.push(model);
      if (chain.length === MAX_CHAIN_LINKS) break;
    }

    return chain;
  }

  /**
   * Iteraciones esperadas del bucle de este turno: las de imagen, que reenvían
   * la imagen, o una sola para un turno de texto (D9.2).
   */
  private expectedIterations(requiresVision: boolean): number {
    return requiresVision ? IMAGE_EXPECTED_ITERATIONS : 1;
  }

  private payloadOf(request: AiCallRequest, imageIterations: number) {
    return {
      // `instructions` NO entra en la cuenta: desde que el prompt de sistema
      // viaja como mensaje `system` dentro de `messages` —que es lo que de
      // verdad se envía—, sumarlo de los dos lados estimaría dos veces el
      // mismo texto, y esa estimación es la reserva que se toma por iteración.
      messages: request.messages,
      tools: request.tools ?? [],
      images: request.images ?? [],
      imageIterations,
    };
  }
}

/**
 * ¿La imagen entra en los límites DECLARADOS del eslabón? (D9.3.)
 *
 * Los dos límites son independientes: alcanza con violar uno para que el
 * eslabón devuelva un `400` sobre un pedido ya reservado. Un límite `null` está
 * sin declarar y no rechaza nada (nota [3.2]).
 */
function imageFitsDeclaredLimits(image: LlmImage, capabilities: AiCapabilities): boolean {
  if (capabilities.maxImageBytes !== null && imageBytes(image) > capabilities.maxImageBytes) return false;
  if (capabilities.maxImageDimension !== null && Math.max(image.width, image.height) > capabilities.maxImageDimension) {
    return false;
  }
  return true;
}

/** Bytes reales de la imagen; en base64 se calculan sin asignar un `Buffer` nuevo. */
function imageBytes(image: LlmImage): number {
  if (typeof image.data !== 'string') return image.data.byteLength;
  const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((image.data.length * 3) / 4) - padding);
}

/** Los límites declarados, para el `Logger.warn` del eslabón descartado. */
function describeLimits(capabilities: AiCapabilities): string {
  const bytes = capabilities.maxImageBytes === null ? 'sin declarar' : `${capabilities.maxImageBytes} B`;
  const dimension = capabilities.maxImageDimension === null ? 'sin declarar' : `${capabilities.maxImageDimension} px`;
  return `bytes ${bytes}, dimensión ${dimension}`;
}

/** Error legible para `error_message` y el log: nunca se guarda un objeto crudo. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

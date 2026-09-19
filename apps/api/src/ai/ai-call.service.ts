import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_ERROR, type AiHealthCheckResult, type AiHealthCheckStep, type AiHealthCheckStepKind, type AiModelRef, type AiModelView, type AiProviderId } from '@umlive/contracts';
import type { AiInputMode } from '../generated/prisma/enums';
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
    const requiresVision = (request.images?.length ?? 0) > 0;
    const requiresToolCalling = (request.tools?.length ?? 0) > 0;

    const chain = this.buildChain(
      resolved.view.primary,
      resolved.view.fallbackChain,
      requiresVision,
      requiresToolCalling,
      resolved.credentialFor,
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
      estimate: this.spend.estimateCost(primary, this.payloadOf(request)),
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
      },
    };
  }

  /**
   * Recorre la cadena. El primer intento ya está reservado por `startTurn`;
   * del segundo en adelante se reserva con `reserveCall` ANTES de llamar.
   */
  async call(turn: AiTurn, request: AiCallRequest): Promise<AiCallResult> {
    const payload = this.payloadOf(request);
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
      if (fallbackFrom !== null) {
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

  /** Cierra la fila con el eslabón que respondió (o con el error) y la latencia real. */
  async finishTurn(turn: AiTurn, result: AiCallResult): Promise<void> {
    const latencyMs = Date.now() - turn.startedAt;

    if (result.ok) {
      await this.spend.closeTurn({
        turnId: turn.turnId,
        status: 'APPLIED',
        provider: result.model.provider,
        model: result.model.model,
        fallbackFired: result.fallbackFired,
        fallbackFrom: result.fallbackFrom,
        latencyMs,
        errorMessage: null,
      });
      return;
    }

    await this.spend.closeTurn({
      turnId: turn.turnId,
      // Un abort es cancelación, no fallo del proveedor.
      status: result.aborted ? 'CANCELLED' : 'FAILED',
      provider: turn.primary.provider,
      model: turn.primary.model,
      fallbackFired: result.fallbackFired,
      fallbackFrom: result.fallbackFrom,
      latencyMs,
      errorMessage: result.errorMessage,
    });
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
        ? { images: [{ mediaType: 'image/png', data: HEALTH_CHECK_IMAGE_BASE64 }] }
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
    await this.finishTurn(started.turn, result);

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
   * Nota de tensión declarada (nota [3.2] de `tasks.md`): el filtro usa el
   * booleano `capabilities.vision`, no `maxImageBytes === null`. Los límites de
   * tamaño de imagen con `null` los hace cumplir `ai-image-input`; si acá se
   * tratara `null` como "sin visión", ningún modelo del catálogo sería capaz
   * de recibir una imagen y FR-D13 quedaría inejercitable.
   */
  private buildChain(
    primary: AiModelView,
    fallbackChain: readonly AiModelView[],
    requiresVision: boolean,
    requiresToolCalling: boolean,
    credentialFor: (provider: AiProviderId) => ProviderCredential,
  ): AiModelView[] {
    const seen = new Set<string>();
    const chain: AiModelView[] = [];

    for (const model of [primary, ...fallbackChain]) {
      const ref = `${model.provider}:${model.model}`;
      if (seen.has(ref)) continue;
      seen.add(ref);

      if (requiresVision && !model.capabilities.vision) continue;
      if (requiresToolCalling && !model.capabilities.toolCalling) continue;
      // El filtro mira la CREDENCIAL, no solo la disponibilidad del entorno: un
      // proyecto con clave BYO ilegible para `anthropic` no puede terminar
      // llamando a Anthropic con `ANTHROPIC_API_KEY` (parada dura de 7.10).
      if (this.env.createProvider(model, credentialFor(model.provider)) === null) continue;

      chain.push(model);
      if (chain.length === MAX_CHAIN_LINKS) break;
    }

    return chain;
  }

  private payloadOf(request: AiCallRequest) {
    return {
      instructions: request.instructions,
      messages: request.messages,
      tools: request.tools ?? [],
    };
  }
}

/** Error legible para `error_message` y el log: nunca se guarda un objeto crudo. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

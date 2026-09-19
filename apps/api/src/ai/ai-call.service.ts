import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AiModelView } from '@umlive/contracts';
import type { AiInputMode } from '../generated/prisma/enums';
import { AiConfigService } from './ai-config.service';
import { AiSpendService, type SpendRejection } from './ai-spend.service';
import { AI_ENV, type AiEnvironment } from './providers/llm-provider.factory';
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
 * Cada intento fallido deja su reserva EN PIE (`settleCall` con `actual:
 * null`): no se cobra cero por ignorancia, y el turno queda cerrado con el
 * error concatenado en `error_message` más un `Logger.warn`.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Cadena de reserva
 * ante error, timeout o rate limit". `apps/api` es CommonJS: sin `.js`.
 */

/** Primario + 3 eslabones de reserva como máximo (design D4). */
const MAX_CHAIN_LINKS = 4;

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

@Injectable()
export class AiCallService {
  private readonly log = new Logger(AiCallService.name);

  constructor(
    @Inject(AI_ENV) private readonly env: AiEnvironment,
    private readonly config: AiConfigService,
    private readonly spend: AiSpendService,
  ) {}

  /**
   * Abre el turno: resuelve la configuración fresca, arma la cadena y reserva
   * el primer intento. Sin reserva no hay red (FR-D15b.2).
   */
  async startTurn(request: AiCallRequest): Promise<StartTurnResult> {
    const resolved = await this.config.resolve(request.projectId);
    const requiresVision = (request.images?.length ?? 0) > 0;
    const requiresToolCalling = (request.tools?.length ?? 0) > 0;

    const chain = this.buildChain(
      resolved.primary,
      resolved.fallbackChain,
      requiresVision,
      requiresToolCalling,
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
      const provider = this.env.createProvider(model);
      if (provider === null) {
        // No debería pasar: `buildChain` ya filtró por disponibilidad. Si pasa,
        // se saltea igual y se registra (mismo camino fail-closed).
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
   * Primario + eslabones, sin repetidos, hasta 4, salteando lo no disponible y
   * lo que no declara la capacidad exigida.
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
  ): AiModelView[] {
    const seen = new Set<string>();
    const chain: AiModelView[] = [];

    for (const model of [primary, ...fallbackChain]) {
      const ref = `${model.provider}:${model.model}`;
      if (seen.has(ref)) continue;
      seen.add(ref);

      if (requiresVision && !model.capabilities.vision) continue;
      if (requiresToolCalling && !model.capabilities.toolCalling) continue;
      if (this.env.createProvider(model) === null) continue;

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

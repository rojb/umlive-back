import { Injectable, Logger } from '@nestjs/common';
import {
  absolutePositionOf,
  AI_TURN_ERROR,
  type AiImageConfirmResult,
  type AiImageMode,
  type AiImagePreview,
  type AiTurnResult,
  type AiTurnStatus,
  type AiTurnSummary,
  type AiUndoEligibility,
  type AiUndoIneligibleReason,
  type AiUndoResult,
  type DiagramContent,
  type LockHolder,
  type OperationCommitted,
  type OperationRejected,
} from '@umlive/contracts';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { CollaborationGateway } from '../collaboration/collaboration.gateway';
import { type LockFrozen, LocksService, type TrackedLockOutcome } from '../collaboration/locks.service';
import { OperationsService, type BatchOperation } from '../collaboration/operations.service';
import { Prisma } from '../generated/prisma/client';
import type { AiInputMode } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { DiagramContentService } from '../uml/diagram-content.service';
import { AiCallService, type AiCallResult, type AiTurn, type AiTurnClose } from './ai-call.service';
import { AiConfigService } from './ai-config.service';
import { AiPreviewStore, type PendingPreview, type PreviewCancelReason } from './ai-preview.store';
import { AiSpendService, type SpendRejection } from './ai-spend.service';
import { buildTools, TURN_LIMITS } from './ai-tools';
import type { AiConfirmTurnDto } from './dto/ai-confirm-turn.dto';
import type { AiImageTurnDto } from './dto/ai-image-turn.dto';
import type { AiTurnRequestDto } from './dto/ai-turn-request.dto';
import { readImageDimensions, sha256, sniffImageType, stripMetadata, type ImageType } from './image-input';
import { layoutImageItems } from './image-layout';
import type { UploadedImage } from './image-upload.filter';
import { excludeClosure, TurnPlan } from './ai-turn-plan';
import { buildSystemPrompt } from './ai-turn-prompt';
import type { LlmImage, LlmMessage, ToolDefinition } from './providers/llm-provider.interface';
import { batchOpId } from './turn-op-ids';

/**
 * El turno del asistente (M6, rebanada 2/4 — `ai-text-instructions`).
 *
 * ── Tres fases, y solo la última escribe ───────────────────────────────────
 *
 * 1. **Guardas antes de gastar** (D9, SC-C20), en este orden: `ai.use` (guard
 *    HTTP) → **congelado** → turno en curso → capacidad `toolCalling` →
 *    `startTurn` (límite de ritmo y reserva) → proveedor. Un diagrama congelado
 *    responde `423` **sin llamar al proveedor**: la instrucción #2 de #2308
 *    existe porque el orden contrario gasta dinero en un diagrama que no se
 *    puede escribir.
 * 2. **El bucle de herramientas** (`≤ 25`) corre sin transacción y sin locks.
 *    Cada llamada se valida contra un plan en memoria (`TurnPlan`) y el
 *    resultado es una lista de operaciones con referencias locales.
 * 3. **La aplicación**: `acquireAllTracked` (la unión, todo o nada) →
 *    `applyBatch` (UNA transacción, UN bump de versión) → difusión →
 *    liberación de lo que el turno tomó, DESPUÉS del `COMMIT`.
 *
 * ── Lo que este archivo NO hace ─────────────────────────────────────────────
 *
 * No emite antes del `COMMIT`: `emitCommitted` se llama con lo que devolvió
 * `applyBatch`, nunca con el plan (INV-3, SC-D09). Difundir una operación que
 * después revierte deja a las otras ventanas mostrando un diagrama que no
 * existe, y no hay a quién pedirle que lo revierta.
 *
 * No soltar los locks que el usuario ya tenía: `acquireAllTracked` devuelve
 * `taken` y esto suelta `taken`, no la unión pedida (instrucción #3). Y no
 * suelta con causa `'deleted'` lo que no se borró.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/**
 * Plazo total del turno (D9). Existe porque el `requestTimeout` por defecto del
 * `http.Server` de Node ≥18 son 300 s: 25 iteraciones lentas lo pasarían y la
 * conexión se cortaría SIN estado final. A los 120 s el turno termina `FAILED`,
 * con su costo ya registrado.
 */
export const AI_TURN_DEADLINE_MS = 120_000;

/**
 * Color neutro del `LockHolder` de un usuario que no está conectado a la sala
 * (D10). El color real es el de presencia por sala; este es el respaldo, y es
 * fijo a propósito: un color derivado por hash sugeriría una identidad que
 * nadie ve en el roster.
 */
const NEUTRAL_LOCK_COLOR = '#6B7280';

/**
 * Los cinco tipos con los que un turno PUEDE ser deshacible (PO-1, D5).
 * Cualquier otro en su log lo vuelve no elegible: `diagram_operations` guarda
 * el estado POSTERIOR, así que la inversa de una edición no se reconstruye sin
 * migrar.
 */
const CREATE_ONLY_TYPES = new Set<string>([
  'element.create',
  'feature.create',
  'parameter.add',
  'literal.add',
  'relationship.create',
]);

/** Los motivos con los que la guarda del deshacer bloquea el lote (D5). */
const UNDO_INELIGIBLE_REASONS = new Set<AiUndoIneligibleReason>([
  'not_create_only',
  'touched_later',
  'already_undone',
  'not_owner',
  'nothing_applied',
]);

/** Lo que puede devolver `POST .../ai/turns`. */
export type AiTurnOutcome =
  | { readonly kind: 'result'; readonly result: AiTurnResult }
  | { readonly kind: 'frozen' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'tool_calling_unavailable' }
  | { readonly kind: 'spend_rejected'; readonly rejection: SpendRejection };

/** Lo que puede devolver `POST .../ai/turns/:turnId/undo`. */
export type AiUndoOutcome =
  | { readonly kind: 'result'; readonly result: AiUndoResult }
  | { readonly kind: 'frozen' }
  | { readonly kind: 'locked'; readonly rejection: OperationRejected };

/**
 * Lo que puede devolver `POST .../ai/turns/image` (D4). El orden de las guardas
 * que produce cada variante es el de `planImageTurn`, y no es casual: lo que
 * responde un rechazo sin tocar la red no puede depender de nada que cueste.
 */
export type AiImagePlanOutcome =
  | { readonly kind: 'preview'; readonly preview: AiImagePreview }
  | { readonly kind: 'failed'; readonly result: AiTurnResult }
  | { readonly kind: 'frozen' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'vision_unavailable' }
  | { readonly kind: 'create_requires_empty' }
  | { readonly kind: 'image_rejected'; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly kind: 'spend_rejected'; readonly rejection: SpendRejection };

/** Lo que puede devolver `POST .../ai/turns/:turnId/confirm` (D8). */
export type AiImageConfirmOutcome =
  | { readonly kind: 'result'; readonly result: AiImageConfirmResult }
  | { readonly kind: 'frozen' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'locked'; readonly rejection: OperationRejected }
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'item_unknown' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_owner' };

/** Lo que puede devolver `POST .../ai/turns/:turnId/discard`. */
export type AiImageDiscardOutcome = { readonly kind: 'discarded' } | { readonly kind: 'not_owner' };

/** Todo lo que hace falta para correr, aplicar y cerrar un turno. */
interface TurnContext {
  readonly turn: AiTurn;
  readonly projectId: string;
  readonly diagramId: string;
  readonly user: CurrentUserPayload;
  readonly dto: AiTurnRequestDto;
  readonly instructions: string;
  readonly plan: TurnPlan;
  /** Las herramientas visibles del modo (D5): 7 en texto/voz, 5 en imagen. */
  readonly tools: readonly ToolDefinition[];
  /** Tope de iteraciones del modo (D5). */
  readonly maxIterations: number;
  /** La cancelación del cliente, sola: distingue CANCELLED de FAILED por plazo. */
  readonly cancelSignal: AbortSignal;
  /** `cancelSignal` combinada con el plazo de 120 s. */
  readonly effective: AbortSignal;
  modelText: string;
}

/** Lo que dejó el bucle de herramientas. */
interface ToolLoopResult {
  /** `APPLIED` acá significa «el modelo cerró el turno»; la aplicación decide el resto. */
  readonly status: AiTurnStatus;
  readonly iterations: number;
  readonly modelText: string;
  readonly lastResult: AiCallResult | null;
  readonly closedByModel: boolean;
}

/** Lo que decidió la fase de aplicación. */
interface ApplyResult {
  readonly status: AiTurnStatus;
  readonly committed: OperationCommitted[];
  readonly rejection: OperationRejected | null;
}

/** Lo que dejó el bucle de imagen (D5, PO-C). */
interface ImageLoopResult {
  readonly iterations: number;
  readonly modelText: string;
  readonly lastResult: AiCallResult | null;
  /** El modelo cerró con texto, sin pedir más herramientas. */
  readonly closedByModel: boolean;
  /** El proveedor no pudo responder (o se agotó el plazo): no hay vista previa. */
  readonly failed: boolean;
}

/**
 * El cierre de una fila más las iteraciones que quedaron registradas. `AiTurnClose`
 * no las trae y el `AiTurnResult` de la confirmación sí las necesita.
 */
interface ClosedTurn extends AiTurnClose {
  readonly iterations: number;
}

/**
 * Instrucción por defecto de un turno de imagen sin texto del usuario (D4).
 * La foto ya es la instrucción; esto solo fija el modo del pedido.
 */
const DEFAULT_IMAGE_PROMPT = 'Modelá en el diagrama lo que muestra esta foto.';

@Injectable()
export class AiTurnService {
  private readonly log = new Logger(AiTurnService.name);

  /**
   * Un turno a la vez por (usuario, diagrama) (D9). `Set` en memoria porque hay
   * UNA sola instancia de backend (PRD §12 Q5). Sin esto, dos turnos del mismo
   * usuario confundirían la foto de D1: el segundo tomaría como «ya tenidos»
   * los locks del primero y al terminar soltaría los del otro.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly calls: AiCallService,
    private readonly config: AiConfigService,
    private readonly content: DiagramContentService,
    private readonly locks: LocksService,
    private readonly operations: OperationsService,
    private readonly gateway: CollaborationGateway,
    private readonly spend: AiSpendService,
    private readonly previews: AiPreviewStore,
    private readonly prisma: PrismaService,
  ) {
    // El cierre de las vistas previas que nadie confirma (TTL o reemplazo) es de
    // este servicio: el store no conoce el libro de gasto. La fila se cierra
    // `CANCELLED` y el costo queda donde ya estaba (nunca se borra una fila).
    this.previews.registerCancel((turnId, reason) => {
      void this.closeCancelled(turnId, reason).catch((error: unknown) => {
        this.log.error(`no se pudo cancelar la vista previa ${turnId}: ${String(error)}`);
      });
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Turno
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Guardas, bucle y aplicación. `cancelSignal` la produce el CONTROLADOR desde
   * el cierre de la conexión (`res.on('close')`): es el único objeto que ve el
   * transporte HTTP. El plazo lo agrega este método.
   */
  async runTurn(
    projectId: string,
    diagramId: string,
    user: CurrentUserPayload,
    dto: AiTurnRequestDto,
    cancelSignal: AbortSignal,
  ): Promise<AiTurnOutcome> {
    // 1. Congelado ANTES de todo lo que cuesta (instrucción #2, SC-C20). Se lee
    //    la FILA, no la compuerta en memoria: la transacción de aplicación usa
    //    el mismo valor de la misma tabla, así que lo que decide acá es lo que
    //    decide allá. Un diagrama congelado no escribe fila en `ai_turns` y no
    //    llama a ningún proveedor.
    const snapshot = await this.content.getDiagramContent(diagramId);
    if (snapshot.diagram.lockState !== 'UNLOCKED') return { kind: 'frozen' };

    // 2. Un turno a la vez por (usuario, diagrama).
    const key = `${user.id}:${diagramId}`;
    if (this.inFlight.has(key)) return { kind: 'in_progress' };

    this.inFlight.add(key);
    try {
      return await this.runGuardedTurn(projectId, diagramId, user, dto, cancelSignal, snapshot);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async runGuardedTurn(
    projectId: string,
    diagramId: string,
    user: CurrentUserPayload,
    dto: AiTurnRequestDto,
    cancelSignal: AbortSignal,
    snapshot: DiagramContent,
  ): Promise<AiTurnOutcome> {
    const plan = new TurnPlan(snapshot, { opLimit: TURN_LIMITS[dto.inputMode as AiInputMode].ops });
    const tools = buildTools(dto.inputMode as AiInputMode);
    const instructions = buildSystemPrompt(snapshot, { tools });
    // El prompt de sistema viaja como MENSAJE `system`, que es el único camino
    // por el que llega al modelo: `AiCallService` pasa `request.messages` al
    // adaptador y nada más, y `AiSdkProvider` arma su bloque de instrucciones
    // recorriendo esos mensajes (`ai-sdk.provider.ts`, `case 'system'`).
    //
    // Hasta acá `instructions` se calculaba, se pagaba en la estimación de
    // costo y NO SE ENVIABA: el campo `AiCallRequest.instructions` solo entra a
    // `payloadOf`, que es contabilidad. El modelo nunca vio el estado del
    // diagrama; lo único que le llegaba era la descripción de los parámetros de
    // las herramientas, que menciona los alias sin enumerarlos. De ahí salían
    // las dos respuestas que parecían de otro problema: primero «no tengo
    // ninguna foto del diagrama a la vista» (cuando esa descripción decía «la
    // foto del diagrama») y después «no veo ningún alias para Cita», con el
    // modelo adivinando si el atributo se llamaba `fecha`, `fechaCita` o
    // `fechaHora` — exactamente lo que hace quien no recibió la lista.
    const messages: LlmMessage[] = [
      { role: 'system', content: instructions },
      { role: 'user', content: dto.prompt },
    ];
    // Deja rastro de que el estado viajó y de cuánto: un turno que vuelva a
    // decir «no veo el diagrama» se resuelve mirando esta línea en vez de
    // deduciéndolo del texto del modelo.
    this.log.log(
      `turno de texto: prompt de sistema adjunto (${instructions.length} caracteres, ` +
        `${snapshot.elements.length} elementos, ${snapshot.features.length} miembros)`,
    );
    // El plazo y la cancelación del cliente, combinados (D9). Mantener las dos
    // señales SEPARADAS es lo que permite distinguir al final una cancelación
    // del usuario (CANCELLED) del plazo agotado (FAILED).
    const effective = AbortSignal.any([cancelSignal, AbortSignal.timeout(AI_TURN_DEADLINE_MS)]);

    // 3. Capacidad `toolCalling` + ritmo + reserva. `startTurn` devuelve
    //    `no_capable_provider` ANTES de abrir la fila (ningún eslabón declara
    //    `toolCalling`), y un rechazo del libro de gasto tampoco escribe nada.
    const started = await this.calls.startTurn({
      projectId,
      diagramId,
      userId: user.id,
      inputMode: dto.inputMode as AiInputMode,
      promptText: dto.prompt,
      instructions,
      messages,
      tools,
      abortSignal: effective,
    });
    if (!started.ok) {
      if (started.reason === 'no_capable_provider') return { kind: 'tool_calling_unavailable' };
      return { kind: 'spend_rejected', rejection: started };
    }

    const context: TurnContext = {
      turn: started.turn,
      projectId,
      diagramId,
      user,
      dto,
      instructions,
      plan,
      tools,
      maxIterations: TURN_LIMITS[dto.inputMode as AiInputMode].iterations,
      cancelSignal,
      effective,
      modelText: '',
    };

    // 4. El bucle, sin transacción y sin locks.
    const loop = await this.runToolLoop(context, messages);
    context.modelText = loop.modelText;

    // 5. Cierre y, con el plan cerrado, aplicación.
    return { kind: 'result', result: await this.finishTurn(context, loop) };
  }

  /**
   * El bucle de herramientas (D3, SC-D14): hasta 25 `call`, ninguna escritura,
   * ningún lock. Cada llamada a herramienta pasa por el validador propio del
   * plan y su resultado vuelve al modelo como resultado de herramienta —
   * incluidos los errores, que NUNCA se convierten en operación (FR-D05,
   * SC-D03).
   */
  private async runToolLoop(context: TurnContext, messages: LlmMessage[]): Promise<ToolLoopResult> {
    let iterations = 0;
    let modelText = '';
    let lastResult: AiCallResult | null = null;
    let closedByModel = false;

    const fails = (status: AiTurnStatus): ToolLoopResult => ({
      status,
      iterations,
      modelText,
      lastResult,
      closedByModel: false,
    });

    while (iterations < context.maxIterations) {
      // Última chance ANTES del llamado: un cancel que llegó mientras se
      // procesaban los resultados no necesita gastar una iteración más.
      if (context.effective.aborted) return fails(this.abortStatus(context.cancelSignal));

      iterations += 1;
      const result = await this.calls.call(context.turn, {
        projectId: context.projectId,
        diagramId: context.diagramId,
        userId: context.user.id,
        inputMode: context.dto.inputMode as AiInputMode,
        promptText: context.dto.prompt,
        instructions: context.instructions,
        messages,
        tools: context.tools,
        abortSignal: context.effective,
      });
      lastResult = result;

      if (!result.ok) {
        // `aborted` es la cancelación del cliente o el plazo; cualquier otra
        // cosa es la cadena entera sin poder responder (FAILED). Un abort deja
        // la reserva en pie: la plata ya se gastó (SC-D14).
        return fails(result.aborted ? this.abortStatus(context.cancelSignal) : 'FAILED');
      }

      modelText = result.completion.text;
      if (result.completion.toolCalls.length === 0) {
        closedByModel = true;
        break;
      }

      // El eco `opaque` (la thought signature de Gemini) viaja TAL CUAL dentro
      // de las llamadas de esta respuesta: el bucle no lo interpreta, solo lo
      // reenvía al proveedor en la iteración siguiente (D8).
      messages.push({
        role: 'assistant',
        content: result.completion.text,
        text: result.completion.text,
        toolCalls: result.completion.toolCalls,
      });

      for (const toolCall of result.completion.toolCalls) {
        const outcome = context.plan.addToolCall(toolCall.toolName, toolCall.input);
        // `notApplied` solo guarda `{tool, reason}` (contrato FR-D25), así que
        // el valor que el modelo realmente mandó se perdía: el resumen decía
        // «add_attribute: unknown_alias» y no había forma de saber si fue un
        // `e:0`, un `Cita` o un alias fuera de rango. Sin esto, el próximo
        // fallo se diagnostica adivinando.
        if (!outcome.ok) {
          this.log.warn(
            `turno de texto: ${toolCall.toolName} rechazada (${outcome.error}) con input ${JSON.stringify(toolCall.input)}`,
          );
        }
        messages.push({
          role: 'tool',
          content: outcome.result,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          output: outcome.result,
        });
      }
    }

    // Salir del `while` sin `closedByModel` es el tope agotado: el modelo seguía
    // pidiendo herramientas en la última iteración permitida (SC-D14).
    return closedByModel
      ? { status: 'APPLIED', iterations, modelText, lastResult, closedByModel: true }
      : fails('FAILED');
  }

  /**
   * Cierra el turno (tarea 5.6): decide el estado final, aplica el plan si el
   * modelo lo cerró, escribe `status` + `iterations` en `ai_turns` y arma el
   * `AiTurnResult`.
   */
  private async finishTurn(context: TurnContext, loop: ToolLoopResult): Promise<AiTurnResult> {
    let status = loop.status;
    let rejection: OperationRejected | null = null;
    let errorMessage: string | null = null;

    if (loop.closedByModel) {
      const applied = await this.applyPlan(context);
      if (applied === null) {
        // Se abortó ANTES de tomar el primer lock: nada se escribió, así que la
        // cancelación todavía manda (D9).
        status = this.abortStatus(context.cancelSignal);
        errorMessage = status === 'CANCELLED'
          ? 'El turno se canceló a pedido del usuario.'
          : 'El turno superó el plazo sin llegar a aplicar su plan.';
      } else {
        status = applied.status;
        rejection = applied.rejection;
        errorMessage = rejection === null ? null : rejection.message;
      }
    } else if (status === 'CANCELLED') {
      errorMessage = 'El turno se canceló a pedido del usuario.';
    } else {
      errorMessage = loop.lastResult !== null && !loop.lastResult.ok
        ? loop.lastResult.errorMessage
        : `El modelo no cerró el turno en ${context.maxIterations} iteraciones.`;
    }

    // El cierre REAL, con el estado final: este archivo es el único que sabe si
    // el turno terminó APLICADO o RECHAZADO (el último llamado pudo haber
    // respondido perfecto). El libro de gasto no cobra acá: un FAILED conserva
    // su reserva.
    const closeResult: AiCallResult = loop.lastResult ?? {
      ok: false,
      aborted: true,
      errorMessage: errorMessage ?? 'el turno terminó antes del primer llamado',
      fallbackFired: false,
      fallbackFrom: null,
    };
    const close = await this.calls.finishTurn(context.turn, closeResult, {
      status,
      iterations: loop.iterations,
      errorMessage,
    });

    const undo = await this.undoEligibilityView(context.diagramId, context.turn.turnId, context.user.id);
    const summary: AiTurnSummary = {
      // El resumen lista lo APLICADO. Un REJECTED no aplicó nada, así que lista
      // vacío aunque el plan tuviera operaciones.
      applied: status === 'APPLIED' ? context.plan.applied() : [],
      notApplied: context.plan.notApplied,
      modelText: context.modelText,
    };

    return {
      turnId: context.turn.turnId,
      status,
      summary,
      ...(rejection === null ? {} : { rejection }),
      costUsd: close.costUsd,
      iterations: loop.iterations,
      provider: close.provider,
      model: close.model,
      fallbackFired: close.fallbackFired,
      fallbackFrom: close.fallbackFrom,
      undo,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Turno de imagen (M6, rebanada 3/4 — `ai-image-input`)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Planifica un turno de imagen (D4, D5, D8): guardas, bucle con la foto,
   * vista previa en memoria. **No toma ningún lock y no escribe ninguna fila de
   * `diagram_operations`** (SC-D18, PO-1).
   *
   * El ORDEN de las guardas es la parte que no se puede mover:
   *
   * | # | Guarda | Costo si falla |
   * |---|---|---|
   * | 1 | diagrama congelado (`423`) | cero: no se llama al proveedor |
   * | 2 | turno en curso (`409`) | cero |
   * | 3 | cadena con `vision` + `toolCalling` (`409`) | cero |
   * | 4 | imagen: tipo, estructura, límites (`415`/`422`) | cero: no hay fila |
   * | 5 | modo crear sobre diagrama no vacío (`409`) | cero: no hay fila |
   * | 6 | `startTurn` (ritmo + reserva) | acá ya se reserva |
   *
   * Un diagrama congelado tiene que costar CERO: por eso se lee la fila antes
   * que nada, y la cadena antes de `startTurn`. La comprobación de visión no
   * abre el turno (leería config, no reserva); `startTurn` la vuelve a hacer al
   * armar la cadena, ahora también filtrando por los límites de la imagen.
   */
  async planImageTurn(
    projectId: string,
    diagramId: string,
    user: CurrentUserPayload,
    dto: AiImageTurnDto,
    image: UploadedImage | undefined,
  ): Promise<AiImagePlanOutcome> {
    // 1. Congelado ANTES de todo lo que cuesta (D4): se lee la FILA, la misma
    //    que mira `applyBatch`, así que lo que decide acá es lo que decide allá.
    const snapshot = await this.content.getDiagramContent(diagramId);
    if (snapshot.diagram.lockState !== 'UNLOCKED') return { kind: 'frozen' };

    // 2. Un turno a la vez por (usuario, diagrama).
    const key = `${user.id}:${diagramId}`;
    if (this.inFlight.has(key)) return { kind: 'in_progress' };

    // Multer sin `storage` deja el archivo en memoria (D1); un pedido sin
    // archivo es un buffer vacío y cae más abajo en `415`, no en un `500`.
    const received = image?.buffer ?? Buffer.alloc(0);
    let payload: Buffer = received;

    this.inFlight.add(key);
    try {
      // 3. Cadena con visión y herramientas, sin abrir el turno (FR-D04, SC-D02).
      const chain = await this.visionChain(projectId);
      if (chain === null) return { kind: 'vision_unavailable' };

      // 4. D2: por CONTENIDO, nunca por el `Content-Type` que mandó el cliente.
      const type = sniffImageType(received);
      if (type === null) {
        return { kind: 'image_rejected', status: 415, body: { code: AI_TURN_ERROR.IMAGE_TYPE_UNSUPPORTED } };
      }
      const dimensions = readImageDimensions(received, type);
      if (!dimensions.ok) {
        return { kind: 'image_rejected', status: 422, body: { code: AI_TURN_ERROR.IMAGE_UNREADABLE } };
      }
      const { width, height } = dimensions.dimensions;
      const exceeds =
        (chain.maxImageDimension !== null && Math.max(width, height) > chain.maxImageDimension) ||
        (chain.maxImageBytes !== null && received.length > chain.maxImageBytes);
      if (exceeds) {
        return {
          kind: 'image_rejected',
          status: 422,
          body: {
            code: AI_TURN_ERROR.IMAGE_EXCEEDS_PROVIDER_LIMITS,
            maxImageBytes: chain.maxImageBytes,
            maxImageDimension: chain.maxImageDimension,
          },
        };
      }

      // 5. Modo (PO-4): crear solo sobre un diagrama vacío. La foto ya se tomó
      //    para el prompt, así que esto no cuesta una consulta extra.
      if (dto.mode === 'create' && snapshot.elements.length > 0) return { kind: 'create_requires_empty' };

      const imageSha = sha256(received);
      // Defensa en profundidad para un cliente que no recodifica (`curl`): los
      // metadatos se quitan y lo que viaja al proveedor es esta copia.
      payload = stripMetadata(received, type);
      const llmImage: LlmImage = { mediaType: mediaTypeOf(type), data: payload, width, height };

      const limits = TURN_LIMITS.IMAGE;
      const plan = new TurnPlan(snapshot, { image: true, opLimit: limits.ops });
      const tools = buildTools('IMAGE');
      const instructions = buildSystemPrompt(snapshot, { tools, imageMode: dto.mode });
      const promptText = dto.prompt ?? DEFAULT_IMAGE_PROMPT;
      // Mismo defecto que en el turno de texto: sin el mensaje `system` el
      // modelo no recibía ni las reglas de la foto ni el estado del diagrama.
      const messages: LlmMessage[] = [
        { role: 'system', content: instructions },
        { role: 'user', content: promptText },
      ];
      const effective = AbortSignal.timeout(AI_TURN_DEADLINE_MS);
      // La versión se lee ANTES que la foto (D8/PO-D): con una carrera el
      // resultado es un `409` de más, nunca uno de menos.
      const baseVersion = snapshot.diagram.currentVersion;

      // 6. Ritmo, reserva (con los tokens de imagen por iteración) y fila PENDING.
      const started = await this.calls.startTurn({
        projectId,
        diagramId,
        userId: user.id,
        inputMode: 'IMAGE',
        promptText,
        instructions,
        messages,
        images: [llmImage],
        tools,
        abortSignal: effective,
      });
      if (!started.ok) {
        // Sin eslabón que entre con la imagen: es el mismo rechazo de visión,
        // y sigue sin haber fila ni gasto.
        if (started.reason === 'no_capable_provider') return { kind: 'vision_unavailable' };
        return { kind: 'spend_rejected', rejection: started };
      }

      // Lo ÚNICO que se guarda de la imagen es su hash (privacidad), también
      // cuando el turno después falla: la auditoría no depende de que converja.
      await this.prisma.aiTurn.update({
        where: { id: started.turn.turnId },
        data: { imageSha256: imageSha },
      });

      const loop = await this.runImageLoop(started.turn, {
        projectId,
        diagramId,
        userId: user.id,
        promptText,
        instructions,
        messages,
        llmImage,
        tools,
        abortSignal: effective,
        plan,
        maxIterations: limits.iterations,
      });

      if (loop.failed) {
        return { kind: 'failed', result: await this.finishImageFailure(started.turn, loop, plan, diagramId, user) };
      }

      // Las posiciones normalizadas de la foto pasan al lienzo (D7).
      this.applyImageLayout(plan, snapshot, dto.mode, width, height);

      const items = plan.previewItems();
      // El turno queda PENDING con sus iteraciones ya registradas: la plata se
      // liquidó, la escritura todavía no pasó (PO-C, SC-D18).
      const closed = await this.calls.finishTurn(started.turn, closeResultOf(loop), {
        status: 'PENDING',
        iterations: loop.iterations,
        errorMessage: null,
      });
      const expiresAt = this.previews.put(started.turn.turnId, {
        userId: user.id,
        diagramId,
        mode: dto.mode,
        items,
        opsByItem: plan.opsByItem(),
        appliedByItem: plan.appliedByItem(),
        notApplied: plan.notApplied,
        modelText: loop.modelText,
        baseVersion,
        referencedIds: plan.referencedIds(),
      });

      return {
        kind: 'preview',
        preview: {
          turnId: started.turn.turnId,
          mode: dto.mode,
          expiresAt: new Date(expiresAt).toISOString(),
          items,
          notApplied: plan.notApplied,
          modelText: loop.modelText,
          costUsd: closed.costUsd,
          iterations: loop.iterations,
          // PO-C: agotar las 6 iteraciones NO es un turno fallido, es una vista
          // previa INCOMPLETA. La plata ya se gastó y nada se aplica sin
          // confirmación.
          truncated: !loop.closedByModel,
          provider: closed.provider,
          model: closed.model,
          fallbackFired: closed.fallbackFired,
          fallbackFrom: closed.fallbackFrom,
        },
      };
    } finally {
      this.inFlight.delete(key);
      // La imagen se libera ANTES de responder (D10): el buffer original y la
      // copia sin metadatos que se le mandó al proveedor.
      received.fill(0);
      if (payload !== received) payload.fill(0);
    }
  }

  /**
   * Confirma una vista previa (D8, PO-2, PO-D): el servidor recalcula el cierre,
   * revalida la precondición DENTRO del `FOR UPDATE` y aplica en UN lote.
   *
   * Nada de lo que manda el cliente es autoridad: `excluded` se valida como
   * enteros únicos dentro del rango del plan propio, el cierre se recalcula
   * sobre ese plan y la precondición de modo corre dentro de la transacción que
   * toma los locks.
   */
  async confirmImageTurn(
    diagramId: string,
    user: CurrentUserPayload,
    turnId: string,
    dto: AiConfirmTurnDto,
  ): Promise<AiImageConfirmOutcome> {
    const pending = this.previews.take(turnId);
    if (pending === null) return this.confirmWithoutPreview(diagramId, user.id, turnId);

    if (pending.diagramId !== diagramId || pending.userId !== user.id) {
      this.previews.restore(turnId);
      return { kind: 'not_owner' };
    }
    if (dto.excluded.some((index) => !Number.isInteger(index) || index < 0 || index >= pending.items.length)) {
      this.previews.restore(turnId);
      return { kind: 'item_unknown' };
    }

    // El cierre es del SERVIDOR (FR-D24): un cliente que manda solo la clase
    // excluida igual se lleva sus atributos y relaciones.
    const closure = excludeClosure(pending.items, dto.excluded);
    const excludedClosure = [...closure].sort((a, b) => a - b);
    const summary = {
      applied: pending.appliedByItem.filter((_, index) => !closure.has(index)).flat(),
      notApplied: [...pending.notApplied],
      modelText: pending.modelText,
    };

    // Todo excluido se trata como descartar (D6).
    if (closure.size >= pending.items.length) {
      this.previews.delete(turnId);
      return { kind: 'result', result: await this.cancelledConfirm(diagramId, turnId, user, summary, excludedClosure) };
    }

    const ops: BatchOperation[] = [];
    for (const [index, itemOps] of pending.opsByItem.entries()) {
      if (closure.has(index)) continue;
      for (const op of itemOps) ops.push({ type: op.type, payload: op.payload, produces: op.produces });
    }

    const key = `${user.id}:${diagramId}`;
    if (this.inFlight.has(key)) {
      this.previews.restore(turnId);
      return { kind: 'in_progress' };
    }

    this.inFlight.add(key);
    try {
      const acquired = this.locks.acquireAllTracked(
        diagramId,
        pending.referencedIds,
        this.holderFor(diagramId, user),
      );
      if (!acquired.ok) {
        // Nada se aplicó: la vista previa se conserva para reintentar dentro del
        // TTL (un `423` o un lock ajeno no invalidan el plan).
        this.previews.restore(turnId);
        if ('frozen' in acquired) return { kind: 'frozen' };
        return {
          kind: 'locked',
          rejection: {
            opId: batchOpId(turnId, 'apply', 0),
            diagramId,
            reason: 'ELEMENT_LOCKED',
            message: `${acquired.holder.displayName} está editando un elemento que este turno necesita. No se aplicó ninguna de sus operaciones.`,
            currentVersion: await this.operations.currentVersion(diagramId),
            holder: acquired.holder,
            lockedElementId: acquired.elementId,
          },
        };
      }

      const taken = acquired.taken;
      let deletedIds: string[] = [];
      try {
        const batch = await this.operations.applyBatch(diagramId, user.id, turnId, ops, {
          actorKind: 'AI',
          aiTurnId: turnId,
          opIdPrefix: 'apply',
          // La precondición de modo, DENTRO del `FOR UPDATE` (D8/PO-D): es el
          // mismo punto donde el deshacer reevalúa su elegibilidad.
          guard: (tx) => this.modePrecondition(tx, diagramId, pending),
        });

        if (batch.kind === 'blocked') {
          this.previews.delete(turnId);
          await this.closeRow(turnId, 'REJECTED', 'El diagrama cambió desde que se armó la vista previa.');
          return { kind: 'stale', reason: batch.reason };
        }
        if (batch.kind === 'rejected') {
          this.previews.delete(turnId);
          this.log.warn(`confirm del turno ${turnId} rechazado: ${batch.rejection.reason} — ${batch.rejection.message}`);
          return {
            kind: 'result',
            result: await this.rejectedConfirm(diagramId, turnId, user, batch.rejection, summary, excludedClosure),
          };
        }

        if (batch.kind === 'committed') {
          deletedIds = batch.deletedIds;
          // Después del COMMIT, nunca antes (INV-3).
          this.gateway.emitCommitted(diagramId, batch.committed);
        }
        this.previews.delete(turnId);
        return {
          kind: 'result',
          result: await this.appliedConfirm(diagramId, turnId, user, summary, excludedClosure, batch.kind === 'echo'),
        };
      } finally {
        if (deletedIds.length > 0) this.locks.releaseElements(diagramId, deletedIds, 'deleted');
        const deleted = new Set(deletedIds);
        for (const id of taken) {
          if (!deleted.has(id)) this.locks.release(diagramId, id, user.id, 'released');
        }
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Descarta una vista previa (D8): no aplica nada y cierra su fila `CANCELLED`.
   * Idempotente: descartar dos veces no es un error.
   */
  async discardImageTurn(diagramId: string, user: CurrentUserPayload, turnId: string): Promise<AiImageDiscardOutcome> {
    const row = await this.prisma.aiTurn.findUnique({
      where: { id: turnId },
      select: { userId: true, diagramId: true, status: true },
    });
    if (row !== null && row.diagramId === diagramId && row.userId !== user.id) return { kind: 'not_owner' };

    this.previews.delete(turnId);
    if (row !== null && row.status === 'PENDING') {
      await this.closeRow(turnId, 'CANCELLED', 'preview_discarded');
    }
    return { kind: 'discarded' };
  }

  /** El bucle de imagen (D5): ≤ 6 iteraciones, con la foto en CADA una. */
  private async runImageLoop(
    turn: AiTurn,
    args: {
      readonly projectId: string;
      readonly diagramId: string;
      readonly userId: string;
      readonly promptText: string;
      readonly instructions: string;
      readonly messages: LlmMessage[];
      readonly llmImage: LlmImage;
      readonly tools: readonly ToolDefinition[];
      readonly abortSignal: AbortSignal;
      readonly plan: TurnPlan;
      readonly maxIterations: number;
    },
  ): Promise<ImageLoopResult> {
    let iterations = 0;
    let modelText = '';
    let lastResult: AiCallResult | null = null;
    let closedByModel = false;
    let failed = false;

    while (iterations < args.maxIterations) {
      if (args.abortSignal.aborted) {
        failed = true;
        break;
      }

      iterations += 1;
      const result = await this.calls.call(turn, {
        projectId: args.projectId,
        diagramId: args.diagramId,
        userId: args.userId,
        inputMode: 'IMAGE',
        promptText: args.promptText,
        instructions: args.instructions,
        messages: args.messages,
        images: [args.llmImage],
        tools: args.tools,
        abortSignal: args.abortSignal,
      });
      lastResult = result;

      if (!result.ok) {
        failed = true;
        break;
      }

      modelText = result.completion.text;
      if (result.completion.toolCalls.length === 0) {
        // El turno de imagen no tenía NINGÚN diagnóstico, y este es el caso
        // que más lo necesita: una vista previa con «Ítems · 0» ya cobrada es
        // indistinguible de un fallo si no se sabe qué contestó el modelo.
        // Cerrar sin una sola llamada a herramienta es lo que pasa cuando el
        // modelo describe la foto en prosa en vez de dibujarla, o cuando no
        // la ve y lo dice con palabras — y las dos cosas se distinguen leyendo
        // su texto, que hasta ahora no quedaba en ninguna parte.
        // `finishReason` y los tokens ya viajaban en `LlmCompletion` y no se
        // registraban en ninguna parte. Son los que separan un texto vacío
        // por tope de salida (`length`) de uno que el modelo devolvió vacío a
        // propósito (`stop`) de uno que el adaptador perdió (`tool-calls` con
        // la lista vacía).
        this.log.warn(
          `turno de imagen ${turn.turnId}: el modelo cerró en la iteración ${iterations} SIN llamar herramientas. ` +
            `finishReason=${String(result.completion.finishReason)} ` +
            `tokens entrada/salida=${String(result.completion.usage?.inputTokens)}/${String(result.completion.usage?.outputTokens)} ` +
            `Texto devuelto: ${JSON.stringify((result.completion.text ?? '').slice(0, 600))}`,
        );
        closedByModel = true;
        break;
      }
      this.log.log(
        `turno de imagen ${turn.turnId}: iteración ${iterations}, ${result.completion.toolCalls.length} llamada(s) ` +
          `(${result.completion.toolCalls.map((c) => c.toolName).join(', ')})`,
      );

      args.messages.push({
        role: 'assistant',
        content: result.completion.text,
        text: result.completion.text,
        toolCalls: result.completion.toolCalls,
      });
      for (const toolCall of result.completion.toolCalls) {
        const outcome = args.plan.addToolCall(toolCall.toolName, toolCall.input);
        // El mismo rastro que el turno de texto ya dejaba: sin esto, una
        // llamada rechazada desaparecía y la vista previa quedaba con menos
        // ítems de los que el modelo pidió, sin decir cuál se cayó ni por qué.
        if (!outcome.ok) {
          this.log.warn(
            `turno de imagen ${turn.turnId}: ${toolCall.toolName} rechazada (${outcome.error}) ` +
              `con input ${JSON.stringify(toolCall.input)}`,
          );
        }
        args.messages.push({
          role: 'tool',
          content: outcome.result,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          output: outcome.result,
        });
      }
    }

    return { iterations, modelText, lastResult, closedByModel, failed };
  }

  /** Cierra un turno de imagen que no pudo completar el bucle: `FAILED`, con su costo ya pagado. */
  private async finishImageFailure(
    turn: AiTurn,
    loop: ImageLoopResult,
    plan: TurnPlan,
    diagramId: string,
    user: CurrentUserPayload,
  ): Promise<AiTurnResult> {
    const errorMessage =
      loop.lastResult !== null && !loop.lastResult.ok
        ? loop.lastResult.errorMessage
        : 'El turno superó el plazo sin llegar a una vista previa.';
    const close = await this.calls.finishTurn(turn, closeResultOf(loop), {
      status: 'FAILED',
      iterations: loop.iterations,
      errorMessage,
    });

    return {
      turnId: turn.turnId,
      status: 'FAILED',
      summary: { applied: [], notApplied: plan.notApplied, modelText: loop.modelText },
      costUsd: close.costUsd,
      iterations: loop.iterations,
      provider: close.provider,
      model: close.model,
      fallbackFired: close.fallbackFired,
      fallbackFrom: close.fallbackFrom,
      undo: await this.undoEligibilityView(diagramId, turn.turnId, user.id),
    };
  }

  /**
   * Pasa las posiciones normalizadas de la foto al lienzo (D7).
   *
   * `element-parent-containment`: `layout.x/y` de la foto es relativo al
   * padre (absoluto solo en la raíz) — pasarlo TAL CUAL como obstáculo de
   * `layoutImageItems` pondría a un elemento hijo en un punto cercano al
   * origen (su offset relativo al paquete, no su posición real de lienzo),
   * rompiendo la detección de choques contra `nx`/`ny` ya convertidas a
   * coordenadas de lienzo. Por eso `existing` se reconstruye ABSOLUTO acá
   * con `absolutePositionOf` — el mismo criterio que usan `DiagramPage.tsx`/
   * `PresenceLayer.tsx`/`ea-extension.ts` del lado del cliente/export.
   *
   * `plan.applyLayoutRect` hace el camino INVERSO al guardar el rectángulo
   * que resolvió `layoutImageItems` (absoluto): si la creación nace DENTRO
   * de un paquete (`create_class` con `parent`), lo vuelve a convertir a
   * relativo antes de guardarlo — ver el comentario de ese método.
   */
  private applyImageLayout(
    plan: TurnPlan,
    snapshot: DiagramContent,
    mode: AiImageMode,
    width: number,
    height: number,
  ): void {
    const creates = plan.imageCreateOps();
    if (creates.length === 0) return;

    const elementsById: Record<string, DiagramContent['elements'][number]> = {};
    for (const element of snapshot.elements) elementsById[element.id] = element;
    const layoutsById: Record<string, DiagramContent['layouts'][number]> = {};
    for (const layout of snapshot.layouts) layoutsById[layout.elementId] = layout;

    const placements = layoutImageItems({
      items: creates.map((create) => ({ index: create.index, position: create.position })),
      imageWidth: width,
      imageHeight: height,
      existing: snapshot.layouts.map((layout) => {
        const absolute = absolutePositionOf(layout.elementId, elementsById, layoutsById) ?? layout;
        return { x: absolute.x, y: absolute.y, width: layout.width, height: layout.height };
      }),
      mode,
    });
    for (const placement of placements) {
      const create = creates[placement.index];
      if (create !== undefined) plan.applyLayoutRect(create.label, placement.rect);
    }
  }

  /**
   * La precondición de modo, evaluada DENTRO del `FOR UPDATE` (D8/PO-D). Devuelve
   * el motivo del bloqueo o `null`.
   *
   * - crear: el diagrama tiene que seguir sin elementos;
   * - modificar: ninguna operación POSTERIOR a `baseVersion` puede haber tocado
   *   alguno de los UUID que el plan referencia. Mover algo no referenciado no
   *   bloquea: con 30 personas editando, un chequeo de versión estricto no se
   *   podría confirmar nunca.
   */
  private async modePrecondition(tx: Tx, diagramId: string, pending: PendingPreview): Promise<string | null> {
    if (pending.mode === 'create') {
      const elements = await tx.umlElement.count({ where: { diagramId } });
      return elements === 0 ? null : 'diagram_not_empty';
    }
    if (pending.referencedIds.length === 0) return null;
    const touched = await hasLaterTouchSince(tx, diagramId, pending.referencedIds, BigInt(pending.baseVersion));
    return touched ? 'target_changed' : null;
  }

  /**
   * La cadena EFECTIVA con visión y herramientas (FR-D04): la misma regla que
   * `buildChain` de `AiCallService`, sin reservar nada. Devuelve los límites
   * mínimos declarados o `null` si ningún eslabón puede con la imagen.
   */
  private async visionChain(
    projectId: string,
  ): Promise<{ maxImageBytes: number | null; maxImageDimension: number | null } | null> {
    const view = await this.config.resolve(projectId);
    const available = new Set(view.providers.filter((provider) => provider.available).map((provider) => provider.id));
    const links = [view.primary, ...view.fallbackChain].filter(
      (model) => available.has(model.provider) && model.capabilities.vision && model.capabilities.toolCalling,
    );
    if (links.length === 0) return null;

    return {
      maxImageBytes: minimumOf(links.map((model) => model.capabilities.maxImageBytes)),
      maxImageDimension: minimumOf(links.map((model) => model.capabilities.maxImageDimension)),
    };
  }

  /** Confirm sin vista previa en memoria: reinicio, TTL vencido o doble clic (D8). */
  private async confirmWithoutPreview(diagramId: string, userId: string, turnId: string): Promise<AiImageConfirmOutcome> {
    const row = await this.prisma.aiTurn.findUnique({
      where: { id: turnId },
      select: {
        userId: true,
        diagramId: true,
        status: true,
        costUsd: true,
        provider: true,
        model: true,
        fallbackFired: true,
        fallbackFrom: true,
        iterations: true,
      },
    });
    if (row === null || row.diagramId !== diagramId) return { kind: 'expired' };
    if (row.userId !== userId) return { kind: 'not_owner' };

    // `APPLIED` es el eco del doble clic: ya se aplicó, no se aplica de nuevo.
    if (row.status !== 'APPLIED') return { kind: 'expired' };

    return {
      kind: 'result',
      result: {
        turnId,
        status: 'APPLIED',
        // El eco no reconstruye el plan: la fila y el log ya tienen la verdad.
        summary: { applied: [], notApplied: [], modelText: '' },
        costUsd: row.costUsd.toString(),
        iterations: row.iterations,
        provider: row.provider,
        model: row.model,
        fallbackFired: row.fallbackFired,
        fallbackFrom: row.fallbackFrom,
        undo: await this.undoEligibilityView(diagramId, turnId, userId),
        excludedClosure: [],
        alreadyConfirmed: true,
      },
    };
  }

  private async appliedConfirm(
    diagramId: string,
    turnId: string,
    user: CurrentUserPayload,
    summary: AiTurnSummary,
    excludedClosure: number[],
    alreadyConfirmed: boolean,
  ): Promise<AiImageConfirmResult> {
    const close = await this.closeRow(turnId, 'APPLIED', null);
    return {
      ...(await this.confirmResult(diagramId, turnId, user.id, summary, close)),
      status: 'APPLIED',
      excludedClosure,
      ...(alreadyConfirmed ? { alreadyConfirmed: true as const } : {}),
    };
  }

  private async rejectedConfirm(
    diagramId: string,
    turnId: string,
    user: CurrentUserPayload,
    rejection: OperationRejected,
    summary: AiTurnSummary,
    excludedClosure: number[],
  ): Promise<AiImageConfirmResult> {
    const close = await this.closeRow(turnId, 'REJECTED', rejection.message);
    return {
      ...(await this.confirmResult(diagramId, turnId, user.id, summary, close)),
      status: 'REJECTED',
      rejection,
      // Un lote rechazado no aplicó nada: la lista de aplicadas queda vacía.
      summary: { applied: [], notApplied: summary.notApplied, modelText: summary.modelText },
      excludedClosure,
    };
  }

  private async cancelledConfirm(
    diagramId: string,
    turnId: string,
    user: CurrentUserPayload,
    summary: AiTurnSummary,
    excludedClosure: number[],
  ): Promise<AiImageConfirmResult> {
    const close = await this.closeRow(turnId, 'CANCELLED', 'Nada quedó incluido en la vista previa.');
    return {
      ...(await this.confirmResult(diagramId, turnId, user.id, summary, close)),
      status: 'CANCELLED',
      summary: { applied: [], notApplied: summary.notApplied, modelText: summary.modelText },
      excludedClosure,
    };
  }

  /** Los datos comunes de un resultado de confirmación: costo, eslabón y deshacer. */
  private async confirmResult(
    diagramId: string,
    turnId: string,
    userId: string,
    summary: AiTurnSummary,
    close: ClosedTurn | null,
  ): Promise<AiImageConfirmResult> {
    return {
      turnId,
      status: 'APPLIED',
      summary,
      costUsd: close?.costUsd ?? '0',
      iterations: close?.iterations ?? 0,
      provider: close?.provider ?? '',
      model: close?.model ?? '',
      fallbackFired: close?.fallbackFired ?? false,
      fallbackFrom: close?.fallbackFrom ?? null,
      undo: await this.undoEligibilityView(diagramId, turnId, userId),
      excludedClosure: [],
    };
  }

  /** Cierra una fila ya abierta leyendo de la fila lo que no es de este método (D8). */
  private async closeRow(turnId: string, status: AiTurnStatus, errorMessage: string | null): Promise<ClosedTurn | null> {
    const row = await this.prisma.aiTurn.findUnique({
      where: { id: turnId },
      select: {
        provider: true,
        model: true,
        fallbackFired: true,
        fallbackFrom: true,
        latencyMs: true,
        iterations: true,
      },
    });
    if (row === null) return null;

    const costUsd = await this.spend.closeTurn({
      turnId,
      status,
      provider: row.provider,
      model: row.model,
      fallbackFired: row.fallbackFired,
      fallbackFrom: row.fallbackFrom,
      latencyMs: row.latencyMs,
      iterations: row.iterations,
      errorMessage,
    });
    return {
      costUsd,
      provider: row.provider,
      model: row.model,
      fallbackFired: row.fallbackFired,
      fallbackFrom: row.fallbackFrom,
      iterations: row.iterations,
    };
  }

  /** El cierre de una vista previa cancelada sin confirmar: solo si sigue PENDING. */
  private async closeCancelled(turnId: string, reason: PreviewCancelReason): Promise<void> {
    const row = await this.prisma.aiTurn.findUnique({ where: { id: turnId }, select: { status: true } });
    if (row === null || row.status !== 'PENDING') return;
    const errorMessage = reason === 'expired' ? 'preview_expired' : 'preview_replaced';
    await this.closeRow(turnId, 'CANCELLED', errorMessage);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Aplicación
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * El plan final, con los locks y la transacción. Devuelve `null` cuando el
   * turno se abortó ANTES de tomar locks: nada se escribió y la cancelación
   * todavía manda.
   *
   * Los locks se toman recién acá, con el plan cerrado (PO-3): mientras el
   * modelo piensa los objetivos no se conocen, y tener locks tomados 20 s
   * bloquearía a gente que no hizo ningún gesto.
   */
  private async applyPlan(context: TurnContext): Promise<ApplyResult | null> {
    const ops: BatchOperation[] = context.plan.ops.map((op) => ({
      type: op.type,
      payload: op.payload,
      produces: op.produces,
    }));

    // Plan vacío: `APPLIED` con cero operaciones (D10, SC-D11). No se toman
    // locks, no se abre transacción y la versión no se mueve.
    if (ops.length === 0) return { status: 'APPLIED', committed: [], rejection: null };

    // A partir de acá la cancelación se IGNORA (D9): el turno ya empezó a
    // tomar los locks de su plan final y el deshacer es difundir un resultado,
    // no fingir que no pasó nada.
    const acquired = this.locks.acquireAllTracked(context.diagramId, context.plan.lockTargets(), this.holderFor(context.diagramId, context.user));
    if (!acquired.ok) {
      // Todo o nada: no se tomó nada, no se aplicó nada y no se difundió nada.
      return { status: 'REJECTED', committed: [], rejection: await this.lockRejection(context, acquired) };
    }

    const taken = acquired.taken;
    let deletedIds: string[] = [];
    try {
      const batch = await this.operations.applyBatch(context.diagramId, context.user.id, context.turn.turnId, ops, {
        actorKind: 'AI',
        aiTurnId: context.turn.turnId,
        opIdPrefix: 'apply',
      });

      if (batch.kind === 'rejected') return { status: 'REJECTED', committed: [], rejection: batch.rejection };
      if (batch.kind === 'blocked') {
        // Imposible en un turno: no se le pasa `guard` a `applyBatch`. Si
        // pasara, el turno FALLA en vez de inventar un rechazo.
        this.log.error(`turno ${context.turn.turnId}: applyBatch bloqueado sin guarda (${batch.reason})`);
        return { status: 'FAILED', committed: [], rejection: null };
      }

      if (batch.kind === 'committed') {
        deletedIds = batch.deletedIds;
        // SOLO después de que `applyBatch` resolvió, o sea después del
        // `COMMIT` (INV-3, SC-D09).
        this.gateway.emitCommitted(context.diagramId, batch.committed);
      }
      // El eco (`kind: 'echo'`) es el reintento de un lote ya confirmado: no se
      // vuelve a difundir lo que la sala ya recibió.
      return { status: 'APPLIED', committed: batch.committed, rejection: null };
    } finally {
      // Instrucción #1 de #2308: DESPUÉS del `COMMIT` (o de la reversión), y
      // exactamente lo que este turno tomó. `releaseElements` es para lo que el
      // borrado se llevó —la causa `'deleted'` es la única que le dice a la
      // sala POR QUÉ desapareció el lock— y `release`, que verifica el dueño,
      // para el resto de `taken`.
      if (deletedIds.length > 0) this.locks.releaseElements(context.diagramId, deletedIds, 'deleted');
      const deleted = new Set(deletedIds);
      for (const id of taken) {
        if (!deleted.has(id)) this.locks.release(context.diagramId, id, context.user.id, 'released');
      }
    }
  }

  /** El rechazo del turno cuando la unión de locks no se pudo tomar entera. */
  private async lockRejection(
    context: TurnContext,
    acquired: Exclude<TrackedLockOutcome, { ok: true }> | LockFrozen,
  ): Promise<OperationRejected> {
    const currentVersion = await this.operations.currentVersion(context.diagramId);
    const opId = batchOpId(context.turn.turnId, 'apply', 0);

    if ('frozen' in acquired) {
      return {
        opId,
        diagramId: context.diagramId,
        reason: 'DIAGRAM_FROZEN',
        message: 'El diagrama se congeló mientras el asistente pensaba. Las operaciones del turno no se aplicaron.',
        currentVersion,
      };
    }

    return {
      opId,
      diagramId: context.diagramId,
      reason: 'ELEMENT_LOCKED',
      message: `${acquired.holder.displayName} está editando un elemento que este turno necesita. No se aplicó ninguna de sus operaciones.`,
      currentVersion,
      holder: acquired.holder,
      lockedElementId: acquired.elementId,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Deshacer
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Deshacer un turno (PO-1, PO-B, D5): las inversas exactas de sus creaciones,
   * en UNA transacción, sin llamar al modelo y sin costo.
   *
   * La elegibilidad se calcula DOS veces: acá —para no abrir una transacción por
   * nada y para el motivo que muestra el botón— y otra vez DENTRO del
   * `FOR UPDATE` de `applyBatch`, que es la que decide. Entre las dos puede
   * pasar cualquier cosa (alguien renombra lo creado, alguien deshace primero) y
   * la transacción es la única autoridad.
   */
  async undo(diagramId: string, user: CurrentUserPayload, turnId: string): Promise<AiUndoOutcome> {
    const eligibility = await this.undoEligibilityView(diagramId, turnId, user.id);
    if (!eligibility.eligible) {
      return { kind: 'result', result: await this.ineligible(diagramId, turnId, eligibility.reason) };
    }

    // Descendente por versión: las inversas se aplican al revés de como se
    // hicieron, así un `feature.delete` no corre antes del `element.delete` que
    // se lo llevaría puesto por CASCADE.
    const rows = await this.prisma.diagramOperation.findMany({
      where: { diagramId, aiTurnId: turnId },
      orderBy: { version: 'desc' },
      select: { type: true, payload: true },
    });
    const ops = rows.map(inverseOperation).filter((op): op is BatchOperation => op !== null);
    if (ops.length === 0) return { kind: 'result', result: await this.ineligible(diagramId, turnId, 'nothing_applied') };

    const acquired = this.locks.acquireAllTracked(diagramId, undoLockTargets(rows), this.holderFor(diagramId, user));
    if (!acquired.ok) {
      if ('frozen' in acquired) return { kind: 'frozen' };
      return {
        kind: 'locked',
        rejection: {
          opId: batchOpId(turnId, 'undo', 0),
          diagramId,
          reason: 'ELEMENT_LOCKED',
          message: `${acquired.holder.displayName} está editando un elemento que este turno creó. Esperá a que termine o pedile que suelte el bloqueo.`,
          currentVersion: await this.operations.currentVersion(diagramId),
          holder: acquired.holder,
          lockedElementId: acquired.elementId,
        },
      };
    }

    const taken = acquired.taken;
    let deletedIds: string[] = [];
    try {
      const batch = await this.operations.applyBatch(diagramId, user.id, turnId, ops, {
        actorKind: 'USER',
        aiTurnId: null,
        opIdPrefix: 'undo',
        // El re-chequeo que DECIDE, con la fila ya bloqueada (D5).
        guard: async (tx) => {
          const recheck = await this.undoEligibility(tx, diagramId, turnId, user.id);
          return recheck.eligible ? null : recheck.reason;
        },
      });

      if (batch.kind === 'echo') {
        // El doble clic: `undo:0` ya estaba y no se aplicó nada la segunda vez.
        return { kind: 'result', result: await this.ineligible(diagramId, turnId, 'already_undone') };
      }
      if (batch.kind === 'blocked') {
        const reason = UNDO_INELIGIBLE_REASONS.has(batch.reason as AiUndoIneligibleReason)
          ? (batch.reason as AiUndoIneligibleReason)
          : 'touched_later';
        return { kind: 'result', result: await this.ineligible(diagramId, turnId, reason) };
      }
      if (batch.kind === 'rejected') {
        // La transacción entera revirtió: nada cambió. Un rechazo por lock o
        // por congelado se informa como tal; el resto (una inversa que ya no
        // encuentra su objetivo, típicamente porque un CASCADE se llevó la fila
        // sin dejar rastro en ningún payload — el límite que D5 declara) es
        // «algo posterior lo tocó».
        this.log.warn(`deshacer del turno ${turnId} rechazado: ${batch.rejection.reason} — ${batch.rejection.message}`);
        if (batch.rejection.reason === 'DIAGRAM_FROZEN') return { kind: 'frozen' };
        if (batch.rejection.reason === 'ELEMENT_LOCKED') return { kind: 'locked', rejection: batch.rejection };
        return { kind: 'result', result: await this.ineligible(diagramId, turnId, 'touched_later') };
      }

      deletedIds = batch.deletedIds;
      // Después del COMMIT, nunca antes (INV-3).
      this.gateway.emitCommitted(diagramId, batch.committed);
      return {
        kind: 'result',
        result: { turnId, undone: true, reason: null, version: await this.operations.currentVersion(diagramId) },
      };
    } finally {
      if (deletedIds.length > 0) this.locks.releaseElements(diagramId, deletedIds, 'deleted');
      const deleted = new Set(deletedIds);
      for (const id of taken) {
        if (!deleted.has(id)) this.locks.release(diagramId, id, user.id, 'released');
      }
    }
  }

  private async ineligible(diagramId: string, turnId: string, reason: AiUndoIneligibleReason): Promise<AiUndoResult> {
    return { turnId, undone: false, reason, version: await this.operations.currentVersion(diagramId) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Elegibilidad del deshacer (D5)
  // ───────────────────────────────────────────────────────────────────────────

  /** La vista informativa: una transacción de lectura, para no leer un estado a medias. */
  private undoEligibilityView(diagramId: string, turnId: string, requesterId: string): Promise<AiUndoEligibility> {
    return this.prisma.$transaction((tx) => this.undoEligibility(tx, diagramId, turnId, requesterId), {
      timeout: 5000,
      maxWait: 2000,
    });
  }

  /**
   * ¿Se puede deshacer este turno? (PO-1, PO-B, D5.) Las cuatro condiciones,
   * todas obligatorias:
   *
   * 1. quien pide es quien pidió el turno (`ai_turns.user_id`);
   * 2. el turno no fue deshecho antes (no está el `undo:0`);
   * 3. el turno solo creó;
   * 4. nada posterior tocó lo creado.
   *
   * La 4 sale del log: se buscan operaciones de versión posterior al turno cuyo
   * payload mencione algún UUID creado. Buscar un UUID como SUBCADENA es exacto
   * —36 caracteres con guiones no aparecen por accidente— y cubre
   * `sourceElementId`, `typeElementId`, `ownerId` y el `deleted` del cierre de
   * borrado. Límite conocido: un `CASCADE` no deja rastro en ningún payload, y
   * ahí la inversa falla y el lote revierte entero (la transacción manda).
   */
  private async undoEligibility(tx: Tx, diagramId: string, turnId: string, requesterId: string): Promise<AiUndoEligibility> {
    const turn = await tx.aiTurn.findUnique({ where: { id: turnId }, select: { userId: true, diagramId: true } });
    if (turn === null || turn.diagramId !== diagramId) return { eligible: false, reason: 'nothing_applied' };
    if (turn.userId !== requesterId) return { eligible: false, reason: 'not_owner' };

    const rows = await tx.diagramOperation.findMany({
      where: { diagramId, aiTurnId: turnId },
      orderBy: { version: 'asc' },
      select: { type: true, version: true, payload: true },
    });
    if (rows.length === 0) return { eligible: false, reason: 'nothing_applied' };

    // ANTES de «no creó solo»: un turno ya deshecho tiene inversas posteriores
    // que también tocan lo creado, y el motivo correcto es «ya estaba hecho».
    const undone = await tx.diagramOperation.findUnique({
      where: { diagramId_opId: { diagramId, opId: batchOpId(turnId, 'undo', 0) } },
      select: { opId: true },
    });
    if (undone !== null) return { eligible: false, reason: 'already_undone' };

    if (rows.some((row) => !CREATE_ONLY_TYPES.has(row.type))) return { eligible: false, reason: 'not_create_only' };

    const created = [
      ...new Set(
        rows
          .map((row) => (row.payload as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (created.length === 0) return { eligible: false, reason: 'nothing_applied' };

    const maxVersion = rows.reduce((max, row) => (row.version > max ? row.version : max), 0n);
    if (await hasLaterTouch(tx, diagramId, created, maxVersion)) return { eligible: false, reason: 'touched_later' };

    return { eligible: true };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Auxiliares
  // ───────────────────────────────────────────────────────────────────────────

  /** El titular del lock del turno: presencia de la sala si está, neutro si no (D10). */
  private holderFor(diagramId: string, user: CurrentUserPayload): LockHolder {
    return (
      this.gateway.presenceHolder(diagramId, user.id) ?? {
        userId: user.id,
        displayName: user.displayName,
        color: NEUTRAL_LOCK_COLOR,
      }
    );
  }

  /** `CANCELLED` si abortó el cliente, `FAILED` si abortó el plazo (D9). */
  private abortStatus(cancelSignal: AbortSignal): AiTurnStatus {
    return cancelSignal.aborted ? 'CANCELLED' : 'FAILED';
  }
}

/**
 * ¿Alguna operación POSTERIOR a `version` menciona algún UUID que el plan
 * referencia? (D8, precondición de modo `modify`.) La consulta es la misma de D5
 * del texto —un UUID de 36 caracteres no aparece por accidente como
 * subcadena—; lo que cambia es el punto de corte, que acá es la versión leída
 * antes de la foto.
 */
async function hasLaterTouchSince(
  tx: Tx,
  diagramId: string,
  referencedIds: readonly string[],
  version: bigint,
): Promise<boolean> {
  const mentioned = Prisma.join(
    referencedIds.map((id) => Prisma.sql`later.payload::text LIKE ${`%${id}%`}`),
    ' OR ',
  );
  const rows = await tx.$queryRaw<{ touched: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM diagram_operations later
      WHERE later.diagram_id = ${diagramId}::uuid
        AND later.version > ${version.toString()}::bigint
        AND (${mentioned})
    ) AS touched
  `;
  return rows[0]?.touched === true;
}

/** El último resultado del bucle, o un cierre sintético si nunca hubo uno. */
function closeResultOf(loop: ImageLoopResult): AiCallResult {
  return (
    loop.lastResult ?? {
      ok: false,
      aborted: true,
      errorMessage: 'el turno terminó antes del primer llamado',
      fallbackFired: false,
      fallbackFrom: null,
    }
  );
}

/** El `mediaType` que viaja al proveedor, derivado del tipo por CONTENIDO (D2). */
function mediaTypeOf(type: ImageType): string {
  return type === 'jpeg' ? 'image/jpeg' : `image/${type}`;
}

/** El mínimo de los límites DECLARADOS; `null` si ninguno declara ese límite. */
function minimumOf(values: readonly (number | null)[]): number | null {
  const declared = values.filter((value): value is number => value !== null);
  return declared.length === 0 ? null : Math.min(...declared);
}

/**
 * ¿Alguna operación POSTERIOR al turno menciona algún UUID que el turno creó?
 * (D5, condición 4.) El `LIKE '%uuid%'` sobre el payload serializado es la
 * consulta del diseño: un UUID es exacto como subcadena y así se cubren todos
 * los campos de referencia sin enumerarlos.
 */
async function hasLaterTouch(tx: Tx, diagramId: string, created: readonly string[], maxVersion: bigint): Promise<boolean> {
  const mentioned = Prisma.join(
    created.map((id) => Prisma.sql`later.payload::text LIKE ${`%${id}%`}`),
    ' OR ',
  );
  const rows = await tx.$queryRaw<{ touched: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM diagram_operations later
      WHERE later.diagram_id = ${diagramId}::uuid
        AND later.version > ${maxVersion.toString()}::bigint
        AND (${mentioned})
    ) AS touched
  `;
  return rows[0]?.touched === true;
}

/**
 * La inversa de una fila de creación (D5). `null` para cualquier otro tipo — que
 * la elegibilidad ya descartó, y que acá se vuelve a descartar para que un bug
 * de la condición 3 no se convierta en una operación inventada.
 */
function inverseOperation(row: { type: string; payload: Prisma.JsonValue }): BatchOperation | null {
  const payload = row.payload as Record<string, unknown>;
  const id = typeof payload.id === 'string' ? payload.id : null;
  if (id === null) return null;

  switch (row.type) {
    case 'element.create':
      return { type: 'element.delete', payload: { id, expectedIncidentRelationshipIds: [] }, produces: null };
    case 'feature.create':
      return { type: 'feature.delete', payload: { id }, produces: null };
    case 'parameter.add':
      return { type: 'parameter.remove', payload: { id }, produces: null };
    case 'literal.add':
      return { type: 'literal.remove', payload: { id }, produces: null };
    case 'relationship.create':
      return { type: 'relationship.delete', payload: { id }, produces: null };
    default:
      return null;
  }
}

/**
 * Los objetivos de lock del deshacer: la MISMA tabla `LOCK_REQUIREMENTS` que
 * resolvería el servidor dentro de la transacción, traducida desde el log.
 *
 * - `element.create` → `element.delete` → el elemento (más su cierre, que son
 *   las filas que el propio turno también creó: cada una es una operación más
 *   del lote con su propio id).
 * - `feature.create` → `feature.delete` → el DUEÑO del atributo
 *   (`payload.ownerId`, que para un elemento preexistente es un id real).
 * - `parameter.add` → `parameter.remove` → el dueño de la operación, que es una
 *   `feature.create` del mismo turno (dos saltos).
 * - `literal.add` → `literal.remove` → la enumeración.
 * - `relationship.create` → `relationship.delete` → la relación.
 *
 * `resolveLockTargets` vuelve a resolver todo dentro de la transacción y
 * `canWrite` es la autoridad: esto es solo la lista con la que se PIDE, todo o
 * nada.
 */
function undoLockTargets(rows: readonly { type: string; payload: Prisma.JsonValue }[]): string[] {
  const owners = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== 'feature.create') continue;
    const payload = row.payload as { id?: unknown; ownerId?: unknown };
    if (typeof payload.id === 'string' && typeof payload.ownerId === 'string') owners.set(payload.id, payload.ownerId);
  }

  const targets = new Set<string>();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    if (row.type === 'element.create' || row.type === 'relationship.create') {
      if (typeof payload.id === 'string') targets.add(payload.id);
    } else if (row.type === 'feature.create') {
      if (typeof payload.ownerId === 'string') targets.add(payload.ownerId);
    } else if (row.type === 'parameter.add') {
      const ownerId = typeof payload.operationId === 'string' ? owners.get(payload.operationId) : undefined;
      if (ownerId !== undefined) targets.add(ownerId);
    } else if (row.type === 'literal.add') {
      if (typeof payload.enumerationId === 'string') targets.add(payload.enumerationId);
    }
  }
  return [...targets];
}

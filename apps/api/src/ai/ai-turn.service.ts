import { Injectable, Logger } from '@nestjs/common';
import {
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
import { type SpendRejection } from './ai-spend.service';
import { AI_TURN_TOOLS } from './ai-tools';
import type { AiTurnRequestDto } from './dto/ai-turn-request.dto';
import { TurnPlan } from './ai-turn-plan';
import { buildSystemPrompt } from './ai-turn-prompt';
import type { LlmMessage } from './providers/llm-provider.interface';
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

/** Tope del bucle (FR-D15b.3, SC-D14). */
const MAX_TOOL_ITERATIONS = 25;

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

/** Todo lo que hace falta para correr, aplicar y cerrar un turno. */
interface TurnContext {
  readonly turn: AiTurn;
  readonly projectId: string;
  readonly diagramId: string;
  readonly user: CurrentUserPayload;
  readonly dto: AiTurnRequestDto;
  readonly instructions: string;
  readonly plan: TurnPlan;
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
    private readonly content: DiagramContentService,
    private readonly locks: LocksService,
    private readonly operations: OperationsService,
    private readonly gateway: CollaborationGateway,
    private readonly prisma: PrismaService,
  ) {}

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
    const plan = new TurnPlan(snapshot);
    const instructions = buildSystemPrompt(snapshot);
    const messages: LlmMessage[] = [{ role: 'user', content: dto.prompt }];
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
      tools: AI_TURN_TOOLS,
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

    while (iterations < MAX_TOOL_ITERATIONS) {
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
        tools: AI_TURN_TOOLS,
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
    // pidiendo herramientas en la iteración 25 (SC-D14).
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
        : `El modelo no cerró el turno en ${MAX_TOOL_ITERATIONS} iteraciones.`;
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

import { Injectable } from '@nestjs/common';
import type { ActorKind, DeleteClosure, OperationCommitted, OperationRejected, OperationRequest, OperationType, PayloadFor } from '@umlive/contracts';
import { batchOpId } from '../ai/turn-op-ids';
import { substituteRefFields } from '../ai/ai-turn-plan';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { LocksService } from './locks.service';
import { resolveLockTargets, type ResolvedLockTargets } from './lock-targets';
import { OperationDispatcher } from './operation-dispatch';
import { validateOperationPayload } from './operation-validation';
import { DiagramFrozenError, ElementLockedError, translateRejection } from './operation-rejection';

/**
 * Lo que `OperationsService.submit` devuelve — lleva su propio destino
 * (design.md D3). El gateway lee `route`, nunca lo decide: quien conoce el
 * motivo (este archivo) es quien fija a quién va, y quien emite (el
 * gateway) no tiene la información para desviarlo. Compuesto EXCLUSIVAMENTE
 * por tipos del contrato — una fila cruda de Prisma no sale de este archivo
 * (D9, la barrera de `BigInt`).
 */
export type OperationOutcome =
  | { route: 'room'; event: 'op:committed'; payload: OperationCommitted }
  | { route: 'sender'; event: 'op:committed'; payload: OperationCommitted }
  | { route: 'sender'; event: 'op:rejected'; payload: OperationRejected };

/**
 * Lo que devuelve la transacción (`hierarchical-delete` D2): su salida para el
 * gateway MÁS el cierre de borrado que hay que liberar. `release` viaja
 * SEPARADO del `OperationOutcome` a propósito — el `OperationOutcome` ya existe
 * antes del `COMMIT` (INV-3), y soltar locks sin confirmar sería soltar locks de
 * una operación que revirtió.
 */
interface SubmittedTransaction {
  outcome: OperationOutcome;
  /** Presente SOLO en el camino que escribió un `element.delete`. El eco idempotente no lo trae. */
  release?: DeleteClosure;
}

/** Una operación del lote: mismo molde que `PlannedOp` del plan del turno. */
export interface BatchOperation {
  readonly type: OperationType;
  readonly payload: PayloadFor<OperationType>;
  /** El `new:N` que esta operación produce, o `null`. Se enlaza DENTRO de la transacción. */
  readonly produces: string | null;
}

/**
 * Lo que distingue un lote de IA (`applyBatch`) de uno del deshacer:
 *
 * - `actorKind`/`aiTurnId`: el turno se atribuye a quien lo pidió (`AI` +
 *   `aiTurnId`), el deshacer es una edición humana normal (`USER` + `null`).
 * - `opIdPrefix`: el `opId` es determinista (`uuidV5(batchKey, prefijo:i)`), así
 *   que reintentar el mismo lote cae en el eco. `apply` y `undo` cuelgan del
 *   mismo `ai_turns.id` y por eso llevan prefijos distintos.
 * - `guard`: chequeo que corre DENTRO del `FOR UPDATE`, después del eco y del
 *   `423`, y antes de la primera operación. Es donde el deshacer reevalúa su
 *   elegibilidad con la fila ya bloqueada (D5). Devuelve el motivo del bloqueo
 *   o `null`.
 */
export interface BatchMeta {
  readonly actorKind: ActorKind;
  readonly aiTurnId: string | null;
  readonly opIdPrefix: string;
  readonly guard?: (tx: Tx) => Promise<string | null>;
}

/**
 * Resultado de un lote (D4). Cuatro formas, y cada llamador decide con la suya:
 *
 * - `committed`: confirmó. `committed` sale de `toCommitted` (el único borde de
 *   `BigInt`) y `deletedIds` es el cierre de borrado que hay que soltar
 *   DESPUÉS del `COMMIT` (instrucción #1 de #2308).
 * - `echo`: el `opId₀` ya existía — el lote ya se aplicó, no se escribió nada.
 *   Es la idempotencia de reintento y también el «ya deshecho» del deshacer.
 * - `blocked`: la `guard` de `meta` rechazó, sin escribir nada.
 * - `rejected`: la transacción revirtió. El rechazo ya viene traducido.
 */
export type BatchOutcome =
  | { readonly kind: 'committed'; readonly committed: OperationCommitted[]; readonly deletedIds: string[] }
  | { readonly kind: 'echo'; readonly committed: OperationCommitted[] }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly rejection: OperationRejected };

/** Contexto de UNA operación, compartido por `submit` y `applyBatch`. */
interface ApplyContext {
  readonly diagramId: string;
  readonly actorId: string;
}

/** Lo que devuelve `applyOneIn`: el payload AUTORITATIVO y el cierre resuelto. */
interface AppliedOperation<T extends OperationType> {
  readonly payload: PayloadFor<T>;
  readonly resolved: ResolvedLockTargets;
}

/**
 * La operación `index` del lote falló. Envuelve el error original para que
 * `applyBatch` pueda traducirlo CON el tipo y el payload de la operación que
 * de verdad falló (`conflictingName` de `CONFLICTING_NAME_TYPES` sale de ahí).
 */
class BatchOperationError extends Error {
  constructor(
    readonly opId: string,
    readonly opType: OperationType,
    readonly opPayload: unknown,
    readonly cause: unknown,
  ) {
    super(`applyBatch: la operación ${opType} falló`);
    this.name = 'BatchOperationError';
  }
}

/** La `guard` de `meta` bloqueó el lote. No es un rechazo de operación. */
class BatchGuardError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BatchGuardError';
  }
}

/** `@IsUUID('4')` a mano — el camino del socket no tiene la capa de `class-validator` (D11). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * El corazón del pipeline (design.md §1, D3, D6, D7, D9). Una única
 * transacción Prisma: `SELECT … FOR UPDATE` sobre la fila del diagrama → eco
 * idempotente por `opId` → versión + `lockState` → `423` si está congelado →
 * `resolveLockTargets` + `canWrite()` → versión siguiente → mutación (vía el
 * despachador) → fila de log → un solo `COMMIT`. Dentro del lock, SOLO trabajo
 * de base — nada de red, nada de emitir, nada de esperar al cliente (D7 regla
 * dura).
 *
 * **Las dos ramas de exigencia las agrega `element-lock-enforcement` (M4)**, y
 * su ORDEN es load-bearing (design.md D3): el eco idempotente va ANTES del
 * `423` y del `409`. Un reintento del mismo `opId` no escribe nada — rechazarlo
 * sería mentirle al cliente sobre un hecho ya confirmado y difundido, y el
 * motor de reversión de `frontend-cutover` revertiría estado AUTORITATIVO
 * (SC-C10). El Apéndice A.1 del PRD dice lo contrario en su numeración; la
 * nota fechada de esa sección explica por qué el código manda.
 *
 * NO inyecta el gateway, ni el `Server` de Socket.IO, ni nada capaz de
 * emitir. Su superficie pública es exclusivamente `OperationOutcome`: un
 * `OperationOutcome` solo existe DESPUÉS de que `$transaction` resolvió, o
 * sea después del `COMMIT` (INV-3, D3). Emitir temprano no es algo que no se
 * deba hacer — es algo que no se puede escribir.
 *
 * **Ampliado por `ai-text-instructions` (rebanada 2/4 de M6, D4):**
 * `applyOneIn` sale de `submit` —su comportamiento no cambia— y `applyBatch`
 * aplica N operaciones de un turno en UNA transacción con UN `FOR UPDATE` y UN
 * solo bump de versión. Misma secuencia de guardas, misma exigencia de locks:
 * la IA no tiene puerta trasera (`PRD.md:276`). El gateway y la liberación
 * posterior siguen afuera, en `AiTurnService`.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: OperationDispatcher,
    private readonly locks: LocksService,
  ) {}

  async submit(diagramId: string, actorId: string, req: OperationRequest): Promise<OperationOutcome> {
    // Forma de `opId` en el BORDE, antes de abrir nada (D6, D11: `op_id` es
    // `@db.Uuid` — un valor mal formado produce un `22P02` de PostgreSQL
    // desde ADENTRO de la transacción si no se ataja acá).
    if (!isValidOpId(req.opId)) {
      const currentVersion = await this.readCurrentVersion(diagramId);
      return {
        route: 'sender',
        event: 'op:rejected',
        payload: {
          opId: req.opId,
          diagramId,
          reason: 'MALFORMED',
          message: 'El identificador de la operación no es un UUID válido.',
          currentVersion,
        },
      };
    }

    // Lista blanca de `type` (verify-report 2026-09-18, C-1) — ANTES de
    // abrir la transacción. `this.dispatcher.isKnownType` lee la MISMA
    // fuente que ejecuta la operación (`OperationHandlers`, sin prototipo);
    // un `type` que no es `Object.hasOwn` de ese mapa ('toString',
    // 'constructor', '__proto__', 'hasOwnProperty', o cualquier tipo
    // inventado) nunca llega a `dispatch` — antes, `this.handlers[type]`
    // resolvía a un método HEREDADO de `Object.prototype`, escribía una fila
    // imborrable (`trg_operations_append_only`) y difundía basura a la sala.
    if (!this.dispatcher.isKnownType(req.type)) {
      const currentVersion = await this.readCurrentVersion(diagramId);
      return {
        route: 'sender',
        event: 'op:rejected',
        payload: {
          opId: req.opId,
          diagramId,
          reason: 'MALFORMED',
          message: 'El tipo de operación no existe.',
          currentVersion,
        },
      };
    }

    // Forma del payload (verify-report W-1, W-2) — MISMOS DTOs de
    // `class-validator` que las rutas HTTP, mismas opciones que el
    // `ValidationPipe` global (`whitelist: true, forbidNonWhitelisted: true`,
    // `main.ts:37`). El resultado REEMPLAZA `req.payload`: lo que sigue
    // viaje hacia el despachador — y lo que termina logueado y difundido en
    // `toCommitted` — es el payload VALIDADO, nunca el crudo. Un campo
    // ajeno al protocolo (`junk`), un campo del protocolo que ese handler no
    // lee (`isAbstract` en `element.rename`), o un tipo de campo incorrecto
    // (`x: '5'`, `x: 1.5` donde `MoveElementDto` exige `@IsInt()`) rechazan
    // ACÁ, antes de cualquier escritura — nunca como un `INTERNAL` que
    // ensucia el log del servidor (W-2), y nunca como un eco silencioso de
    // algo que la base no persistió (W-1).
    const validated = await validateOperationPayload(req.type, req.payload);
    if (!validated.ok) {
      const currentVersion = await this.readCurrentVersion(diagramId);
      return {
        route: 'sender',
        event: 'op:rejected',
        payload: {
          opId: req.opId,
          diagramId,
          reason: 'MALFORMED',
          message: validated.message,
          currentVersion,
        },
      };
    }
    const validatedReq: OperationRequest = { ...req, payload: validated.value as PayloadFor<OperationType> };

    try {
      const submitted = await this.prisma.$transaction((tx) => this.submitIn(tx, diagramId, actorId, validatedReq), {
        // Valores por defecto de Prisma, escritos explícitos para que sean un
        // número revisable y no una suposición (design.md D7). El `FOR
        // UPDATE` espera ADENTRO de la transacción, así que `timeout` cubre
        // también la espera del lock: una transacción patológica que retenga
        // la fila más de 5s hace morir a los que esperan con `P2028`, ruidoso
        // y acotado, en vez de colgar el diagrama.
        timeout: 5000,
        maxWait: 2000,
      });
      // 7. Liberación DESPUÉS del `COMMIT` (`hierarchical-delete` D2, SC-C17).
      // Que `$transaction` haya resuelto significa que el `COMMIT` ocurrió; el
      // `catch` de abajo se lleva cualquier reversión, así que acá NO se llega
      // con una transacción caída y nunca se suelta por un borrado que no pasó.
      //
      // `release` solo está en el camino que de verdad escribió (`element.delete`
      // sin eco): el eco idempotente ya soltó todo la primera vez, y volver a
      // soltar emitiría un segundo `lock:released` que V8 (cero `lock:released`
      // extra) prohíbe. **Se suelta el cierre ENTERO** — subárbol Y relaciones,
      // sin filtrar por dueño: el lock de una relación que tenía Diego también
      // se va, porque la fila ya no existe (D2). Soltar solo los elementos
      // dejaría el lock de la relación colgado hasta el TTL y Diego nunca
      // recibiría su `lock:released{cause:'deleted'}` (V6).
      if (submitted.release) {
        this.locks.releaseElements(diagramId, [...submitted.release.ids, ...submitted.release.relationshipIds], 'deleted');
      }
      return submitted.outcome;
    } catch (err) {
      const currentVersion = await this.readCurrentVersion(diagramId);
      // `validatedReq.payload`, no `req.payload`: si el rechazo necesita
      // `conflictingName` (`resolveUniqueViolation`), tiene que salir del
      // payload que YA pasó la validación de borde, nunca del crudo.
      const rejection = translateRejection(err, validatedReq.opId, diagramId, validatedReq.type, validatedReq.payload, currentVersion);
      return { route: 'sender', event: 'op:rejected', payload: rejection };
    }
  }

  private async submitIn(tx: Tx, diagramId: string, actorId: string, req: OperationRequest): Promise<SubmittedTransaction> {
    // 1. Lock puro — una sola cosa por consulta (D7). `::uuid` no es
    // cosmético: sin el cast el driver adapter manda el parámetro como
    // `text` y Postgres responde 42804.
    //
    // Nota fechada 2026-09-18 (`element-lock-enforcement`, design.md D3-ter):
    // `lock_state` NO se selecciona acá aunque `DATA-MODEL.md:846-849` lo ponga
    // en este mismo `SELECT … FOR UPDATE`. La rama que lo lee vive ABAJO, junto
    // con la versión (paso 3): tiene que ir DESPUÉS del eco idempotente (paso 2)
    // y no antes. Seleccionar columnas que nadie lee en este punto era el error
    // que D7 evitó a propósito; `locked_by`/`locked_at` NO se seleccionan nunca
    // — `OperationRejected` no tiene campo para ellos (D3-ter).
    await tx.$queryRaw`SELECT 1 FROM diagrams WHERE id = ${diagramId}::uuid FOR UPDATE`;

    // 2. Idempotencia — se resuelve LEYENDO, nunca escribiendo (D6). El
    // trigger `trg_operations_append_only` prohíbe reescribir una fila que
    // ya existe, y no hace falta: el eco se reconstruye de la fila.
    const prev = await tx.diagramOperation.findUnique({
      where: { diagramId_opId: { diagramId, opId: req.opId } },
    });
    if (prev) {
      // El caso confusión (D6): si el `actorId` de la fila no es quien
      // reenvía, o el `type` no coincide, NO es un eco — es una colisión
      // que el propio cliente se fabricó (o un intento de leer el hecho
      // ajeno). `MALFORMED`, nunca el hecho de otro. Cero escrituras: la
      // transacción confirma vacía, igual que el eco feliz.
      if (prev.actorId !== actorId || prev.type !== req.type) {
        const currentVersion = Number((await tx.diagram.findUniqueOrThrow({ where: { id: diagramId }, select: { currentVersion: true } })).currentVersion);
        return {
          outcome: {
            route: 'sender',
            event: 'op:rejected',
            payload: {
              opId: req.opId,
              diagramId,
              reason: 'MALFORMED',
              message: 'Ese identificador de operación ya fue usado por otra operación distinta.',
              currentVersion,
            },
          },
        };
      }
      return { outcome: { route: 'sender', event: 'op:committed', payload: toCommitted(prev) } };
    }

    // 3. Versión + `lockState` — API tipada, bigint (D7). Dos consultas a
    // propósito: el `$queryRaw` de arriba lockea, esta lee con el tipo que
    // documenta el resto del proyecto (`@prisma/adapter-pg` no normaliza
    // `int8` fuera de la API tipada).
    //
    // Esta es la única consulta que M4 toca del orden ya construido por M3:
    // gana `lockState`. Nada más se reordena.
    const diagram = await tx.diagram.findUniqueOrThrow({
      where: { id: diagramId },
      select: { currentVersion: true, lockState: true },
    });

    // 3-bis. Diagrama congelado → `423 DIAGRAM_FROZEN` (D3, D3-bis). Va
    // DESPUÉS del eco (paso 2) y ANTES de resolver targets: el reintento de una
    // operación ya confirmada no escribe, así que no puede ser un `423`.
    //
    // La comparación es `!== 'UNLOCKED'`, NUNCA `=== 'LOCKED_BY_HOST'` (D3-bis):
    // falla cerrado. Si `DiagramLockState` ganara un tercer valor, la igualdad
    // lo dejaría pasar en silencio. No lleva `lockedBy`/`lockedAt` al rechazo
    // (D3-ter): el cartel con nombre y hora es de la rebanada 4 y se alimenta
    // del evento `diagram:frozen`, no de acá.
    //
    // Esto alcanza también al host y a la IA (SC-C19 pagado por construcción:
    // el chequeo es sobre la FILA, no sobre el actor).
    if (diagram.lockState !== 'UNLOCKED') throw new DiagramFrozenError();

    const next = diagram.currentVersion + 1n;

    // 3-ter, 3-quater y 4. Objetivos de lock, exigencia y mutación: la MISMA
    // secuencia por la que pasa `applyBatch`, extraída a `applyOneIn` para que
    // la IA no tenga una puerta trasera (`PRD.md:276`). El comportamiento de
    // `submit` no cambia: mismo `tx`, mismo actor, mismo payload ya validado, y
    // vuelve el payload AUTORITATIVO y el cierre de borrado resuelto.
    const applied = await this.applyOneIn(tx, { diagramId, actorId }, req.type, req.payload);
    const authoritativePayload = applied.payload;

    // 5. Versión + log, dentro del mismo lock (D7, D9: `bigint` adentro,
    // `number` afuera — recién en `toCommitted`, más abajo).
    await tx.diagram.update({ where: { id: diagramId }, data: { currentVersion: next } });
    const row = await tx.diagramOperation.create({
      data: {
        diagramId,
        version: next,
        opId: req.opId,
        actorId,
        actorKind: 'USER',
        type: req.type,
        payload: authoritativePayload as Prisma.InputJsonValue,
      },
    });

    // 6. La salida recién existe ACÁ — después de que las cinco consultas de
    // arriba resolvieron dentro de la MISMA transacción que todavía no
    // confirmó. `$transaction` hace el `COMMIT` al volver de esta función;
    // INV-3 se sostiene porque este archivo no tiene con qué emitir ni con qué
    // liberar locks antes de eso (D3).
    //
    // `release` sale de `applied.resolved.deleteClosure`: existe SOLO para
    // `element.delete` y SOLO en este camino (el eco retornó arriba), que es
    // exactamente el "solo en el camino que commitea" de la spec.
    return {
      outcome: { route: 'room', event: 'op:committed', payload: toCommitted(row) },
      release: applied.resolved.deleteClosure ?? undefined,
    };
  }

  /**
   * UNA operación: objetivos de lock → exigencia → mutación. La llaman `submit`
   * (una operación) y `applyBatch` (N, dentro de UNA transacción).
   *
   * - **Objetivos de lock reales, con `tx`** (D4): traduce la fila de
   *   `LOCK_REQUIREMENTS` a `elementId[]` — las cadenas de dueño de uno y dos
   *   saltos incluidas. Duplica lecturas que el handler vuelve a hacer, a
   *   propósito: resolver fuera de la transacción leería un snapshot distinto
   *   del que muta.
   * - **LA EXIGENCIA** (SC-C08). `canWrite()` es SÍNCRONO a propósito —
   *   consulta un `Map` en memoria, sin un solo `await` adentro — y va acá, LO
   *   ÚLTIMO antes de mutar, no apenas se tomó el `FOR UPDATE` (D3). El
   *   Apéndice A.1 del PRD lo pone al principio de la lista de admisión; eso
   *   MAXIMIZA la ventana de la carrera TTL/`COMMIT` y es lo que esta rebanada
   *   corrige.
   *
   *   Esa carrera es un LÍMITE ACEPTADO, no un bug (D8): entre este chequeo y
   *   el `COMMIT` el TTL puede vencer y otro puede ganar el lock por WebSocket
   *   (que no toca la base, así que el `FOR UPDATE` no lo serializa). No se
   *   cierra: cerrarla exige acoplar `LocksService` a PostgreSQL, lo que
   *   `DATA-MODEL.md` §1.6 evita a propósito, y ningún lock debe sobrevivir un
   *   reinicio (SC-C06 exige lo contrario). El `FOR UPDATE` serializa las dos
   *   transacciones igual, así que el peor caso aterriza en orden, ambas en el
   *   log, versiones sin huecos: lo único que se pierde es la exclusión, por
   *   milisegundos. QUIEN "ARREGLE" ESTO ACOPLANDO LOCKS A LA BASE ROMPE SC-C06.
   *
   *   Cero `await` entre este retorno y el `dispatch` de abajo (D3, V10).
   * - **Mutación** — el despachador solo conoce las variantes `…In(tx)`
   *   (design.md D5). El payload que vuelve es el AUTORITATIVO: lo que
   *   realmente ocurrió, no lo que llegó.
   *
   *   `resolved` viaja ENTERO como 4.º parámetro (`hierarchical-delete` D5): es
   *   lo que le da al handler de `element.delete` el cierre recalculado desde la
   *   base para borrar por esa lista exacta.
   *
   * `lock.holder` Y `lock.elementId`: el rechazo tiene que poder nombrar a la
   * persona Y al elemento (D6, SC-C17).
   */
  private async applyOneIn<T extends OperationType>(
    tx: Tx,
    ctx: ApplyContext,
    type: T,
    payload: PayloadFor<T>,
  ): Promise<AppliedOperation<T>> {
    const resolved = await resolveLockTargets(tx, ctx.diagramId, type, payload);
    const lock = this.locks.canWrite(ctx.diagramId, resolved.ids, ctx.actorId);
    if (!lock.ok) throw new ElementLockedError(lock.holder, lock.elementId);
    const authoritativePayload = await this.dispatcher.dispatch(tx, ctx.diagramId, type, payload, resolved);
    return { payload: authoritativePayload, resolved };
  }

  /**
   * Un TURNO (o un deshacer) en UNA transacción (FR-D24, D4).
   *
   * Orden de admisión: `BEGIN {timeout:5000, maxWait:2000}` → `SELECT … FOR
   * UPDATE` de la fila del diagrama → **eco idempotente** si `opId₀` ya existe →
   * `423` si `lockState !== 'UNLOCKED'` → `guard` de `meta` → por operación
   * `bind(new:N) → applyOneIn → refMap/deleteClosure` → **un** `createMany` del
   * log y **un** `UPDATE current_version` → `COMMIT`.
   *
   * El eco va ANTES del `423` y del `409`, igual que en `submit`: un lote ya
   * confirmado no se reescribe ni se rechaza (SC-C10). Y una versión por LOTE,
   * no por operación, es lo que hace al turno atómico en lo único que el resto
   * del sistema puede observar: o se mueve `current_version` una vez con las N
   * filas, o no se mueve ninguna.
   */
  async applyBatch(
    diagramId: string,
    actorId: string,
    batchKey: string,
    ops: readonly BatchOperation[],
    meta: BatchMeta,
  ): Promise<BatchOutcome> {
    if (ops.length === 0) return { kind: 'committed', committed: [], deletedIds: [] };

    const opIds = ops.map((_, index) => batchOpId(batchKey, meta.opIdPrefix, index));

    try {
      return await this.prisma.$transaction(
        (tx) => this.applyBatchIn(tx, diagramId, actorId, opIds, ops, meta),
        // Mismos números que `submit` (D2): una transacción patológica que
        // retenga la fila más de 5 s hace morir con `P2028` a los humanos en
        // cola, ruidosa y acotada. Por eso el tope de operaciones del turno se
        // mide contra este timeout y no se sube.
        { timeout: 5000, maxWait: 2000 },
      );
    } catch (err) {
      if (err instanceof BatchGuardError) return { kind: 'blocked', reason: err.reason };

      const failed = err instanceof BatchOperationError ? err : null;
      const first = ops[0]!;
      const currentVersion = await this.readCurrentVersion(diagramId);
      return {
        kind: 'rejected',
        rejection: translateRejection(
          failed ? failed.cause : err,
          failed?.opId ?? opIds[0]!,
          diagramId,
          failed?.opType ?? first.type,
          failed?.opPayload ?? first.payload,
          currentVersion,
        ),
      };
    }
  }

  private async applyBatchIn(
    tx: Tx,
    diagramId: string,
    actorId: string,
    opIds: readonly string[],
    ops: readonly BatchOperation[],
    meta: BatchMeta,
  ): Promise<BatchOutcome> {
    // 1. Lock puro, igual que `submitIn`. `::uuid` no es cosmético: sin el cast
    // el driver adapter manda el parámetro como `text` y Postgres da 42804.
    await tx.$queryRaw`SELECT 1 FROM diagrams WHERE id = ${diagramId}::uuid FOR UPDATE`;

    // 2. Eco idempotente por el `opId₀`, que es determinista
    // (`uuidV5(batchKey, prefijo:0)`). Se resuelve LEYENDO, nunca escribiendo.
    const prev = await tx.diagramOperation.findUnique({
      where: { diagramId_opId: { diagramId, opId: opIds[0]! } },
    });
    if (prev) {
      const rows = await tx.diagramOperation.findMany({
        where: { diagramId, opId: { in: [...opIds] } },
        orderBy: { version: 'asc' },
      });
      return { kind: 'echo', committed: rows.map(toCommitted) };
    }

    // 3. Versión + `lockState`. La comparación es `!== 'UNLOCKED'`, nunca
    // `=== 'LOCKED_BY_HOST'`: falla cerrado ante un tercer estado. Alcanza al
    // host y a la IA (SC-C19, SC-C20): el chequeo es sobre la FILA.
    const diagram = await tx.diagram.findUniqueOrThrow({
      where: { id: diagramId },
      select: { currentVersion: true, lockState: true },
    });
    if (diagram.lockState !== 'UNLOCKED') throw new DiagramFrozenError();

    // 3-bis. Guarda del llamador, DENTRO del `FOR UPDATE` y después del eco: con
    // la fila ya bloqueada, lo que decida vale para toda la transacción. Es el
    // sitio donde el deshacer reevalúa «nada posterior tocó lo creado» (D5).
    if (meta.guard !== undefined) {
      const blocked = await meta.guard(tx);
      if (blocked !== null) throw new BatchGuardError(blocked);
    }

    const startVersion = diagram.currentVersion;
    const refMap = new Map<string, string>();
    const deletedIds = new Set<string>();
    const context: ApplyContext = { diagramId, actorId };
    const rows: {
      diagramId: string;
      version: bigint;
      opId: string;
      actorId: string;
      actorKind: ActorKind;
      aiTurnId: string | null;
      type: string;
      payload: Prisma.InputJsonValue;
    }[] = [];

    // 4. Por operación: enlazar los `new:N` contra los ids AUTORITATIVOS que ya
    // produjo este lote (campo por campo, con la tabla `REF_FIELDS` de D3: un
    // reemplazo por regex sobre el payload cambiaría una clase llamada
    // literalmente `new:1`), aplicar, y acumular el cierre de borrado.
    for (const [index, op] of ops.entries()) {
      const opId = opIds[index]!;
      const bound = substituteRefFields(op.type, op.payload, (reference) => refMap.get(reference));
      let applied: AppliedOperation<OperationType>;
      try {
        applied = await this.applyOneIn(tx, context, op.type, bound);
      } catch (err) {
        throw new BatchOperationError(opId, op.type, bound, err);
      }

      rows.push({
        diagramId,
        version: startVersion + BigInt(index + 1),
        opId,
        actorId,
        actorKind: meta.actorKind,
        aiTurnId: meta.aiTurnId,
        type: op.type,
        payload: applied.payload as Prisma.InputJsonValue,
      });

      if (op.produces !== null) {
        const produced = (applied.payload as { id?: unknown }).id;
        if (typeof produced === 'string') refMap.set(op.produces, produced);
      }

      const closure = applied.resolved.deleteClosure;
      if (closure !== null) {
        for (const id of closure.ids) deletedIds.add(id);
        for (const id of closure.relationshipIds) deletedIds.add(id);
      }
    }

    // 5. UN `createMany` y UN `UPDATE`, al final (D2/D4). El log se escribe en
    // lote porque su `INSERT` no compite por ningún lock: lo que se serializa
    // es la fila del diagrama y eso ya está tomado.
    await tx.diagramOperation.createMany({ data: rows });
    await tx.diagram.update({
      where: { id: diagramId },
      data: { currentVersion: startVersion + BigInt(ops.length) },
    });

    // 6. La salida recién existe ACÁ, y sale de la base: `toCommitted` es el
    // único lugar donde un `BigInt` cruza a `number` (D9).
    const stored = await tx.diagramOperation.findMany({
      where: { diagramId, opId: { in: [...opIds] } },
      orderBy: { version: 'asc' },
    });
    return { kind: 'committed', committed: stored.map(toCommitted), deletedIds: [...deletedIds] };
  }

  /** Lectura plana, fuera de transacción — para los dos casos de rechazo que no abren (o ya cerraron) el lock. */
  private async readCurrentVersion(diagramId: string): Promise<number> {
    const row = await this.prisma.diagram.findUnique({ where: { id: diagramId }, select: { currentVersion: true } });
    return row ? Number(row.currentVersion) : 0;
  }

  /**
   * Envoltorio público de `readCurrentVersion` (verify-report 2026-09-18,
   * W-4/C-2). El gateway rechaza DOS casos antes de llamar `submit`
   * (socket no unido a la sala, miembro sin permiso vigente) y esos
   * `OperationRejected` también necesitan `currentVersion` "de ahora"
   * (SC-C12) — sin este método, el gateway tendría que inyectar
   * `PrismaService` directo, lo que rompería la barrera D4/D8 (`rg -n
   * "prisma|Prisma" collaboration.gateway.ts` debe seguir dando CERO
   * líneas). Sigue devolviendo solo un `number` del contrato — nunca una
   * fila cruda.
   */
  async currentVersion(diagramId: string): Promise<number> {
    return this.readCurrentVersion(diagramId);
  }
}

function isValidOpId(opId: unknown): opId is string {
  return typeof opId === 'string' && UUID_V4.test(opId);
}

/**
 * Fila de `diagram_operations` → `OperationCommitted` — el ÚNICO lugar donde
 * una fila cruda se convierte en un tipo del contrato (D9). `Number(bigint)`
 * ocurre EXCLUSIVAMENTE acá.
 */
function toCommitted(row: {
  opId: string;
  diagramId: string;
  version: bigint;
  type: string;
  payload: Prisma.JsonValue;
  actorId: string | null;
  actorKind: string;
  aiTurnId: string | null;
  createdAt: Date;
}): OperationCommitted {
  const type = row.type as OperationType;
  return {
    opId: row.opId,
    diagramId: row.diagramId,
    version: Number(row.version),
    type,
    payload: row.payload as PayloadFor<typeof type>,
    actorId: row.actorId,
    actorKind: row.actorKind as ActorKind,
    aiTurnId: row.aiTurnId ?? undefined,
    committedAt: row.createdAt.toISOString(),
  };
}

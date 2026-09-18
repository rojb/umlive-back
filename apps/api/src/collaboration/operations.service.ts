import { Injectable } from '@nestjs/common';
import type { ActorKind, OperationCommitted, OperationRejected, OperationRequest, OperationType, PayloadFor } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { OperationDispatcher } from './operation-dispatch';
import { validateOperationPayload } from './operation-validation';
import { translateRejection } from './operation-rejection';

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

/** `@IsUUID('4')` a mano — el camino del socket no tiene la capa de `class-validator` (D11). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * El corazón del pipeline (design.md §1, D3, D6, D7, D9). Una única
 * transacción Prisma: `SELECT … FOR UPDATE` sobre la fila del diagrama →
 * versión siguiente → fila de log → mutación (vía el despachador) → un solo
 * `COMMIT`. Dentro del lock, SOLO trabajo de base — nada de red, nada de
 * emitir, nada de esperar al cliente (D7 regla dura).
 *
 * NO inyecta el gateway, ni el `Server` de Socket.IO, ni nada capaz de
 * emitir. Su superficie pública es exclusivamente `OperationOutcome`: un
 * `OperationOutcome` solo existe DESPUÉS de que `$transaction` resolvió, o
 * sea después del `COMMIT` (INV-3, D3). Emitir temprano no es algo que no se
 * deba hacer — es algo que no se puede escribir.
 */
@Injectable()
export class OperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: OperationDispatcher,
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
      return await this.prisma.$transaction((tx) => this.submitIn(tx, diagramId, actorId, validatedReq), {
        // Valores por defecto de Prisma, escritos explícitos para que sean un
        // número revisable y no una suposición (design.md D7). El `FOR
        // UPDATE` espera ADENTRO de la transacción, así que `timeout` cubre
        // también la espera del lock: una transacción patológica que retenga
        // la fila más de 5s hace morir a los que esperan con `P2028`, ruidoso
        // y acotado, en vez de colgar el diagrama.
        timeout: 5000,
        maxWait: 2000,
      });
    } catch (err) {
      const currentVersion = await this.readCurrentVersion(diagramId);
      // `validatedReq.payload`, no `req.payload`: si el rechazo necesita
      // `conflictingName` (`resolveUniqueViolation`), tiene que salir del
      // payload que YA pasó la validación de borde, nunca del crudo.
      const rejection = translateRejection(err, validatedReq.opId, diagramId, validatedReq.type, validatedReq.payload, currentVersion);
      return { route: 'sender', event: 'op:rejected', payload: rejection };
    }
  }

  private async submitIn(tx: Tx, diagramId: string, actorId: string, req: OperationRequest): Promise<OperationOutcome> {
    // 1. Lock puro — una sola cosa por consulta (D7). `::uuid` no es
    // cosmético: sin el cast el driver adapter manda el parámetro como
    // `text` y Postgres responde 42804.
    //
    // Nota fechada 2026-09-18 (verify-report W-8, design.md D7): `lock_state`
    // NO se selecciona acá a propósito. `DATA-MODEL.md:846-849` lo pone en
    // este mismo `SELECT … FOR UPDATE`, junto con el `423` de diagrama
    // congelado (C.1/C.4 de `SPECS.md:236`). Falta la rama que rechaza con
    // `423 DIAGRAM_FROZEN` cuando `lock_state !== 'unlocked'` — es
    // `concurrency-ux` (M4), no esta rebanada. Un comentario sobrevive a una
    // limpieza de "columna sin usar"; una variable sin leer no.
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
          route: 'sender',
          event: 'op:rejected',
          payload: {
            opId: req.opId,
            diagramId,
            reason: 'MALFORMED',
            message: 'Ese identificador de operación ya fue usado por otra operación distinta.',
            currentVersion,
          },
        };
      }
      return { route: 'sender', event: 'op:committed', payload: toCommitted(prev) };
    }

    // 3. Versión siguiente — API tipada, bigint (D7). Dos consultas a
    // propósito: el `$queryRaw` de arriba lockea, esta lee con el tipo que
    // documenta el resto del proyecto (`@prisma/adapter-pg` no normaliza
    // `int8` fuera de la API tipada).
    const diagram = await tx.diagram.findUniqueOrThrow({ where: { id: diagramId }, select: { currentVersion: true } });
    const next = diagram.currentVersion + 1n;

    // 4. Mutación — el despachador solo conoce las variantes `…In(tx)`
    // (design.md D5). El payload que vuelve es el AUTORITATIVO: lo que
    // realmente ocurrió, no lo que llegó.
    const authoritativePayload = await this.dispatcher.dispatch(tx, diagramId, req.type, req.payload);

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

    // 6. El `OperationOutcome` recién existe ACÁ — después de que las cinco
    // consultas de arriba resolvieron dentro de la MISMA transacción que
    // todavía no confirmó. `$transaction` hace el `COMMIT` al volver de esta
    // función; INV-3 se sostiene porque este archivo no tiene con qué
    // emitir antes de eso (D3).
    return { route: 'room', event: 'op:committed', payload: toCommitted(row) };
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

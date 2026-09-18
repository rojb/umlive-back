import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { OperationRejected, OperationType, RejectionReason, UmlErrorDetail } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { resolveCheckViolation, resolveForeignKeyViolation, resolveUniqueViolation } from '../uml/uml-errors';

const logger = new Logger('OperationsService');

/**
 * Traduce cualquier error que haya salido de la transacción de
 * `OperationsService` a un `OperationRejected` (design.md D8). Consume los
 * resolvedores PUROS de `uml-errors.ts` — nunca los envoltorios que lanzan
 * HTTP (`handleUniqueViolation`/`handleCheckViolation`/`handleForeignKeyViolation`),
 * y nunca relee `err.meta` por su cuenta: las tres formas del driver adapter
 * ya están atravesadas ahí, verificadas contra la base real.
 *
 * Orden del traductor (design.md D8), del más barato y estructurado al más
 * caro y genérico:
 *
 * 1. `ConflictException`/`BadRequestException` lanzadas DESDE el cuerpo
 *    mudado (`…In(tx)`) o desde la guarda del despachador → se lee
 *    `getResponse()`. Es el camino principal: `element_has_relationships`
 *    con su `count`/`relationships`, `parameter_set_mismatch`,
 *    `invalid_parent_kind`, `containment_cycle`, `body_requires_comment`,
 *    `stereotype_invalid`, los cuatro `association_class_*` — todos llegan
 *    enteros sin tocar Prisma.
 *    `NotFoundException` (sin cuerpo propio en este módulo:
 *    `assertXInDiagram`/`loadEnd`/`loadLinkableClass` la lanzan vacía) es la
 *    ÚNICA excepción que NO cae en `CONSTRAINT_VIOLATION`: es la carrera
 *    normal de D8 (`TARGET_NOT_FOUND`), no un bug del cliente.
 * 2. `resolveUniqueViolation(err)` → `CONSTRAINT_VIOLATION`. `conflictingName`
 *    sale del payload con el ayudante de CINCO casos (`element.create`,
 *    `element.rename`, `feature.create`, `feature.update`, `literal.add`),
 *    no de treinta y dos.
 * 3. `resolveCheckViolation(err)` → `CONSTRAINT_VIOLATION`.
 * 4. `resolveForeignKeyViolation(err)` (`P2003` con `cause.constraint.index`
 *    en las FK de `uml_relationships`/`uml_relationship_ends`) →
 *    `CONSTRAINT_VIOLATION` con `code: ELEMENT_HAS_RELATIONSHIPS`, sin
 *    `count` ni `relationships` (red de carrera, D8).
 * 5. Cualquier otra cosa → `INTERNAL` + `Logger.error`. Es el ÚNICO motivo
 *    que obliga a loguear: un cliente que no recibe nada nunca revierte su
 *    mutación optimista (rebanada 4), así que todo `op:submit` tiene que
 *    producir EXACTAMENTE una salida.
 */
export function translateRejection(
  err: unknown,
  opId: string,
  diagramId: string,
  type: OperationType,
  payload: unknown,
  currentVersion: number,
): OperationRejected {
  // 1. Excepciones de dominio lanzadas desde el cuerpo mudado o la guarda.
  if (err instanceof NotFoundException) {
    return rejected(opId, diagramId, 'TARGET_NOT_FOUND', 'El elemento o la relación que esta operación referencia ya no está en el diagrama.', currentVersion);
  }
  if (err instanceof ConflictException || err instanceof BadRequestException) {
    const response = err.getResponse();
    const body = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {};
    if (typeof body.code === 'string') {
      return rejected(opId, diagramId, 'CONSTRAINT_VIOLATION', humanMessage('CONSTRAINT_VIOLATION'), currentVersion, {
        code: body.code as UmlErrorDetail['code'],
        conflictingName: typeof body.conflictingName === 'string' ? body.conflictingName : undefined,
        count: typeof body.count === 'number' ? body.count : undefined,
        relationships: Array.isArray(body.relationships) ? (body.relationships as UmlErrorDetail['relationships']) : undefined,
      });
    }
    // `BadRequestException` sin `code` (guardas puras — `validateElementCreatePayload`,
    // `assertEndsMatchKind`): la petición está mal formada, no viola una regla de dominio.
    return rejected(opId, diagramId, 'MALFORMED', 'La operación no tiene una forma válida.', currentVersion);
  }

  // 2. P2002 — índice único.
  const uniqueCode = resolveUniqueViolation(err);
  if (uniqueCode) {
    return rejected(opId, diagramId, 'CONSTRAINT_VIOLATION', humanMessage('CONSTRAINT_VIOLATION'), currentVersion, {
      code: uniqueCode,
      conflictingName: conflictingNameFor(type, payload),
    });
  }

  // 3. P2039 — CHECK.
  const checkCode = resolveCheckViolation(err);
  if (checkCode) {
    return rejected(opId, diagramId, 'CONSTRAINT_VIOLATION', humanMessage('CONSTRAINT_VIOLATION'), currentVersion, { code: checkCode });
  }

  // 4. P2003 — FK de relaciones (carrera de borrado).
  const fkCode = resolveForeignKeyViolation(err);
  if (fkCode) {
    return rejected(opId, diagramId, 'CONSTRAINT_VIOLATION', humanMessage('CONSTRAINT_VIOLATION'), currentVersion, { code: fkCode });
  }

  // 5. No reconocido — el único motivo que obliga a un Logger.error.
  logger.error(`op:submit no reconocido — opId=${opId} diagramId=${diagramId} type=${type}: ${describeError(err)}`, err instanceof Error ? err.stack : undefined);
  return rejected(opId, diagramId, 'INTERNAL', 'Ocurrió un error en el servidor. Intentá de nuevo.', currentVersion);
}

/**
 * Ayudante de CINCO casos (design.md D8) — no de 32: `resolveUniqueViolation`
 * ya identificó CUÁL índice único se violó; lo único que falta es de dónde,
 * dentro del payload, sacar el nombre en conflicto. Los cinco tipos son
 * exactamente los que pueden disparar uno de los cinco índices únicos de
 * `uml-classifiers`/`association-class` (`uq_element_name_per_parent`,
 * `uq_attribute_name_per_owner`, `uml_enum_literals_…_key`,
 * `uml_parameters_…_key`, `uq_parameter_single_return`,
 * `uml_relationships_association_class_id_key`).
 */
function conflictingNameFor(type: OperationType, payload: unknown): string | undefined {
  const p = payload as Record<string, unknown>;
  switch (type) {
    case 'element.create':
    case 'element.rename':
    case 'feature.create':
    case 'feature.update':
    case 'literal.add':
      return typeof p.name === 'string' ? p.name : undefined;
    default:
      return undefined;
  }
}

function rejected(
  opId: string,
  diagramId: string,
  reason: RejectionReason,
  message: string,
  currentVersion: number,
  umlError?: UmlErrorDetail,
): OperationRejected {
  return { opId, diagramId, reason, message, currentVersion, umlError };
}

function humanMessage(reason: RejectionReason): string {
  switch (reason) {
    case 'CONSTRAINT_VIOLATION':
      return 'Esa operación viola una regla del modelo.';
    case 'TARGET_NOT_FOUND':
      return 'El elemento o la relación que esta operación referencia ya no está en el diagrama.';
    case 'MALFORMED':
      return 'La operación no tiene una forma válida.';
    case 'INTERNAL':
      return 'Ocurrió un error en el servidor. Intentá de nuevo.';
    default:
      return 'La operación fue rechazada.';
  }
}

function describeError(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

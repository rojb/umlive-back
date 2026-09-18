import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UML_ERROR, type UmlErrorCode } from '@umlive/contracts';

/**
 * Resolvedor de `P2002` para las cinco violaciones de índice único en juego
 * en `uml-classifiers` (design.md §6). Tarea 2.1/2.2: forzado contra la base
 * real (PostgreSQL 17, puerto 5434) con el `PrismaClient` real de esta app
 * — no leído ni asumido desde el SQL de la migración. Transcripción
 * completa en `sdd/uml-classifiers/apply-progress`.
 *
 * ── HALLAZGO, no anticipado por design.md §6 ────────────────────────────────
 *
 * `design.md` §6 asume que `err.meta?.target` llega como `string` o
 * `string[]`, y que hacen falta DOS formas de tabla: una por nombre de
 * índice (los tres parciales de SQL crudo) y otra por tupla de campos (los
 * dos `@@unique` que Prisma sí declara).
 *
 * Verificado contra la base real: **ninguna de las cinco trae `meta.target`
 * ni `meta.constraint` de nivel superior.** Esta app usa Prisma 7 en modo
 * "driver adapter" (`@prisma/adapter-pg`, ver `prisma.service.ts`) — sin el
 * motor Rust clásico, Prisma no normaliza el error por tupla de campos:
 * envuelve tal cual el error nativo de `node-postgres`. La forma real, IGUAL
 * para las cinco (las tres parciales de SQL crudo Y las dos declaradas en
 * `schema.prisma`), es:
 *
 *   err.meta.driverAdapterError.cause.constraint.index    ← nombre del índice/restricción
 *   err.meta.driverAdapterError.cause.originalMessage     ← mensaje crudo de PostgreSQL
 *
 * Consecuencia práctica: NO hacen falta dos familias de tabla — las cinco
 * resuelven por el mismo campo, con una sola tabla indexada por nombre de
 * índice. La tabla de abajo queda con una sola forma (más los planes B/C
 * defensivos, por si una versión futura de Prisma/el adapter cambia de
 * forma otra vez).
 *
 * Transcripción literal observada, forzando cada violación:
 *
 * 1) uq_element_name_per_parent →
 *    meta = {"driverAdapterError":{"cause":{"originalCode":"23505",
 *    "originalMessage":"duplicate key value violates unique constraint
 *    \"uq_element_name_per_parent\"","constraint":{"index":"uq_element_name_per_parent"},
 *    "table":"uml_elements"}}}
 *
 * 2) uq_attribute_name_per_owner →
 *    mismo patrón, "constraint":{"index":"uq_attribute_name_per_owner"},
 *    "table":"uml_features"
 *
 * 3) @@unique([enumerationId, name]) — SIN `@@map` de índice, Postgres le
 *    puso el nombre por convención (tabla_col1_col2_key) →
 *    "constraint":{"index":"uml_enum_literals_enumeration_id_name_key"},
 *    "table":"uml_enum_literals"
 *
 * 4) @@unique([operationId, position]) — mismo patrón de nombre por
 *    convención →
 *    "constraint":{"index":"uml_parameters_operation_id_position_key"},
 *    "table":"uml_parameters"
 *
 * 5) uq_parameter_single_return →
 *    "constraint":{"index":"uq_parameter_single_return"}, "table":"uml_parameters"
 *
 * Bonus verificado, no un `P2002`: forzar `ck_layout_size` (CHECK, no
 * índice único) llega con `err.code === 'P2039'`, no `'P2002'` — la primera
 * comprobación de esta función (`err.code === 'P2002'`) ya lo excluye sin
 * necesidad de tratarlo acá. Confirma que el DTO (`@Min(1)` en `width`/
 * `height`, fase 3) es la primera barrera real: la base es red de
 * seguridad, tal como dice design.md §3.
 */
const INDEX_TO_UML_ERROR: Record<string, UmlErrorCode> = {
  uq_element_name_per_parent: UML_ERROR.ELEMENT_NAME_TAKEN,
  uq_attribute_name_per_owner: UML_ERROR.ATTRIBUTE_NAME_TAKEN,
  uml_enum_literals_enumeration_id_name_key: UML_ERROR.ENUM_LITERAL_NAME_TAKEN,
  uml_parameters_operation_id_position_key: UML_ERROR.PARAMETER_POSITION_CONFLICT,
  uq_parameter_single_return: UML_ERROR.OPERATION_ALREADY_HAS_RETURN,
};

const KNOWN_INDEX_NAMES = Object.keys(INDEX_TO_UML_ERROR);

/**
 * `null` si no reconoce nada — el llamador relanza como `500`, nunca `409`
 * por defecto (design.md §6, tasks.md 2.2). Un `P2002` desconocido es un bug
 * o un índice nuevo que esta tabla todavía no contempla; disfrazarlo de
 * `409 conflict` genérico escondería cuál de los dos pasó.
 */
export function resolveUniqueViolation(err: unknown): UmlErrorCode | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return null;
  }

  const meta = err.meta as Record<string, unknown> | undefined;

  // Plan A — forma real verificada (ver comentario de cabecera).
  const adapterIndex = extractAdapterIndexName(meta);
  if (adapterIndex) {
    const resolved = INDEX_TO_UML_ERROR[adapterIndex];
    if (resolved) return resolved;
  }

  // Plan B — forma clásica de motor Rust (`meta.target`), nunca observada en
  // este proyecto pero declarada por si un cambio futuro de Prisma la trae
  // de vuelta. `target` llega como `string` o `string[]` según el caso.
  const target = meta?.target;
  const targetKey = Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : undefined;
  if (targetKey) {
    for (const name of KNOWN_INDEX_NAMES) {
      if (targetKey === name || targetKey.includes(name)) return INDEX_TO_UML_ERROR[name] ?? null;
    }
  }

  // Plan C — mismo criterio que `join-codes/redemption.service.ts`
  // (`isCheckViolation`): buscar el nombre crudo de la restricción en el
  // mensaje completo (mensaje + meta serializado), por si ninguna de las
  // rutas estructuradas de arriba capturó el dato en esta versión.
  const haystack = `${err.message} ${meta ? JSON.stringify(meta) : ''}`;
  for (const name of KNOWN_INDEX_NAMES) {
    if (haystack.includes(name)) return INDEX_TO_UML_ERROR[name] ?? null;
  }

  return null;
}

function extractAdapterIndexName(meta: Record<string, unknown> | undefined): string | undefined {
  const adapterError = meta?.driverAdapterError as Record<string, unknown> | undefined;
  const cause = adapterError?.cause as Record<string, unknown> | undefined;
  const constraint = cause?.constraint as Record<string, unknown> | undefined;
  const index = constraint?.index;
  return typeof index === 'string' ? index : undefined;
}

/**
 * Extensión de fase 3/4 (tasks.md 3.2, 3.3, 4.2): envoltorio único que las
 * 17 mutaciones usan para no repetir el mapeo `UmlErrorCode → HTTP` en cada
 * servicio. NO relee `err.meta` por su cuenta — delega entero en
 * `resolveUniqueViolation` de arriba, como exige la corrección de fase 1.
 *
 * `parameter_position_conflict` es la única excepción deliberada (design.md
 * §6): el usuario no puede provocarlo — las posiciones las asigna el
 * servidor — así que aunque el resolvedor lo reconozca, esta función lo
 * RELANZA sin envolver, para que explote como `500` y no como `409`.
 * Cualquier otro código reconocido se envuelve en `409 { code,
 * conflictingName }` (SC-B06/B07). Un `P2002` no reconocido también se
 * relanza tal cual — el llamador (Nest) lo convierte en `500`.
 */
export function handleUniqueViolation(err: unknown, conflictingName: string): never {
  const code = resolveUniqueViolation(err);
  if (code && code !== UML_ERROR.PARAMETER_POSITION_CONFLICT) {
    throw new ConflictException({ code, conflictingName });
  }
  throw err;
}

/**
 * Resolvedor de `P2039` (violación de `CHECK`, PostgreSQL `23514`) para
 * `uml-relationships` (design.md D1; tasks.md 1.1, bloqueante — PRIMERA
 * tarea de la unidad). Forzado contra PostgreSQL real (puerto 5434,
 * `@prisma/adapter-pg`) con el `PrismaClient` real de esta app — script
 * descartable, borrado antes de este commit. Mismo precedente que el
 * hallazgo de `P2002` de arriba: `design.md` dejaba el "plan A" en blanco a
 * propósito porque la forma era desconocida.
 *
 * ── HALLAZGO — para `P2039` NO hay plan A, a diferencia de `P2002`/`P2003` ──
 *
 * Forzado real, dos violaciones:
 *
 * 1) `ck_relationship_not_self_generalization` (creando una `GENERALIZATION`
 *    con `source = target`):
 *
 *      err.code = 'P2039'
 *      err.meta = {
 *        modelName: 'UmlRelationship',
 *        driverAdapterError: { name: 'DriverAdapterError', cause: {
 *          originalCode: '23514',
 *          kind: 'postgres',
 *          originalMessage: 'new row for relation "uml_relationships" ' +
 *            'violates check constraint "ck_relationship_not_self_generalization"',
 *          message: '<mismo texto que originalMessage>',
 *          severity: 'ERROR',
 *          detail: 'Failing row contains (...).',
 *        } },
 *      }
 *
 *    **NO hay `cause.constraint` en absoluto.** A diferencia de un `23505`
 *    (índice único, `P2002`) y de un `23503` (FK, ver `P2003` abajo), un
 *    `23514` (CHECK) de `adapter-pg` no trae el nombre de la restricción en
 *    NINGÚN campo estructurado — el único lugar donde aparece
 *    `ck_relationship_not_self_generalization` es como texto libre dentro de
 *    `originalMessage`.
 *
 * 2) Bonus verificado, no un `P2039` — forzado también por la tarea 1.1
 *    (`P2003`, borrando un elemento con una relación `ON DELETE RESTRICT`
 *    apuntándolo vía `uml_relationships.source_element_id`):
 *
 *      err.code = 'P2003'
 *      err.meta = {
 *        modelName: 'UmlElement',
 *        driverAdapterError: { name: 'DriverAdapterError', cause: {
 *          originalCode: '23503',
 *          kind: 'ForeignKeyConstraintViolation',
 *          constraint: { index: 'uml_relationships_source_element_id_fkey' },
 *          originalMessage: 'update or delete on table "uml_elements" ' +
 *            'violates foreign key constraint ' +
 *            '"uml_relationships_source_element_id_fkey" on table "uml_relationships"',
 *        } },
 *      }
 *
 *    A diferencia de `P2039`, un `P2003` SÍ trae `cause.constraint.index`
 *    — igual que `P2002`. Documentado acá por completitud de la tarea 1.1
 *    (pide forzar los DOS), pero D6 (fase 3, `deleteElement`) no lo
 *    consume: la comprobación previa autoritativa es la que produce el
 *    `409`, y la captura de `P2003` ahí es solo red de carrera que relanza
 *    tal cual sin inspeccionar esta forma. No hace falta un
 *    `resolveForeignKeyViolation` en esta unidad.
 *
 * CONSECUENCIA para el resolvedor de abajo: no existe plan A posible para
 * `P2039` — no hay campo estructurado que leer. El plan viable es leer
 * `cause.originalMessage` con una regex (`violates check constraint
 * "(\w+)"`) y, si por algún motivo no matchea, un plan B de substring — pero
 * el uno y el otro miran SOLO `originalMessage`, nunca `detail` ni el `meta`
 * completo serializado.
 *
 * **Corrección `uml-validation` (verify-report W-4).** La versión anterior de
 * este resolvedor buscaba el nombre de la constraint en
 * `err.message + JSON.stringify(meta)` — y `meta` incluye
 * `cause.detail: 'Failing row contains (...)'`, que trae DATOS DEL USUARIO
 * (p. ej. `roleName`, cualquier columna de la fila que violó la CHECK).
 * Forzado real: crear una `ASSOCIATION` con un extremo `COMPOSITE` y
 * `upperBound: null` (viola `ck_composite_multiplicity`) pero con
 * `roleName: 'ck_relationship_not_self_generalization'` — el resolvedor
 * viejo encontraba ese substring en `detail` ANTES que el nombre real de la
 * constraint en `originalMessage`, y devolvía
 * `409 { code: 'relationship_self_generalization' }` en vez del
 * `composite_multiplicity_invalid` correcto. Restringir la búsqueda a
 * `originalMessage` (el único campo que PostgreSQL usa para el nombre de la
 * constraint, nunca para datos de fila) cierra la clasificación errónea sin
 * perder ningún caso real: las tres constraints alcanzables
 * (`ck_relationship_not_self_generalization`, `ck_composite_multiplicity`,
 * `ck_end_multiplicity`) y ahora también `ck_element_not_own_parent`
 * aparecen SIEMPRE, textualmente, en `originalMessage` — nunca solo en
 * `detail`.
 */
/**
 * Fila agregada por `uml-validation` (design.md D3; tasks.md 1.3, bloqueante
 * para 1.4). Forzado real, mismo criterio que el bloque de arriba: `Prisma`
 * directo (no la ruta HTTP, para saltar el guard de aplicación que ya
 * rechaza el autolazo antes de llegar a la base) contra PostgreSQL 17
 * (puerto 5434), actualizando `parentId = id` sobre un `PACKAGE` recién
 * creado.
 *
 * Forma observada — MISMA que `ck_relationship_not_self_generalization`
 * (ningún campo estructurado, el nombre solo aparece en texto libre):
 *
 *   err.code = 'P2039'
 *   err.meta = {
 *     modelName: 'UmlElement',
 *     driverAdapterError: { name: 'DriverAdapterError', cause: {
 *       originalCode: '23514',
 *       kind: 'postgres',
 *       originalMessage: 'new row for relation "uml_elements" violates ' +
 *         'check constraint "ck_element_not_own_parent"',
 *       message: '<mismo texto que originalMessage>',
 *       severity: 'ERROR',
 *       detail: 'Failing row contains (...).',
 *     } },
 *   }
 *
 * Confirma la predicción del plan C ya escrito para `P2039` arriba: no hace
 * falta ningún resolvedor nuevo, la tabla `CHECK_CONSTRAINT_TO_UML_ERROR` ya
 * cubre esta constraint con solo agregar la fila — `resolveCheckViolation`
 * no cambia.
 */
const CHECK_CONSTRAINT_TO_UML_ERROR: Record<string, UmlErrorCode> = {
  ck_relationship_not_self_generalization: UML_ERROR.RELATIONSHIP_SELF_GENERALIZATION,
  ck_composite_multiplicity: UML_ERROR.COMPOSITE_MULTIPLICITY_INVALID,
  ck_end_multiplicity: UML_ERROR.END_MULTIPLICITY_INVALID,
  /**
   * Red de carrera ESTRECHA, no la garantía general de D3 (corrección
   * verify-report W-3 — el comentario anterior sobrestimaba lo que esta
   * CHECK cubre). `ck_element_not_own_parent` es
   * `CHECK (parent_id IS NULL OR parent_id <> id)`: **solo** prohíbe el
   * autolazo directo (`parentId === elementId`). Un ciclo de DOS elementos
   * armado por carrera (`PATCH A.parent=B` y `PATCH B.parent=A` concurrentes,
   * cada uno pasando la comprobación de `collectSubtreeIds` porque el otro
   * todavía no confirmó) pasa esta CHECK INTACTO — no hay ninguna constraint
   * de base que lo detecte; es exactamente el ciclo que D3 documenta como
   * "raro, no imposible" y que `qualifiedName()` tiene que poder cortar sin
   * colgarse. Esta fila solo cierra el caso de autolazo alcanzado por
   * carrera (una escritura fuera de `setElementParent`, o la ventana entre
   * la comprobación y el `UPDATE`): produce el mismo `409 containment_cycle`
   * que la comprobación autoritativa, nunca un `500`. Antes de W-3, además,
   * esta fila estaba MUERTA en la práctica: `setElementParent` nunca llamaba
   * a `handleCheckViolation`, así que aunque la CHECK se disparara, salía
   * `500` de todos modos.
   */
  ck_element_not_own_parent: UML_ERROR.CONTAINMENT_CYCLE,
};

const KNOWN_CHECK_NAMES = Object.keys(CHECK_CONSTRAINT_TO_UML_ERROR);

/**
 * `null` si no reconoce nada — el llamador relanza como `500`, nunca `409`
 * genérico (design.md D1). Un `P2039` no reconocido por esta tabla es un bug
 * o una CHECK nueva que esta tabla todavía no contempla.
 */
export function resolveCheckViolation(err: unknown): UmlErrorCode | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2039') {
    return null;
  }

  const meta = err.meta as Record<string, unknown> | undefined;
  const originalMessage = extractOriginalMessage(meta);

  // Sin `originalMessage` estructurado no hay nada seguro que leer — a
  // diferencia del resolvedor de `P2002`, este NO cae a un plan D que mire
  // `err.message`/`meta` completos: esos campos pueden traer `detail`
  // (`Failing row contains (...)`), que es DATO DEL USUARIO, no el nombre de
  // la constraint (W-4).
  if (!originalMessage) return null;

  // Plan A — regex sobre el mensaje real de PostgreSQL para un `23514`:
  // `new row for relation "..." violates check constraint "NOMBRE"`. El
  // nombre entre comillas es SIEMPRE el identificador de la constraint, así
  // que un match acá es inequívoco.
  const match = /violates check constraint "([^"]+)"/.exec(originalMessage);
  if (match) {
    return CHECK_CONSTRAINT_TO_UML_ERROR[match[1]!] ?? null;
  }

  // Plan B — substring, por si una versión futura de PostgreSQL/el adapter
  // cambia la forma exacta del mensaje. Mismo criterio que el plan C de
  // `resolveUniqueViolation`, pero acotado a `originalMessage` SOLAMENTE
  // (W-4) — nunca a `err.message` ni al `meta` completo, que pueden
  // contener `detail` con datos de la fila.
  for (const name of KNOWN_CHECK_NAMES) {
    if (originalMessage.includes(name)) return CHECK_CONSTRAINT_TO_UML_ERROR[name] ?? null;
  }

  return null;
}

/** Mismo camino que `extractAdapterIndexName` (arriba), pero para `cause.originalMessage` — el único campo confiable para P2039 (W-4). */
function extractOriginalMessage(meta: Record<string, unknown> | undefined): string | undefined {
  const adapterError = meta?.driverAdapterError as Record<string, unknown> | undefined;
  const cause = adapterError?.cause as Record<string, unknown> | undefined;
  const originalMessage = cause?.originalMessage;
  return typeof originalMessage === 'string' ? originalMessage : undefined;
}

/**
 * Envoltorio único que las mutaciones de `uml-relationships` usan para no
 * repetir el mapeo `UmlErrorCode → HTTP` (mismo patrón que
 * `handleUniqueViolation`). Un `P2039` reconocido se envuelve en `409 {
 * code }`; uno no reconocido, o cualquier otro error, se relanza tal cual —
 * nunca un `409` genérico que esconda un bug (design.md D1).
 */
export function handleCheckViolation(err: unknown): never {
  const code = resolveCheckViolation(err);
  if (code) {
    throw new ConflictException({ code });
  }
  throw err;
}

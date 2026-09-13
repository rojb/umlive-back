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

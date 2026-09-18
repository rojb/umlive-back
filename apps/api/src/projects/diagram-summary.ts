import type { DiagramFreezeInfo, DiagramSummary } from '@umlive/contracts';
import type { Prisma } from '../generated/prisma/client';

/**
 * El ÚNICO punto donde se arma un `DiagramSummary` (`concurrency-ux` D7).
 *
 * Antes de esta rebanada había cuatro lugares armándolo a mano — dos en
 * `projects/` (`diagrams.service.ts` y `projects.service.ts`), uno en
 * `collaboration/diagram-freeze.service.ts` con su propia `SUMMARY_SELECT`, y
 * el mapper genérico de `uml/uml-mappers.ts` —, cada uno con su propia lista
 * de columnas. Agregar `freeze` a la vista sin unificar habría exigido cuatro
 * selecciones más, y la próxima columna, cinco: el punto donde las formas
 * divergen en silencio.
 *
 * Funciones SUELTAS, no una clase ni un `@Injectable` (mismo patrón que
 * `uml/diagram-scope.ts`): es serialización pura, sin dependencias de Nest y
 * sin estado, así que se importa como ARCHIVO — nunca como módulo — desde
 * cualquier capa. `DiagramFreezeService` (en `collaboration/`) es el caso que
 * importa: importarlo como módulo habría exigido que `ProjectsModule` importe
 * `CollaborationModule` y cerraría el ciclo que D1 de `diagram-freeze`
 * resolvió mudando las rutas.
 *
 * `lockedByUser` viaja en la proyección porque `freeze.by.displayName` es el
 * texto que B1 muestra («congelado por Mariana López · 14:32»): resolverlo con
 * una segunda consulta por diagrama convertiría el listado de B1 en N+1.
 */

/**
 * Columnas de la vista, compartidas por los tres puntos de lectura. Lleva
 * `lockedAt` y `lockedByUser` porque `freeze` se deriva de ellas, y la
 * relación entra por `select` anidado para traer solo `id`/`displayName`
 * (nunca el `passwordHash` ni nada más del usuario).
 *
 * Tipada de verdad (no un objeto suelto): si alguien lo pasa a un `select` de
 * Prisma que no acepta una de estas claves, falla acá y no en la consulta.
 */
export const DIAGRAM_SUMMARY_SELECT = {
  id: true,
  name: true,
  lockState: true,
  currentVersion: true,
  createdAt: true,
  updatedAt: true,
  lockedAt: true,
  lockedByUser: { select: { id: true, displayName: true } },
} as const satisfies Prisma.DiagramSelect;

/**
 * La fila que produce `DIAGRAM_SUMMARY_SELECT`. `lockedAt`/`lockedByUser` son
 * OBLIGATORIOS a propósito: una consulta que se olvide de ellos no compila.
 * Con campos opcionales, el diagrama congelado devolvería `freeze: null` sin
 * que nada avise — la misma clase de mentira silenciosa que D7 evita.
 */
export type DiagramSummaryRow = Prisma.DiagramGetPayload<{ select: typeof DIAGRAM_SUMMARY_SELECT }>;

/**
 * Fila de Prisma → vista del contrato. `currentVersion` es `bigint` en la base
 * y `number` en el contrato, así que la conversión es explícita (mismo detalle
 * que ya tenía el mapper original).
 *
 * `freeze` sale de la MISMA fila que el resto: las tres columnas
 * (`lock_state`, `locked_by`, `locked_at`) las escribe juntas la transacción de
 * `DiagramFreezeService` — `ck_diagrams_lock_coherent` lo impone en la base —,
 * así que acá se traducen juntas y con un solo campo. Los dos chequeos de
 * coherencia son una defensa de tipos, no una rama viva: `lockedByUser` es
 * `null` cuando el diagrama está abierto, y una fila que se contradiga no
 * inventa un nombre de relleno — cae a `null` y B1 no muestra nada raro.
 */
export function toDiagramSummary(row: DiagramSummaryRow): DiagramSummary {
  return {
    id: row.id,
    name: row.name,
    lockState: row.lockState,
    currentVersion: Number(row.currentVersion),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    freeze: toFreezeInfo(row),
  };
}

function toFreezeInfo(row: DiagramSummaryRow): DiagramFreezeInfo | null {
  if (row.lockState !== 'LOCKED_BY_HOST' || !row.lockedByUser || !row.lockedAt) return null;
  return {
    by: { userId: row.lockedByUser.id, displayName: row.lockedByUser.displayName },
    at: row.lockedAt.toISOString(),
  };
}

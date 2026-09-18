import type { Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * `collectSubtreeIds` — clausura del elemento y todos sus descendientes por
 * `parent_id` (design.md D1, tasks.md 0.1). Dos llamadores, la misma
 * consulta: `deleteElement` la usa para saber a quién va a cascadear;
 * `setElementParent` (fase 1) la usa para saber si el padre propuesto está
 * debajo del hijo (guarda de ciclo de contención).
 *
 * `UNION` (no `UNION ALL`), SIN columna `depth` — precedente literal en
 * `auth/tokens.service.ts:204` (`revokeChain`), mismo comentario: `UNION`
 * deduplica por `id`, así que la consulta TERMINA aunque los datos ya
 * contengan un ciclo de contención — y hoy pueden contenerlo
 * (`ck_element_not_own_parent` solo prohíbe el autolazo directo, Hallazgo 5
 * de la propuesta). Agregar `depth < 64` acá sería CONTRAPRODUCENTE: la
 * columna `depth` volvería distintas las filas repetidas y rompería la
 * deduplicación que hace que la consulta termine (design.md D1, tabla de
 * opciones descartadas).
 *
 * El root se incluye en el conjunto (fila ancla, `WHERE id = rootId`): el
 * borrado necesita las relaciones PROPIAS del elemento (no solo las de sus
 * descendientes), y la guarda de ciclo necesita que `parentId === elementId`
 * caiga dentro del mismo subárbol que el resto de la comprobación.
 *
 * **`diagramId` obligatorio — defensa en profundidad (verify-report
 * CRITICAL-1)**: el llamador YA verificó `rootId` con `assertElementInDiagram`
 * antes de invocar esta función, así que el filtro acá es redundante para
 * cualquier llamador correcto. Pero un `parent_id` corrupto o un llamador
 * futuro que se salte esa verificación no tiene por qué descubrirlo
 * recorriendo el árbol de contención de OTRO diagrama (y por lo tanto de
 * otro proyecto) — la recursión ahora nunca cruza `diagram_id`, ni en la fila
 * ancla ni en el paso recursivo.
 */
export async function collectSubtreeIds(tx: Tx, rootId: string, diagramId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM uml_elements WHERE id = ${rootId}::uuid AND diagram_id = ${diagramId}::uuid
      UNION
      SELECT e.id FROM uml_elements e
        JOIN subtree s ON e.parent_id = s.id
       WHERE e.diagram_id = ${diagramId}::uuid
    )
    SELECT id FROM subtree
  `;
  return rows.map((row) => row.id);
}

import { Logger, NotFoundException } from '@nestjs/common';
import { LOCK_REQUIREMENTS, type DeleteClosure, type LockTarget, type OperationType, type PayloadFor } from '@umlive/contracts';
import type { Tx } from '../prisma/tx.type';
import { collectSubtreeIds } from '../uml/element-subtree';

/**
 * Traductor TOTAL de `LOCK_REQUIREMENTS` a ids reales de elemento
 * (`element-lock-enforcement/design.md` D4, D5).
 *
 * Mismo patrón que `uml/diagram-scope.ts`: **funciones exportadas que reciben
 * `tx`**, sin clase, sin estado, sin ser provider de Nest. La única razón por
 * la que existe es que hasta esta rebanada `LOCK_REQUIREMENTS` era una tabla
 * que nadie leía: el compilador exige sus 32 CLAVES y nunca mira sus VALORES
 * (hallazgo #2 de la propuesta). Este archivo es su primer lector y convierte
 * cada fila en los `elementId` que `canWrite()` consulta.
 *
 * **Las cuatro consultas son propias, no reusadas** (D4). `findIncidentRelationships`
 * de `ElementsService` es `private` y además NO filtra por `diagramId` — se
 * apoya en que el llamador ya validó el alcance. Hacerlo público obligaría a
 * inyectar `ElementsService` acá solo para leer ids y arrastraría el `include`
 * con dos joins que arman `IncidentRelationshipView`, o sea trabajo de
 * presentación DENTRO del lock de fila, contra la regla D7. Las cuatro
 * consultas de abajo son `select` mínimos acotados por `diagramId`.
 *
 * **Duplicación de lecturas, aceptada** (D4): `featureOwner` vuelve a leer lo
 * que el handler leerá después vía `assertFeatureInDiagram`. Es trabajo de base
 * dentro del lock (D7 lo permite), son milisegundos, y la alternativa —resolver
 * fuera de la transacción— leería un snapshot DISTINTO del que muta.
 */

const log = new Logger('LockTargets');

/**
 * Bug de tabla, no carrera. Se lanza cuando un `field` declarado en
 * `LOCK_REQUIREMENTS` no está en el payload, o no es `string`. Con D2·C
 * (unión discriminada + `field: StringKeys<PayloadFor<T>>`) esto NO puede
 * pasar desde el tipo: solo llega acá un objeto construido fuera del tipo
 * (`as any`) o una variante nueva sin `case`. `translateRejection` lo manda a
 * `INTERNAL` — el único motivo que obliga a `Logger.error` —, nunca a una
 * lista vacía, que es la forma silenciosa del fallo: lista vacía = `canWrite`
 * devuelve `ok` = la exigencia deja de excluir sin que nadie se entere.
 */
export class LockTargetTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockTargetTableError';
  }
}

/**
 * El resultado de resolver la tabla: los `elementId` a exigir **y**, cuando la
 * operación es un `element.delete`, el cierre de borrado completo
 * (`hierarchical-delete` D5). El pipeline le pasa el objeto ENTERO al
 * despachador como 4.º parámetro: el handler de `element.delete` necesita el
 * cierre (no solo los ids de lock) para borrar por la lista exacta.
 */
export interface ResolvedLockTargets {
  /** Los `elementId` que `canWrite()` consulta. Para `element.delete` es el cierre entero. */
  ids: string[];
  /** Solo para `element.delete`; `null` para los otros 31 tipos. */
  deleteClosure: DeleteClosure | null;
}

/**
 * Objetivos de lock de una operación, resueltos DENTRO de la transacción del
 * `op:submit` (D3, D4). Deduplicado: una `ASSOCIATION` reflexiva satisface las
 * tres ramas del `OR` de `deleteClosure` para el mismo id, y un
 * `relationship.create` con `source === target` produce el mismo id dos veces.
 * `canWrite` sobreviviría igual con duplicados, pero vuelven ilegible cualquier
 * log.
 *
 * Una fila de dueño ausente es `TARGET_NOT_FOUND` (`NotFoundException`, la
 * carrera normal que `translateRejection` ya distingue de un bug del cliente),
 * NUNCA `INTERNAL`: que el `featureId` se haya borrado en el ínterin no es un
 * defecto del servidor.
 */
export async function resolveLockTargets<T extends OperationType>(
  tx: Tx,
  diagramId: string,
  type: T,
  payload: PayloadFor<T>,
): Promise<ResolvedLockTargets> {
  const targets = new Set<string>();
  let deleteClosure: DeleteClosure | null = null;

  for (const target of LOCK_REQUIREMENTS[type].targets) {
    const resolved = await resolveOne(tx, diagramId, type, payload, target);
    for (const id of resolved.ids) targets.add(id);
    if (resolved.deleteClosure) deleteClosure = resolved.deleteClosure;
  }

  return { ids: [...targets], deleteClosure };
}

/**
 * Una fila de la tabla → 0..n ids. `switch` sobre `t.from` CERRADO con
 * `default: const _e: never = t` (D5): un `from` nuevo sin rama no compila, y
 * un objeto forzado en runtime sale por `INTERNAL` + `Logger.error` con el
 * detalle exacto. En ningún caso una lista vacía por defecto.
 */
async function resolveOne<T extends OperationType>(
  tx: Tx,
  diagramId: string,
  type: T,
  payload: PayloadFor<T>,
  t: LockTarget<T>,
): Promise<{ ids: string[]; deleteClosure: DeleteClosure | null }> {
  switch (t.from) {
    case 'payload': {
      // No hay consulta: el id ya viene en el payload. Un campo ausente o de
      // otro tipo es un bug de la tabla (D4), no una carrera.
      const value = (payload as Record<string, unknown>)[t.field as string];
      if (typeof value !== 'string') {
        const detail = `${type}.${String(t.field)}: se esperaba un string en el payload, llegó ${typeof value}`;
        log.error(`LOCK_REQUIREMENTS mal derivada — ${detail}`);
        throw new LockTargetTableError(detail);
      }
      return { ids: [value], deleteClosure: null };
    }

    case 'featureOwner': {
      // 1 salto: uml_features → owner_id (el elemento dueño de la feature).
      const row = await tx.umlFeature.findFirst({
        where: { id: requirementField(payload, t.field, type), owner: { diagramId } },
        select: { ownerId: true },
      });
      if (!row) throw new NotFoundException();
      return { ids: [row.ownerId], deleteClosure: null };
    }

    case 'parameterOwner': {
      // 2 SALTOS: uml_parameters → operation (una feature) → owner_id.
      // Un `owner(payload.id)` genérico NO podría expresar esto: el argumento
      // es un `parameterId`, no un `featureId` (D2).
      const row = await tx.umlParameter.findFirst({
        where: { id: requirementField(payload, t.field, type), operation: { owner: { diagramId } } },
        select: { operation: { select: { ownerId: true } } },
      });
      if (!row) throw new NotFoundException();
      return { ids: [row.operation.ownerId], deleteClosure: null };
    }

    case 'literalOwner': {
      // 1 salto, pero por OTRA tabla: uml_enum_literals → enumeration_id
      // (la ENUMERATION es el elemento). El `owner(...)` genérico tampoco
      // podría expresarlo (D2).
      const row = await tx.umlEnumLiteral.findFirst({
        where: { id: requirementField(payload, t.field, type), enumeration: { diagramId } },
        select: { enumerationId: true },
      });
      if (!row) throw new NotFoundException();
      return { ids: [row.enumerationId], deleteClosure: null };
    }

    case 'deleteClosure': {
      // El cierre de borrado (`hierarchical-delete` D1/D5), RECALCULADO desde
      // la base: nunca se confía en la lista que mandó el cliente. Reusa
      // `collectSubtreeIds` (de `uml-validation`, ya probada contra la base) —
      // subárbol por `parent_id` con la raíz incluida — y suma las relaciones
      // con rol `ENDPOINT` sobre CUALQUIER nodo del subárbol.
      //
      // El término `associationClassId` NO está acá a propósito: una clase
      // asociación no es un extremo (`ck_assoc_class_not_endpoint`), así que la
      // relación que la liga entra al cierre solo si uno de sus extremos cae
      // dentro — que es exactamente el caso en el que sobrevivir no es un
      // problema (`D7.3`). Si la liga desde afuera, la asociación NO entra al
      // cierre y `deleteElementIn` responde `409`.
      const rootId = requirementField(payload, t.field, type);
      const elementIds = await collectSubtreeIds(tx, rootId, diagramId);
      const rows = await tx.umlRelationship.findMany({
        where: {
          diagramId,
          OR: [
            { sourceElementId: { in: elementIds } },
            { targetElementId: { in: elementIds } },
            { ends: { some: { elementId: { in: elementIds } } } },
          ],
        },
        select: { id: true },
      });
      const relationshipIds = [...new Set(rows.map((row) => row.id))];
      // Los OBJETIVOS DE LOCK son el cierre ENTERO — subárbol **y** relaciones
      // (SC-C14: «lock sobre el clasificador Y sobre cada relación incidente»).
      // Si acá solo viajaran los elementos, `canWrite()` no vería la asociación
      // que tiene Diego y el `element.delete` por devtools pasaría sin ser
      // denegado (V2 de la spec). `deleteClosure` conserva la separación
      // elementos/relaciones porque el borrado y la interfaz las necesitan
      // distintas.
      return {
        ids: [...new Set([...elementIds, ...relationshipIds])],
        deleteClosure: { ids: elementIds, relationshipIds },
      };
    }

    default: {
      // Con D2·C una variante desconocida NO llega a runtime: no compila.
      // Este `default` queda como red de último recurso para un objeto
      // construido fuera del tipo. Nunca `[]`.
      const _exhaustive: never = t;
      const detail = `${type}: variante de LockTarget desconocida en runtime — ${JSON.stringify(_exhaustive)}`;
      log.error(`LOCK_REQUIREMENTS mal derivada — ${detail}`);
      throw new LockTargetTableError(detail);
    }
  }
}

/**
 * El mismo chequeo que la rama `payload`, para las tres ramas que sí consultan:
 * el `field` tiene que existir y ser `string` ANTES de usarlo como `where`.
 * Extraído para no repetir el par `typeof`/`Logger.error` cuatro veces, y
 * porque el mensaje tiene que nombrar la fila exacta (tipo + campo) para que
 * el log sirva.
 */
function requirementField<T extends OperationType>(
  payload: PayloadFor<T>,
  field: LockTarget<T>['field'],
  type: T,
): string {
  const value = (payload as Record<string, unknown>)[field as string];
  if (typeof value !== 'string') {
    const detail = `${type}.${String(field)}: se esperaba un string en el payload, llegó ${typeof value}`;
    log.error(`LOCK_REQUIREMENTS mal derivada — ${detail}`);
    throw new LockTargetTableError(detail);
  }
  return value;
}

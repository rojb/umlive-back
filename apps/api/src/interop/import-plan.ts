import type {
  AggregationKind,
  ElementKind,
  FeatureKind,
  ParameterDirection,
  RelationshipKind,
  Visibility,
  XmiImportPreview,
  XmiImportWarning,
  XmiUnsupportedItem,
} from '@umlive/contracts';
import type { Tx } from '../prisma/tx.type';

/**
 * El `ImportPlan` y el **escritor tonto** (Fase 4, tarea 4.2).
 *
 * ── La propiedad central de todo el import (design.md §1) ──────────────────
 * El plan es **datos, no comportamiento**: una lista de filas YA RESUELTAS, en
 * orden de dependencia, con el reporte adjunto. Este archivo recorre ese plan y
 * hace `create`. **No evalúa una sola condición de negocio**: no valida, no
 * degrada, no descarta, no decide qué entra.
 *
 * Eso no es estilo: es lo que hace que el `ROLLBACK` sea la red y no el plan
 * (D1). Si la transacción no toma decisiones, no hay decisión que pueda hacerla
 * abortar. Toda política vive en `import-preflight.ts`, que corre ANTES del
 * `BEGIN` y sobre memoria; cuando este archivo arranca, el plan ya es válido
 * contra las diez constraints y la base no puede rechazar nada que no sea un
 * bug nuestro o una carrera (y para eso está el `ROLLBACK`, SC-E13).
 *
 * Lo único que este archivo SÍ hace, porque es mecánico y no una política, es
 * traducir las CLAVES internas del lector (`xmi:id`, y `assoc-class:<id>` para
 * la fila de clase de D7) a los UUID que la base genera.
 *
 * ── D8: la invariante de layout NO se puede perder acá ─────────────────────
 * `ElementsService.createElement` crea `uml_elements` **y** `element_layouts`
 * en la misma transacción, para TODOS los `ElementKind` — incluidos `PACKAGE` y
 * `COMMENT` (`uml/elements.service.ts:28-31`: *«un `UmlElement` sin fila de
 * layout es un elemento que el lienzo no puede ubicar»*). El importador escribe
 * por Prisma directo y ESQUIVA ese servicio, así que la invariante es
 * responsabilidad de ESTE archivo: el `create` del layout vive en el MISMO
 * cuerpo del bucle que el `create` del elemento, sin un solo `if` en el medio y
 * sin excepción de `kind`. No hay forma de crear un elemento y saltear su
 * layout sin romper el bucle a mano.
 *
 * Solo se ejecuta dentro de la transacción del `confirm`: no se llama nunca
 * desde `preview`, que no escribe (tarea 4.3).
 */

export interface PlannedLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** `extension` = geometría real del archivo; `auto_layout` = relleno de D8. */
  readonly source: 'extension' | 'auto_layout';
}

export interface PlannedElementRow {
  /** Clave interna del lector. Igual al `xmi:id`, salvo la fila de clase de D7. */
  readonly key: string;
  /** `xmi:id` de origen, LITERAL (FR-E14); `null` SOLO en la fila de clase de D7. */
  readonly xmiId: string | null;
  readonly parentKey: string | null;
  readonly kind: ElementKind;
  readonly name: string | null;
  readonly isAbstract: boolean;
  readonly stereotype: string | null;
  readonly body: string | null;
  readonly layout: PlannedLayout;
  /** D7: `xmi:id` de la relación a la que esta fila de clase se enlaza. */
  readonly associationClassOfXmiId: string | null;
}

export interface PlannedFeatureRow {
  readonly xmiId: string;
  readonly ownerKey: string;
  readonly kind: FeatureKind;
  readonly name: string;
  readonly visibility: Visibility;
  readonly typeName: string | null;
  /** Clave del elemento destino, o `null` si el tipo no se materializa. */
  readonly typeElementKey: string | null;
  readonly lowerBound: number;
  readonly upperBound: number | null;
  readonly position: number;
  readonly isStatic: boolean;
  readonly isReadonly: boolean;
  readonly isDerived: boolean;
  readonly isAbstract: boolean;
  readonly isQuery: boolean;
}

export interface PlannedParameterRow {
  readonly xmiId: string;
  readonly operationXmiId: string;
  readonly name: string;
  readonly direction: ParameterDirection;
  readonly typeName: string | null;
  readonly typeElementKey: string | null;
  readonly position: number;
}

export interface PlannedLiteralRow {
  readonly xmiId: string;
  readonly enumerationKey: string;
  readonly name: string;
  readonly position: number;
}

export interface PlannedRelationshipEndRow {
  readonly xmiId: string;
  readonly elementKey: string;
  readonly roleName: string | null;
  readonly lowerBound: number;
  readonly upperBound: number | null;
  readonly isNavigable: boolean;
  readonly aggregation: AggregationKind;
  readonly endIndex: number;
}

export interface PlannedRelationshipRow {
  readonly xmiId: string;
  readonly kind: RelationshipKind;
  readonly name: string | null;
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly ends: readonly PlannedRelationshipEndRow[];
  /** Clave de la fila de clase de D7, o `null`. */
  readonly associationClassKey: string | null;
}

export interface ImportPlan {
  readonly elements: readonly PlannedElementRow[];
  readonly features: readonly PlannedFeatureRow[];
  readonly parameters: readonly PlannedParameterRow[];
  readonly literals: readonly PlannedLiteralRow[];
  readonly relationships: readonly PlannedRelationshipRow[];
  /** Lo que NO entra, nombrado — incluye los descartes del lector y los del pre-vuelo. */
  readonly unsupported: readonly XmiUnsupportedItem[];
  /** Lo que entra DEGRADADO, nombrado. */
  readonly warnings: readonly XmiImportWarning[];
  readonly counts: XmiImportPreview['counts'];
  /**
   * Los `xmi:id` que el import va a CREAR, en las seis tablas que lo soportan
   * (FR-E14). El nivel C lo usa para detectar colisión con el destino (D9).
   */
  readonly incomingXmiIds: readonly string[];
}

export interface WrittenImport {
  /** Clave interna del plan → UUID generado. */
  readonly elementIdByKey: ReadonlyMap<string, string>;
  readonly elementCount: number;
  readonly featureCount: number;
  readonly relationshipCount: number;
}

/**
 * Clave → UUID, con fallo ruidoso. **No es una política**: si una clave no
 * está, el plan se armó mal (el pre-vuelo no cascadaó un descarte) y lo que
 * corresponde es que la transacción entera revierta con el error a la vista,
 * nunca escribir una FK en `null` y seguir. Es el caso exacto que D1 declara.
 */
function idOf(ids: ReadonlyMap<string, string>, key: string): string {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`import-plan: clave '${key}' sin fila creada — el pre-vuelo dejó una referencia colgada`);
  return id;
}

/**
 * Recorre el plan y escribe. **Cero condiciones de negocio.** El orden es el
 * del plan y no es decorativo: el lector lo emitió en orden de documento, así
 * que un padre siempre precede a sus hijos (`parent_id` resoluble en la misma
 * pasada, sin segunda vuelta ni actualización posterior).
 */
export async function writeImportPlan(tx: Tx, plan: ImportPlan, diagramId: string): Promise<WrittenImport> {
  const elementIdByKey = new Map<string, string>();
  // D7: `xmi:id` de la RELACIÓN (no la clave de la clase) → UUID del elemento
  // de clase. La relación guarda su `xmi:id` propio y `uml_relationships`
  // enlaza por ahí, así que la clave del mapa es el id de la relación.
  const classElementIdByRelationshipXmiId = new Map<string, string>();

  // 1) Elementos + su fila de LAYOUT, en el mismo cuerpo (D8, cierra 3.3).
  for (const row of plan.elements) {
    const element = await tx.umlElement.create({
      data: {
        diagramId,
        parentId: row.parentKey === null ? null : idOf(elementIdByKey, row.parentKey),
        kind: row.kind,
        name: row.name,
        isAbstract: row.isAbstract,
        stereotype: row.stereotype,
        body: row.body,
        xmiId: row.xmiId,
      },
      select: { id: true },
    });
    elementIdByKey.set(row.key, element.id);

    // Invariante D8: TODA fila de `uml_elements` lleva la suya — `PACKAGE` y
    // `COMMENT` incluidos. El escritor no decide: copia la geometría que el
    // lector ya resolvió (real o auto-acomodada).
    await tx.elementLayout.create({
      data: {
        elementId: element.id,
        x: row.layout.x,
        y: row.layout.y,
        width: row.layout.width,
        height: row.layout.height,
      },
    });

    if (row.associationClassOfXmiId !== null) {
      classElementIdByRelationshipXmiId.set(row.associationClassOfXmiId, element.id);
    }
  }

  // 2) Features (atributos y operaciones), con su dueño ya materializado.
  const featureIdByXmiId = new Map<string, string>();
  for (const row of plan.features) {
    const feature = await tx.umlFeature.create({
      data: {
        ownerId: idOf(elementIdByKey, row.ownerKey),
        kind: row.kind,
        name: row.name,
        visibility: row.visibility,
        position: row.position,
        typeElementId: row.typeElementKey === null ? null : idOf(elementIdByKey, row.typeElementKey),
        typeName: row.typeName,
        lowerBound: row.lowerBound,
        upperBound: row.upperBound,
        isStatic: row.isStatic,
        isReadonly: row.isReadonly,
        isDerived: row.isDerived,
        isAbstract: row.isAbstract,
        isQuery: row.isQuery,
        xmiId: row.xmiId,
      },
      select: { id: true },
    });
    featureIdByXmiId.set(row.xmiId, feature.id);
  }

  // 3) Parámetros, colgados de su operación.
  for (const row of plan.parameters) {
    await tx.umlParameter.create({
      data: {
        operationId: idOf(featureIdByXmiId, row.operationXmiId),
        name: row.name,
        direction: row.direction,
        position: row.position,
        typeElementId: row.typeElementKey === null ? null : idOf(elementIdByKey, row.typeElementKey),
        typeName: row.typeName,
        xmiId: row.xmiId,
      },
    });
  }

  // 4) Literales de enumeración.
  for (const row of plan.literals) {
    await tx.umlEnumLiteral.create({
      data: {
        enumerationId: idOf(elementIdByKey, row.enumerationKey),
        name: row.name,
        position: row.position,
        xmiId: row.xmiId,
      },
    });
  }

  // 5) Relaciones, con sus extremos. El enlace de D7 se resuelve por la clave
  //    de la fila de clase, que ya existe porque los elementos van primero.
  for (const row of plan.relationships) {
    const relationship = await tx.umlRelationship.create({
      data: {
        diagramId,
        kind: row.kind,
        sourceElementId: idOf(elementIdByKey, row.sourceKey),
        targetElementId: idOf(elementIdByKey, row.targetKey),
        name: row.name,
        xmiId: row.xmiId,
        associationClassId:
          row.associationClassKey === null ? null : classElementIdByRelationshipXmiId.get(row.xmiId) ?? null,
      },
      select: { id: true },
    });

    for (const end of row.ends) {
      await tx.umlRelationshipEnd.create({
        data: {
          relationshipId: relationship.id,
          endIndex: end.endIndex,
          elementId: idOf(elementIdByKey, end.elementKey),
          roleName: end.roleName,
          lowerBound: end.lowerBound,
          upperBound: end.upperBound,
          isNavigable: end.isNavigable,
          aggregation: end.aggregation,
          xmiId: end.xmiId,
        },
      });
    }
  }

  return {
    elementIdByKey,
    elementCount: plan.elements.length,
    featureCount: plan.features.length,
    relationshipCount: plan.relationships.length,
  };
}

import {
  XMI_IMPORT_NAME_MAX_LENGTH,
  XMI_IMPORT_WARNING,
  XMI_UNSUPPORTED_REASON,
  type ElementKind,
  type XmiImportWarning,
  type XmiUnsupportedItem,
  type XmiUnsupportedReason,
} from '@umlive/contracts';
import type { DiagramLockState } from '../generated/prisma/enums';
import { autoLayoutAt } from './auto-layout';
import type {
  ImportPlan,
  PlannedElementRow,
  PlannedFeatureRow,
  PlannedLayout,
  PlannedLiteralRow,
  PlannedParameterRow,
  PlannedRelationshipEndRow,
  PlannedRelationshipRow,
} from './import-plan';
import type { ParsedElement, ParsedFeature, ParsedLiteral, ParsedModel, ParsedParameter, ParsedRelationship } from './xmi-reader';

/**
 * Nivel B del import: el pre-vuelo de las DIEZ políticas (D2), en memoria,
 * contra el `ParsedModel` completo y **ANTES del `BEGIN`** — Fase 4, tarea 4.1.
 * Es el archivo más importante de la rebanada.
 *
 * ── Por qué existe (D2) ────────────────────────────────────────────────────
 * PostgreSQL **no puede** ser el validador del import, y la prueba está medida
 * en este mismo repositorio: `uml-errors.ts:160-221` documenta que un `P2039`
 * (violación de `CHECK`, `23514`) no trae `cause.constraint` —el nombre de la
 * constraint aparece solo como texto libre dentro de `originalMessage`— y la
 * identidad de la fila que falló no aparece en NINGÚN campo. FR-E16 exige
 * **nombre, tipo y `xmi:id`** de la construcción rechazada. La base no tiene
 * ninguno de los tres. La ruta «dejo que la base valide y traduzco el error»
 * no llega ni a la mitad del requisito, y además tira al `ROLLBACK` las otras
 * 99 filas correctas del mismo import.
 *
 * ── La regla de oro: NUNCA aborta ──────────────────────────────────────────
 * Cada violación se DEGRADA (entra, con una línea en `warnings`) o se DESCARTA
 * (no entra, con una línea en `unsupported`) y **siempre se nombra**. Este
 * módulo construye el `ImportPlan` — datos, no comportamiento— y no lanza
 * excepción por nada que venga del archivo.
 *
 * ── La cascada, y por qué cada descarte derivado se nombra ─────────────────
 * Descartar un elemento descarta en cascada, en memoria, todo lo que lo
 * referencia:
 *
 *   · sus features (y los parámetros de esas operaciones),
 *   · sus literales de enumeración,
 *   · sus elementos hijos (si el contenedor no entra, el hijo no tiene
 *     `parent_id` válido: se descarta en cascada y se nombra, en vez de
 *     re-parentarlo en silencio),
 *   · toda relación con un extremo apuntándolo.
 *
 * **Cada uno de esos descartes de segundo orden se nombra individualmente.**
 * Un descarte silencioso de segundo orden es exactamente el defecto que FR-E16
 * prohíbe: quien importa tiene que poder ver que su asociación no entró porque
 * entró de menos una de sus clases, no encontrarse el diagrama sin la línea.
 *
 * ── Las diez políticas (tabla D2) ──────────────────────────────────────────
 * 1. `ck_end_index`                     → DESCARTA la asociación n-aria
 * 2. `ck_composite_multiplicity`         → DEGRADA a `SHARED`
 * 3. `ck_element_abstract`               → DEGRADA `isAbstract = false`
 * 4. `uq_element_name_per_parent` (NULLS NOT DISTINCT) → DESCARTA el segundo
 * 5. `uq_attribute_name_per_owner`       → DESCARTA el segundo
 * 6. `uq_parameter_single_return`        → DESCARTA el segundo `return`
 * 7. `ck_feature_multiplicity`           → DEGRADA a `[0..*]`
 * 8. `ck_element_named`                  → DESCARTA el que no tiene nombre
 * 9. `ck_relationship_not_self_generalization` → DESCARTA la reflexiva
 * 10. `ck_layout_size`                   → DEGRADA (cubierto en Fase 3, y
 *                                         reafirmado acá como última línea)
 *
 * Y tres reglas transversales que hacen que el plan sea ESCRIBIBLE, todas del
 * mismo tipo que las diez (una fila no puede existir sin nombre; una FK no
 * puede apuntar a una fila que no se va a crear):
 *
 *   · `ck_feature_name` / `ck_parameter_name` / `ck_literal_name` — mismo
 *     criterio que `ck_element_named`, un nivel más abajo: sin nombre la fila
 *     no existe, así que se descarta y se nombra (razón `unnamed_element`).
 *   · tope de 120 caracteres del DTO compartido (hallazgo `operations-pipeline`
 *     RW-4): un nombre más largo se reporta y NUNCA se escribe.
 *   · `uml_relationships.source_element_id`/`target_element_id` son
 *     `NOT NULL`: una relación con un extremo que no resuelve a un elemento
 *     importable se descarta y se nombra.
 *
 * Es un módulo de funciones puras: no inyecta Prisma, no consulta, no escribe.
 * El escritor tonto es `import-plan.ts`; acá solo se DECIDE.
 */

/** Tope de nombre de los DTOs compartidos (RW-4). */
const MAX_NAME = XMI_IMPORT_NAME_MAX_LENGTH;

const CLASSIFIER_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['CLASS', 'INTERFACE', 'ENUMERATION', 'DATATYPE', 'PRIMITIVE_TYPE']);

/** El `xmi:type` de origen, para que el reporte diga lo mismo que el archivo. */
const UML_TYPE_BY_KIND: Readonly<Record<ElementKind, string>> = {
  PACKAGE: 'uml:Package',
  CLASS: 'uml:Class',
  INTERFACE: 'uml:Interface',
  ENUMERATION: 'uml:Enumeration',
  DATATYPE: 'uml:DataType',
  PRIMITIVE_TYPE: 'uml:PrimitiveType',
  COMMENT: 'uml:Comment',
};

/** Centinela de «sin contenedor». Las claves del lector nunca son vacías. */
const ROOT_CONTAINER = '~root';

/** `ck_element_named` usa `length(btrim(name)) > 0`: un nombre en blanco es tan ilegal como uno ausente. */
function isBlank(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

function containerName(element: ParsedElement): string {
  return element.name === null ? `el elemento sin nombre ${element.xmiId ?? ''}`.trim() : `«${element.name}»`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Nivel C — estado del destino (D9, D11). Es una función pura de este módulo
// porque D11 pide re-correr «la misma función en memoria del nivel B» contra el
// destino recién leído dentro de la transacción.
// ─────────────────────────────────────────────────────────────────────────────

export interface DestinationSnapshot {
  readonly mode: 'new' | 'existing';
  readonly diagramId: string | null;
  /** `false` = el diagrama destino ya no existe (borrado suave o físico). */
  readonly exists: boolean;
  /** `null` cuando el diagrama no existe (o en modo `'new'`). */
  readonly lockState: DiagramLockState | null;
  /** `xmi:id` ya presentes en el destino, en las seis tablas que lo soportan. */
  readonly xmiIds: readonly string[];
}

export type TargetChangeReason = 'lock_state_changed' | 'xmi_id_appeared' | 'diagram_deleted';

/**
 * ¿El destino cambió entre las dos lecturas? (D11). Devuelve el motivo, o
 * `null`. **El orden importa**: primero el destino que ya no está, después el
 * congelado que aparece o desaparece, y por último el `xmi:id` que se adelantó.
 */
export function detectTargetChange(
  before: DestinationSnapshot,
  after: DestinationSnapshot,
  incomingXmiIds: readonly string[],
): TargetChangeReason | null {
  if (!after.exists) return 'diagram_deleted';
  if (after.lockState !== before.lockState) return 'lock_state_changed';

  const beforeIds = new Set(before.xmiIds);
  const afterIds = new Set(after.xmiIds);
  for (const xmiId of incomingXmiIds) {
    if (afterIds.has(xmiId) && !beforeIds.has(xmiId)) return 'xmi_id_appeared';
  }
  return null;
}

/** Primer `xmi:id` entrante que YA existe en el destino (D9), o `null`. */
export function findXmiIdCollision(incomingXmiIds: readonly string[], destinationXmiIds: readonly string[]): string | null {
  const destination = new Set(destinationXmiIds);
  for (const xmiId of incomingXmiIds) {
    if (destination.has(xmiId)) return xmiId;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// El pre-vuelo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las diez políticas → el `ImportPlan`. Sin destino y sin Prisma: la decisión
 * depende SOLO del archivo, que es lo que permite correrla en el preview sin
 * abrir nada. (El nivel C usa `detectTargetChange`, más arriba, para lo que sí
 * depende del destino.)
 */
export function runImportPreflight(model: ParsedModel): ImportPlan {
  const unsupported: XmiUnsupportedItem[] = [...model.unsupported];
  const warnings: XmiImportWarning[] = [...model.warnings];

  const elementByKey = new Map<string, ParsedElement>();
  for (const element of model.elements) elementByKey.set(element.key, element);

  // Descartes (no entran). Un Set por colección: el nombre del descarte va al
  // reporte una sola vez aunque dos políticas quieran descartar lo mismo.
  const droppedElements = new Set<string>();
  const droppedFeatures = new Set<string>();
  const droppedParameters = new Set<string>();
  const droppedLiterals = new Set<string>();
  const droppedRelationships = new Set<string>();

  // Degradaciones (entran distintas). Idempotentes: cada política las llena una vez.
  const abstractDowngraded = new Set<string>();
  const compositeDowngraded = new Set<string>();
  const multiplicityDowngraded = new Set<string>();
  const layoutByKey = new Map<string, PlannedLayout>();

  function elementTypeOf(element: ParsedElement): string {
    // D7: la fila de clase de una `AssociationClass` viene de un `uml:AssociationClass`.
    if (element.associationClassOfXmiId !== null) return 'uml:AssociationClass';
    return UML_TYPE_BY_KIND[element.kind];
  }

  function elementLabel(element: ParsedElement): string {
    const id = element.xmiId ?? `clase de la asociación ${element.associationClassOfXmiId}`;
    return isBlank(element.name) ? `(sin nombre) ${id}` : `«${element.name}» (${id})`;
  }

  function dropElement(key: string, reason: XmiUnsupportedReason, detail: string): void {
    const element = elementByKey.get(key);
    if (element === undefined || droppedElements.has(key)) return;
    droppedElements.add(key);
    unsupported.push({ xmiId: element.xmiId, name: element.name, type: elementTypeOf(element), reason, detail });
  }

  function pushUnsupported(xmiId: string | null, name: string | null, type: string, reason: XmiUnsupportedReason, detail: string): void {
    unsupported.push({ xmiId, name, type, reason, detail });
  }

  function dropFeature(feature: ParsedFeature, reason: XmiUnsupportedReason, detail: string): void {
    if (droppedFeatures.has(feature.xmiId)) return;
    droppedFeatures.add(feature.xmiId);
    pushUnsupported(feature.xmiId, feature.name, feature.kind === 'OPERATION' ? 'uml:Operation' : 'uml:Property', reason, detail);
  }

  function dropParameter(parameter: ParsedParameter, reason: XmiUnsupportedReason, detail: string): void {
    if (droppedParameters.has(parameter.xmiId)) return;
    droppedParameters.add(parameter.xmiId);
    pushUnsupported(parameter.xmiId, parameter.name, 'uml:Parameter', reason, detail);
  }

  function dropLiteral(literal: ParsedLiteral, reason: XmiUnsupportedReason, detail: string): void {
    if (droppedLiterals.has(literal.xmiId)) return;
    droppedLiterals.add(literal.xmiId);
    pushUnsupported(literal.xmiId, literal.name, 'uml:EnumerationLiteral', reason, detail);
  }

  function dropRelationship(relationship: ParsedRelationship, reason: XmiUnsupportedReason, detail: string): void {
    if (droppedRelationships.has(relationship.xmiId)) return;
    droppedRelationships.add(relationship.xmiId);
    pushUnsupported(relationship.xmiId, relationship.name, `uml:${relationship.kind}`, reason, detail);
  }

  // ── Reglas de nombre, que valen para las cinco tablas con nombre ──────────

  /** Tope de 120 caracteres (RW-4): se reporta y NUNCA se escribe. */
  function policyNameCap(): void {
    for (const element of model.elements) {
      if (element.name !== null && element.name.length > MAX_NAME) {
        dropElement(element.key, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${element.name.length} caracteres y el tope de los DTOs es ${MAX_NAME}`);
      }
    }
    for (const feature of model.features) {
      if (feature.name.length > MAX_NAME) {
        dropFeature(feature, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${feature.name.length} caracteres y el tope es ${MAX_NAME}`);
      }
    }
    for (const parameter of model.parameters) {
      if (parameter.name.length > MAX_NAME) {
        dropParameter(parameter, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${parameter.name.length} caracteres y el tope es ${MAX_NAME}`);
      }
    }
    for (const literal of model.literals) {
      if (literal.name.length > MAX_NAME) {
        dropLiteral(literal, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${literal.name.length} caracteres y el tope es ${MAX_NAME}`);
      }
    }
    for (const relationship of model.relationships) {
      if (relationship.name !== null && relationship.name.length > MAX_NAME) {
        dropRelationship(relationship, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${relationship.name.length} caracteres y el tope es ${MAX_NAME}`);
      }
    }
  }

  /** 8 · `ck_element_named`: `COMMENT` exige `body`, el resto exige `name`. */
  function policyElementNamed(): void {
    for (const element of model.elements) {
      if (element.kind === 'COMMENT') {
        if (element.body === null) {
          // `ck_element_named` exige `body IS NOT NULL` para `kind = 'COMMENT'`;
          // un body vacío NO lo viola, así que la fila entra (degradar antes que
          // descartar cuando el diseño lo permite).
          dropElement(element.key, XMI_UNSUPPORTED_REASON.UNNAMED_ELEMENT, 'ck_element_named exige body NOT NULL para kind COMMENT: un comentario sin texto no tiene fila');
        }
        continue;
      }
      if (isBlank(element.name)) {
        dropElement(element.key, XMI_UNSUPPORTED_REASON.UNNAMED_ELEMENT, 'ck_element_named exige un nombre no vacío: un elemento sin nombre es legal en UML y no tiene fila acá');
      }
    }
  }

  /** `ck_feature_name` — el mismo criterio que `ck_element_named`, un nivel más abajo. */
  function policyFeatureNamed(): void {
    for (const feature of model.features) {
      if (isBlank(feature.name)) {
        dropFeature(feature, XMI_UNSUPPORTED_REASON.UNNAMED_ELEMENT, 'ck_feature_name exige un nombre no vacío');
      }
    }
  }

  /** `ck_parameter_name` — vale también para el `return`, que necesita nombre como cualquier otro. */
  function policyParameterNamed(): void {
    for (const parameter of model.parameters) {
      if (isBlank(parameter.name)) {
        dropParameter(parameter, XMI_UNSUPPORTED_REASON.UNNAMED_ELEMENT, 'ck_parameter_name exige un nombre no vacío');
      }
    }
  }

  /** `ck_literal_name`. */
  function policyLiteralNamed(): void {
    for (const literal of model.literals) {
      if (isBlank(literal.name)) {
        dropLiteral(literal, XMI_UNSUPPORTED_REASON.UNNAMED_ELEMENT, 'ck_literal_name exige un nombre no vacío');
      }
    }
  }

  // ── Las diez de la tabla D2 ───────────────────────────────────────────────

  /** 1 · `ck_end_index` (`end_index IN (0,1)`): una asociación n-aria no tiene fila. */
  function policyEndIndex(): void {
    for (const relationship of model.relationships) {
      if (relationship.kind !== 'ASSOCIATION') continue;
      if (relationship.ends.length === 2) continue;
      dropRelationship(
        relationship,
        XMI_UNSUPPORTED_REASON.NARY_ASSOCIATION,
        `la asociación tiene ${relationship.ends.length} extremos y ck_end_index solo admite end_index 0 y 1: el modelo no representa asociaciones n-arias`,
      );
    }
  }

  /** 2 · `ck_composite_multiplicity`: composición con `upper > 1` → `SHARED`. */
  function policyCompositeMultiplicity(): void {
    for (const relationship of model.relationships) {
      if (droppedRelationships.has(relationship.xmiId)) continue;
      for (const end of relationship.ends) {
        if (end.aggregation !== 'COMPOSITE') continue;
        if (end.upperBound !== null && end.upperBound <= 1) continue;
        if (compositeDowngraded.has(end.xmiId)) continue;
        compositeDowngraded.add(end.xmiId);
        warnings.push({
          xmiId: end.xmiId,
          name: end.roleName,
          code: XMI_IMPORT_WARNING.COMPOSITE_MULTIPLICITY_DEGRADED,
          detail: `ck_composite_multiplicity prohíbe una composición con upper ${end.upperBound === null ? '*' : end.upperBound}: entra como SHARED (una parte no puede pertenecer a muchos todos a la vez)`,
        });
      }
    }
  }

  /** 3 · `ck_element_abstract`: solo `CLASS` y `INTERFACE` pueden ser abstractos. */
  function policyElementAbstract(): void {
    for (const element of model.elements) {
      if (droppedElements.has(element.key)) continue;
      if (!element.isAbstract) continue;
      if (element.kind === 'CLASS' || element.kind === 'INTERFACE') continue;
      if (abstractDowngraded.has(element.key)) continue;
      abstractDowngraded.add(element.key);
      warnings.push({
        xmiId: element.xmiId,
        name: element.name,
        code: XMI_IMPORT_WARNING.ABSTRACT_NOT_ALLOWED,
        detail: `ck_element_abstract solo admite isAbstract sobre CLASS e INTERFACE: un ${elementTypeOf(element)} entra con isAbstract=false`,
      });
    }
  }

  /** 4 · `uq_element_name_per_parent` con `NULLS NOT DISTINCT`: se descarta el SEGUNDO (nunca se renombra). */
  function policyElementNameUniqueness(): void {
    const seen = new Set<string>();
    for (const element of model.elements) {
      if (droppedElements.has(element.key)) continue;
      // El índice es parcial (`WHERE kind <> 'COMMENT'`): los comentarios no compiten.
      if (element.kind === 'COMMENT') continue;
      const name = element.name ?? '';
      const key = `${element.parentKey ?? ROOT_CONTAINER}\u0000${name}`;
      if (seen.has(key)) {
        const parent = element.parentKey === null ? null : elementByKey.get(element.parentKey) ?? null;
        dropElement(
          element.key,
          XMI_UNSUPPORTED_REASON.DUPLICATE_NAME_PER_PARENT,
          `uq_element_name_per_parent (NULLS NOT DISTINCT) ya tiene un homónimo «${name}» en ${parent === null ? 'la raíz del diagrama' : containerName(parent)}: se descarta el segundo, jamás se renombra en silencio`,
        );
        continue;
      }
      seen.add(key);
    }
  }

  /** 5 · `uq_attribute_name_per_owner`: se descarta el segundo atributo homónimo del mismo dueño. */
  function policyAttributeNameUniqueness(): void {
    const seen = new Set<string>();
    for (const feature of model.features) {
      if (feature.kind !== 'ATTRIBUTE' || droppedFeatures.has(feature.xmiId)) continue;
      const key = `${feature.ownerKey}\u0000${feature.name}`;
      if (seen.has(key)) {
        dropFeature(feature, XMI_UNSUPPORTED_REASON.DUPLICATE_ATTRIBUTE_NAME, `uq_attribute_name_per_owner ya tiene un atributo «${feature.name}» en ese clasificador: se descarta el segundo`);
        continue;
      }
      seen.add(key);
    }
  }

  /** 6 · `uq_parameter_single_return`: se descarta el segundo `return`. */
  function policySingleReturn(): void {
    const seen = new Set<string>();
    for (const parameter of model.parameters) {
      if (parameter.direction !== 'RETURN' || droppedParameters.has(parameter.xmiId)) continue;
      if (seen.has(parameter.operationXmiId)) {
        dropParameter(parameter, XMI_UNSUPPORTED_REASON.DUPLICATE_PARAMETER_RETURN, 'uq_parameter_single_return admite un solo parámetro de retorno por operación: se descarta el segundo');
        continue;
      }
      seen.add(parameter.operationXmiId);
    }
  }

  /** `@@unique([enumerationId, name])`: mismo criterio que la política 4, sobre literales. */
  function policyLiteralNameUniqueness(): void {
    const seen = new Set<string>();
    for (const literal of model.literals) {
      if (droppedLiterals.has(literal.xmiId)) continue;
      const key = `${literal.enumerationKey}\u0000${literal.name}`;
      if (seen.has(key)) {
        dropLiteral(literal, XMI_UNSUPPORTED_REASON.DUPLICATE_NAME_PER_PARENT, `ya hay un literal «${literal.name}» en esa enumeración: se descarta el segundo`);
        continue;
      }
      seen.add(key);
    }
  }

  /** 7 · `ck_feature_multiplicity`: `lower >= 0 && (upper IS NULL || upper >= lower)` → si no, `[0..*]`. */
  function policyFeatureMultiplicity(): void {
    for (const feature of model.features) {
      if (droppedFeatures.has(feature.xmiId)) continue;
      const invalid = feature.lowerBound < 0 || (feature.upperBound !== null && feature.upperBound < feature.lowerBound);
      if (!invalid || multiplicityDowngraded.has(feature.xmiId)) continue;
      multiplicityDowngraded.add(feature.xmiId);
      warnings.push({
        xmiId: feature.xmiId,
        name: feature.name,
        code: XMI_IMPORT_WARNING.FEATURE_MULTIPLICITY_DEGRADED,
        detail: `ck_feature_multiplicity rechaza [${feature.lowerBound}..${feature.upperBound === null ? '*' : feature.upperBound}]: entra como [0..*]`,
      });
    }
  }

  /** 9 · `ck_relationship_not_self_generalization`. */
  function policySelfGeneralization(): void {
    for (const relationship of model.relationships) {
      if (relationship.kind !== 'GENERALIZATION') continue;
      if (relationship.sourceKey === null || relationship.sourceKey !== relationship.targetKey) continue;
      dropRelationship(relationship, XMI_UNSUPPORTED_REASON.SELF_GENERALIZATION, 'ck_relationship_not_self_generalization prohíbe una generalización reflexiva');
    }
  }

  /** Los extremos son `NOT NULL`: sin elemento importable del otro lado la relación no tiene fila. */
  function policyUnresolvableEndpoints(): void {
    for (const relationship of model.relationships) {
      if (droppedRelationships.has(relationship.xmiId)) continue;
      if (relationship.sourceKey === null || relationship.targetKey === null) {
        dropRelationship(
          relationship,
          XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT,
          'uml_relationships exige source_element_id y target_element_id: un extremo no resuelve a un elemento importable',
        );
        continue;
      }
      const danglingEnd = relationship.ends.find((end) => end.elementKey === null);
      if (danglingEnd !== undefined) {
        dropRelationship(relationship, XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, `el extremo ${danglingEnd.xmiId} no resuelve a un elemento importable y uml_relationship_ends.element_id es NOT NULL`);
      }
    }
  }

  /** 10 · `ck_layout_size`: geometría con `width <= 0 || height <= 0` → auto-layout de ESE elemento. */
  function policyLayoutSize(): void {
    for (const element of model.elements) {
      if (droppedElements.has(element.key)) continue;
      const { x, y, width, height, source } = element.layout;
      if (width > 0 && height > 0) {
        layoutByKey.set(element.key, { x, y, width, height, source });
        continue;
      }
      // Inalcanzable con el lector de Fase 3, que ya convierte todo lo
      // inutilizable (`Right <= Left`, `Bottom <= Top`) en auto-layout. Se
      // reafirma igual: es la última línea antes de `ck_layout_size` y el
      // costo de la redundancia es una comparación.
      const fallback = autoLayoutAt(element.documentIndex);
      warnings.push({
        xmiId: element.xmiId,
        name: element.name,
        code: XMI_IMPORT_WARNING.DEGENERATE_GEOMETRY,
        detail: `ck_layout_size exige width > 0 y height > 0: ${width}x${height} entra con auto-layout determinista (D8)`,
      });
      layoutByKey.set(element.key, { ...fallback, source: 'auto_layout' });
    }
  }

  // ── La cascada (regla transversal de D2) ──────────────────────────────────

  function cascade(): void {
    // Hijos: en orden de documento los padres SIEMPRE preceden a sus hijos
    // (el lector los materializa en pre-orden), así que una sola pasada
    // propaga el descarte por todo el subárbol.
    for (const element of model.elements) {
      if (droppedElements.has(element.key)) continue;
      if (element.parentKey === null || !droppedElements.has(element.parentKey)) continue;
      const parent = elementByKey.get(element.parentKey);
      dropElement(
        element.key,
        XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT,
        `su contenedor ${parent === undefined ? element.parentKey : elementLabel(parent)} se descartó, así que este elemento se descarta en cascada (no se re-parenta en silencio)`,
      );
    }

    for (const feature of model.features) {
      if (droppedFeatures.has(feature.xmiId) || !droppedElements.has(feature.ownerKey)) continue;
      const owner = elementByKey.get(feature.ownerKey);
      dropFeature(feature, XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, `su dueño ${owner === undefined ? feature.ownerKey : elementLabel(owner)} se descartó, así que la feature se descarta en cascada`);
    }

    for (const parameter of model.parameters) {
      if (droppedParameters.has(parameter.xmiId) || !droppedFeatures.has(parameter.operationXmiId)) continue;
      dropParameter(parameter, XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, 'la operación a la que pertenece se descartó, así que el parámetro se descarta en cascada');
    }

    for (const literal of model.literals) {
      if (droppedLiterals.has(literal.xmiId) || !droppedElements.has(literal.enumerationKey)) continue;
      const enumeration = elementByKey.get(literal.enumerationKey);
      dropLiteral(literal, XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, `la enumeración ${enumeration === undefined ? literal.enumerationKey : elementLabel(enumeration)} se descartó, así que el literal se descarta en cascada`);
    }

    for (const relationship of model.relationships) {
      if (droppedRelationships.has(relationship.xmiId)) continue;
      const danglingKey = relationshipDanglingKey(relationship);
      if (danglingKey === null) continue;
      const dropped = elementByKey.get(danglingKey);
      dropRelationship(
        relationship,
        XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT,
        `un extremo apunta a ${dropped === undefined ? danglingKey : elementLabel(dropped)}, que se descartó: la relación se descarta en cascada`,
      );
    }
  }

  /** Clave de un elemento referenciado por la relación que ya está descartado, o `null`. */
  function relationshipDanglingKey(relationship: ParsedRelationship): string | null {
    const candidates = [relationship.sourceKey, relationship.targetKey, ...relationship.ends.map((end) => end.elementKey)];
    for (const candidate of candidates) {
      if (candidate !== null && droppedElements.has(candidate)) return candidate;
    }
    return null;
  }

  // ── Orden de evaluación ───────────────────────────────────────────────────
  //
  // Es deliberado, no decorativo:
  //   1. lo que vuelve INAUDIBLE la fila por sí misma (nombre, tope de 120);
  //   2. la cascada, que propaga esos descartes por el subárbol;
  //   3. la UNICIDAD, que solo puede juzgarse sobre lo que va a entrar de
  //      verdad: si el primero de dos homónimos ya se cayó, el segundo es
  //      legítimo y descartarlo por «ser el segundo» perdería una clase sana;
  //   4. la cascada otra vez, porque la unicidad también descarta;
  //   5. las degradaciones, que no descartan nada y por eso van al final.
  policyNameCap();
  policyElementNamed();
  policyFeatureNamed();
  policyParameterNamed();
  policyLiteralNamed();
  cascade();

  policyElementNameUniqueness();
  policyAttributeNameUniqueness();
  policySingleReturn();
  policyLiteralNameUniqueness();
  policyEndIndex();
  policySelfGeneralization();
  policyUnresolvableEndpoints();
  cascade();

  policyCompositeMultiplicity();
  policyElementAbstract();
  policyFeatureMultiplicity();
  policyLayoutSize();

  // ── Plan ──────────────────────────────────────────────────────────────────

  /**
   * Un tipo apuntado a un elemento descartado deja la feature VIVA con el
   * NOMBRE del tipo y sin enlace (`type_element_id = null`). No es una pérdida
   * silenciosa: el descarte del elemento está nombrado en `unsupported`, y
   * `type_name` conserva lo que el atributo declaraba.
   */
  function resolveTypeReference(typeElementKey: string | null, typeName: string | null): { typeName: string | null; typeElementKey: string | null } {
    if (typeElementKey === null || !droppedElements.has(typeElementKey)) return { typeName, typeElementKey };
    const target = elementByKey.get(typeElementKey);
    return { typeName: target?.name ?? typeName, typeElementKey: null };
  }

  const elements: PlannedElementRow[] = [];
  for (const element of model.elements) {
    if (droppedElements.has(element.key)) continue;
    elements.push({
      key: element.key,
      xmiId: element.xmiId,
      parentKey: element.parentKey,
      kind: element.kind,
      name: element.name,
      isAbstract: abstractDowngraded.has(element.key) ? false : element.isAbstract,
      stereotype: element.stereotype,
      body: element.body,
      layout: layoutByKey.get(element.key) ?? { ...autoLayoutAt(element.documentIndex), source: 'auto_layout' },
      associationClassOfXmiId: element.associationClassOfXmiId,
    });
  }

  const features: PlannedFeatureRow[] = [];
  for (const feature of model.features) {
    if (droppedFeatures.has(feature.xmiId)) continue;
    const type = resolveTypeReference(feature.typeElementKey, feature.typeName);
    const degraded = multiplicityDowngraded.has(feature.xmiId);
    features.push({
      xmiId: feature.xmiId,
      ownerKey: feature.ownerKey,
      kind: feature.kind,
      name: feature.name,
      visibility: feature.visibility,
      typeName: type.typeName,
      typeElementKey: type.typeElementKey,
      lowerBound: degraded ? 0 : feature.lowerBound,
      upperBound: degraded ? null : feature.upperBound,
      position: feature.position,
      isStatic: feature.isStatic,
      isReadonly: feature.isReadonly,
      isDerived: feature.isDerived,
      isAbstract: feature.isAbstract,
      isQuery: feature.isQuery,
    });
  }

  const parameters: PlannedParameterRow[] = [];
  for (const parameter of model.parameters) {
    if (droppedParameters.has(parameter.xmiId)) continue;
    const type = resolveTypeReference(parameter.typeElementKey, parameter.typeName);
    parameters.push({
      xmiId: parameter.xmiId,
      operationXmiId: parameter.operationXmiId,
      name: parameter.name,
      direction: parameter.direction,
      typeName: type.typeName,
      typeElementKey: type.typeElementKey,
      position: parameter.position,
    });
  }

  const literals: PlannedLiteralRow[] = [];
  for (const literal of model.literals) {
    if (droppedLiterals.has(literal.xmiId)) continue;
    literals.push({ xmiId: literal.xmiId, enumerationKey: literal.enumerationKey, name: literal.name, position: literal.position });
  }

  const relationships: PlannedRelationshipRow[] = [];
  for (const relationship of model.relationships) {
    if (droppedRelationships.has(relationship.xmiId)) continue;
    const { sourceKey, targetKey } = relationship;
    if (sourceKey === null || targetKey === null) {
      // Inalcanzable: `policyUnresolvableEndpoints` ya la descartó. Si salta,
      // es un bug del pre-vuelo y tiene que verse, no escribirse en `null`.
      throw new Error(`import-preflight: la relación ${relationship.xmiId} llegó al plan sin extremos`);
    }
    const ends: PlannedRelationshipEndRow[] = [];
    for (const end of relationship.ends) {
      if (end.elementKey === null) {
        // Inalcanzable: `policyUnresolvableEndpoints` ya la descartó. Mismo
        // criterio que los extremos: un bug del pre-vuelo tiene que verse.
        throw new Error(`import-preflight: el extremo ${end.xmiId} de la relación ${relationship.xmiId} llegó al plan sin elemento`);
      }
      ends.push({
        xmiId: end.xmiId,
        elementKey: end.elementKey,
        roleName: end.roleName,
        lowerBound: end.lowerBound,
        upperBound: end.upperBound,
        isNavigable: end.isNavigable,
        aggregation: compositeDowngraded.has(end.xmiId) ? 'SHARED' : end.aggregation,
        endIndex: end.endIndex,
      });
    }
    relationships.push({
      xmiId: relationship.xmiId,
      kind: relationship.kind,
      name: relationship.name,
      sourceKey,
      targetKey,
      ends,
      // D7: si la fila de clase se descartó, la asociación sobrevive sin enlace.
      associationClassKey:
        relationship.associationClassKey !== null && !droppedElements.has(relationship.associationClassKey)
          ? relationship.associationClassKey
          : null,
    });
  }

  const incomingXmiIds = [
    ...elements.map((row) => row.xmiId),
    ...features.map((row) => row.xmiId),
    ...parameters.map((row) => row.xmiId),
    ...literals.map((row) => row.xmiId),
    ...relationships.map((row) => row.xmiId),
    ...relationships.flatMap((row) => row.ends.map((end) => end.xmiId)),
  ].filter((xmiId): xmiId is string => xmiId !== null);

  return {
    elements,
    features,
    parameters,
    literals,
    relationships,
    unsupported,
    warnings,
    counts: {
      classifiers: elements.filter((row) => CLASSIFIER_KINDS.has(row.kind)).length,
      relationships: relationships.length,
      features: features.length,
      withGeometry: elements.filter((row) => row.layout.source === 'extension').length,
      totalPositionable: elements.length,
    },
    incomingXmiIds: [...new Set(incomingXmiIds)].sort(),
  };
}

/**
 * Subconjunto del metamodelo UML 2.5 que soporta el producto.
 *
 * Espeja las enumeraciones nativas de PostgreSQL de `apps/api/prisma/schema.prisma`.
 * Si divergen, el compilador no avisa y el bug aparece al exportar XMI.
 * Cuando se toque una, se toca la otra.
 *
 * Especificación: SPECS.md §3 (SPEC-B)
 *
 * ── Ampliado por `uml-classifiers` (M2, rebanada 1 de 3) ────────────────────
 * Este archivo YA EXISTÍA desde el andamiaje original y `operations.ts` (el
 * protocolo de M3) ya lo importa y usa sus tipos en varios lugares — ver
 * cabecera de `operations.ts`. Lo de abajo son AGREGADOS: `*View` por
 * entidad, `DiagramContent`, un cuerpo de petición por función de mutación,
 * `EditableParameterDirection` y `UML_ERROR`. Nada de lo declarado arriba de
 * esta línea se modifica. Diseño: `openspec/changes/uml-classifiers/design.md`
 * §11. Especificación: `openspec/changes/uml-classifiers/specs/uml-classifiers-backend/spec.md`.
 */

import type { DiagramSummary } from './projects';

export type ElementKind =
  | 'PACKAGE' | 'CLASS' | 'INTERFACE' | 'ENUMERATION'
  | 'DATATYPE' | 'PRIMITIVE_TYPE' | 'COMMENT';

export type FeatureKind = 'ATTRIBUTE' | 'OPERATION';

export type RelationshipKind =
  | 'ASSOCIATION' | 'GENERALIZATION' | 'INTERFACE_REALIZATION'
  | 'DEPENDENCY' | 'USAGE';

export type Visibility = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'PACKAGE';
export type AggregationKind = 'NONE' | 'SHARED' | 'COMPOSITE';
export type ParameterDirection = 'IN' | 'OUT' | 'INOUT' | 'RETURN';

/** Marcas de visibilidad en notación UML 2.5. */
export const VISIBILITY_MARK: Record<Visibility, string> = {
  PUBLIC: '+', PRIVATE: '-', PROTECTED: '#', PACKAGE: '~',
};

/**
 * Multiplicidad. `upper: null` es `*`.
 *
 * Deliberadamente sin centinelas: un `-1` que signifique infinito se filtra
 * a las comparaciones y produce resultados absurdos en silencio.
 */
export interface Multiplicity {
  lower: number;
  upper: number | null;
}

export function formatMultiplicity(m: Multiplicity): string {
  const upper = m.upper === null ? '*' : String(m.upper);
  return m.lower === m.upper ? upper : `${m.lower}..${upper}`;
}

/**
 * Tipos primitivos reconocidos. Todo lo demás debe resolver a un elemento
 * modelado; si no resuelve, se REPORTA, no se adivina (SC-F09).
 */
export const PRIMITIVE_TYPES = [
  'String', 'int', 'Integer', 'long', 'Long', 'double', 'Double',
  'decimal', 'BigDecimal', 'boolean', 'Boolean',
  'date', 'LocalDate', 'datetime', 'LocalDateTime', 'uuid', 'UUID',
] as const;

export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export function isPrimitive(name: string): name is PrimitiveType {
  return (PRIMITIVE_TYPES as readonly string[]).includes(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vistas planas — lo que el servidor devuelve, una fila por entidad
// (design.md §8, §11). Sin árbol anidado: el cliente normaliza por id de
// todas formas, y M3 reusa el mismo formato para el snapshot `version = 0`.
// ─────────────────────────────────────────────────────────────────────────────

export interface UmlElementView {
  id: string;
  diagramId: string;
  parentId: string | null;
  kind: ElementKind;
  /** `null` solo para `kind: 'COMMENT'`, que usa `body` en su lugar. */
  name: string | null;
  isAbstract: boolean;
  stereotype: string | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UmlFeatureView {
  id: string;
  ownerId: string;
  kind: FeatureKind;
  name: string;
  visibility: Visibility;
  typeElementId: string | null;
  typeName: string | null;
  lowerBound: number;
  /** `null` significa `*`. Sin centinelas (SC-B02). */
  upperBound: number | null;
  position: number;
  defaultValue: string | null;
  isStatic: boolean;
  isReadonly: boolean;
  isDerived: boolean;
  isAbstract: boolean;
  isQuery: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UmlParameterView {
  id: string;
  operationId: string;
  name: string;
  direction: ParameterDirection;
  typeElementId: string | null;
  typeName: string | null;
  position: number;
  defaultValue: string | null;
}

export interface UmlEnumLiteralView {
  id: string;
  enumerationId: string;
  name: string;
  position: number;
}

export interface ElementLayoutView {
  elementId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

/**
 * Carga completa de un diagrama (design.md §8, FR-B09). Ocho colecciones
 * planas, cada una filtrada por relación hasta `diagramId` — nunca un árbol
 * anidado ni una lista de ids acumulada entre consultas. `features` viene
 * ordenada por `(ownerId, kind, position)` y `parameters` por
 * `(operationId, position)` — el orden es parte del contrato.
 *
 * `relationships`/`relationshipEnds`/`relationshipLayouts` los agregó
 * `uml-relationships` (ver el comentario del campo más abajo).
 */
export interface DiagramContent {
  diagram: DiagramSummary;
  elements: UmlElementView[];
  features: UmlFeatureView[];
  parameters: UmlParameterView[];
  enumLiterals: UmlEnumLiteralView[];
  layouts: ElementLayoutView[];
  /**
   * Agregado por `uml-relationships` (design.md §6, FR-B09). `relationshipEnds`
   * solo trae las de `ASSOCIATION` (D4), ordenadas por `(relationshipId,
   * endIndex)` — el orden es parte del contrato.
   *
   * Requeridas desde fase 3 (tasks.md 3.2): `diagram-content.service.ts` ya
   * las llena en las nueve consultas del `Promise.all`. Quedaron `?:` en
   * fase 1 (tasks.md 1.2) solo porque `DiagramContentService` todavía no las
   * poblaba — declararlas `required` en esa unidad habría roto la
   * compilación de `apps/api` antes de que existiera el service que las
   * llena. Esa razón ya no aplica: si quedaran opcionales acá, el contrato
   * mentiría sobre lo que el `GET` realmente devuelve.
   */
  relationships: UmlRelationshipView[];
  relationshipEnds: UmlRelationshipEndView[];
  relationshipLayouts: RelationshipLayoutView[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Cuerpos de petición — una interfaz por función de mutación (design.md §2,
// §2.1). El cuerpo NUNCA lleva el verbo ni el tipo del objetivo: el verbo
// vive en el nombre de la función y en método+ruta HTTP; el objetivo, en el
// UUID de la URL (requisito "Diecisiete funciones de mutación discretas").
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ParameterDirection` sigue exportando `'RETURN'` — espeja el enum nativo
 * de PostgreSQL y M5 (importación XMI) lo necesita. Pero ningún DTO de
 * mutación lo acepta: `AddParameterRequest`/`UpdateParameterRequest` usan
 * este tipo, no `ParameterDirection`, para que `RETURN` muera en
 * `class-validator` con `400` antes del servicio (design.md §7).
 */
export type EditableParameterDirection = Exclude<ParameterDirection, 'RETURN'>;

export interface CreateElementRequest {
  kind: ElementKind;
  /** `null` solo para `kind: 'COMMENT'`, que usa `body` en su lugar. */
  name: string | null;
  parentId: string | null;
  isAbstract?: boolean;
  stereotype?: string;
  body?: string;
  /**
   * Geometría inicial en la misma petición (design.md §2.1): el elemento
   * nace completo, con su layout, en una transacción. El mínimo se aplica
   * SOLO al tamaño — `x`/`y` no llevan mínimo (`ck_layout_size` es
   * `CHECK (width > 0 AND height > 0)`, nunca sobre la posición; el lienzo
   * usa el origen y coordenadas negativas normalmente).
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenameElementRequest {
  name: string;
}

export interface SetElementAbstractRequest {
  isAbstract: boolean;
}

export interface MoveElementRequest {
  x: number;
  y: number;
}

export interface ResizeElementRequest {
  width: number;
  height: number;
}

/**
 * `position` NO viaja acá: el servidor la asigna de forma creciente y
 * persistente por dueño al agregar (design.md, requisito "Alta de
 * clasificador con miembros ordenados"). Reordenar es una función aparte
 * (`ReorderFeaturesRequest`).
 */
export interface AddFeatureRequest {
  kind: FeatureKind;
  name: string;
  visibility: Visibility;
  typeElementId?: string | null;
  typeName?: string | null;
  lowerBound?: number;
  upperBound?: number | null;
  isStatic?: boolean;
  isReadonly?: boolean;
  isDerived?: boolean;
  isAbstract?: boolean;
  isQuery?: boolean;
  defaultValue?: string | null;
}

/** `kind` no es editable después de creado. */
export type UpdateFeatureRequest = Partial<Omit<AddFeatureRequest, 'kind'>>;

export interface ReorderFeaturesRequest {
  /** Orden completo, nunca un delta (evita estados intermedios inválidos). */
  orderedFeatureIds: string[];
}

/** `position` la asigna el servidor al agregar, igual que en `AddFeatureRequest`. */
export interface AddParameterRequest {
  name: string;
  direction: EditableParameterDirection;
  typeElementId?: string | null;
  typeName?: string | null;
  defaultValue?: string | null;
}

export type UpdateParameterRequest = Partial<AddParameterRequest>;

/**
 * Orden completo de TODOS los parámetros de la operación, nunca un delta.
 * El servicio valida antes de escribir que sea exactamente el conjunto
 * existente — ver `UML_ERROR.PARAMETER_SET_MISMATCH` más abajo.
 */
export interface ReorderParametersRequest {
  orderedParameterIds: string[];
}

/** `position` la asigna el servidor al agregar. */
export interface AddEnumLiteralRequest {
  name: string;
}

export interface ReorderEnumLiteralsRequest {
  orderedLiteralIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// AMPLIADO por `uml-relationships` (M2, rebanada 5 de 5, unidad 1/4 — fase 1)
// ─────────────────────────────────────────────────────────────────────────────
// Se AGREGA sobre lo existente — `operations.ts` (M3) ya importa de este
// archivo y NO se toca ni se sobrescribe. Diseño:
// `openspec/changes/uml-relationships/design.md` §6. Especificación:
// `.../specs/uml-relationships-backend/spec.md`.
// ─────────────────────────────────────────────────────────────────────────────

export interface Waypoint {
  x: number;
  y: number;
}

export interface UmlRelationshipView {
  id: string;
  diagramId: string;
  kind: RelationshipKind;
  /** FUENTE DE VERDAD del enrutado (D3). El cliente NUNCA enruta por `end.elementId`. */
  sourceElementId: string;
  targetElementId: string;
  name: string | null;
  stereotype: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SOLO existe para `kind: 'ASSOCIATION'` — dos filas, `endIndex` 0 y 1 (D4).
 * Los otros cuatro tipos no tienen extremos: sus cinco propiedades
 * (`roleName`, bounds, `isNavigable`, `aggregation`) son de
 * `Association::memberEnd` en UML 2.5 y no existen para `Generalization`,
 * `Dependency`, `Usage` ni `InterfaceRealization`, que quedan completamente
 * descritos por `sourceElementId`/`targetElementId` + `kind`.
 *
 * M5 (FR-E07): ramificar por `kind`, no por presencia de filas.
 */
export interface UmlRelationshipEndView {
  id: string;
  relationshipId: string;
  endIndex: 0 | 1;
  /** Espejo derivado de `UmlRelationshipView.{source,target}ElementId` (D3). */
  elementId: string;
  roleName: string | null;
  lowerBound: number;
  /** `null` es `*`. Sin centinelas. */
  upperBound: number | null;
  isNavigable: boolean;
  /** `COMPOSITE`/`SHARED` marcan el extremo que es el TODO; el rombo va acá (D5). */
  aggregation: AggregationKind;
}

export interface RelationshipLayoutView {
  relationshipId: string;
  waypoints: Waypoint[];
  sourceAnchor: string | null;
  targetAnchor: string | null;
}

/**
 * Una fila del cuerpo `409 { code: 'element_has_relationships' }` de
 * `deleteElement` (D6). El endpoint que la produce es fase 3
 * (`elements.service.ts`, tasks.md 3.1) — el tipo vive acá porque es parte
 * del contrato compartido de esta rebanada, no porque fase 1 lo consuma.
 *
 * `viaElementId`/`viaElementName` agregados por `uml-validation` (design.md
 * D2, Hallazgo 1 de su propuesta, tasks.md 0.2): qué elemento del SUBÁRBOL
 * sostiene la relación — igual al elemento borrado si es suya propia, o un
 * descendiente si el borrado es de un `PACKAGE`. `otherElementName` pasa a
 * calcularse RELATIVO a `viaElementId`, no al elemento borrado — si no,
 * borrar un paquete devolvía «la otra punta» de una relación que el paquete
 * no tiene.
 */
export interface IncidentRelationshipView {
  relationshipId: string;
  kind: RelationshipKind;
  name: string | null;
  /** Elemento del subárbol que sostiene la relación (design.md D2). */
  viaElementId: string;
  viaElementName: string | null;
  otherElementId: string;
  otherElementName: string | null;
}

// ── Cuerpos de petición — once mutaciones (design.md §3, "Superficie HTTP") ─
// Mismo criterio que el resto del archivo: el cuerpo nunca lleva el verbo ni
// el tipo del objetivo.

/** Un extremo dentro de `CreateRelationshipRequest.ends` — solo `ASSOCIATION` (D4). */
export interface CreateRelationshipEndRequest {
  roleName?: string | null;
  lowerBound: number;
  upperBound: number | null;
  isNavigable: boolean;
  aggregation: AggregationKind;
}

export interface CreateRelationshipRequest {
  kind: RelationshipKind;
  sourceElementId: string;
  targetElementId: string;
  name?: string | null;
  /**
   * MUST venir solo si `kind === 'ASSOCIATION'` (D4) — el servidor responde
   * `400` si `ends` viene junto con cualquier otro `kind`.
   */
  ends?: [CreateRelationshipEndRequest, CreateRelationshipEndRequest];
}

export interface RenameRelationshipRequest {
  name: string;
}

/** Reencaminar un extremo — comparte forma entre `.../source` y `.../target` (design.md §6). */
export interface RerouteRelationshipEndRequest {
  elementId: string;
  anchor?: string | null;
}

export interface SetEndRoleNameRequest {
  roleName: string | null;
}

export interface SetEndMultiplicityRequest {
  lowerBound: number;
  upperBound: number | null;
}

export interface SetEndNavigabilityRequest {
  isNavigable: boolean;
}

/**
 * Sin `upperBound` (D2, deliberado): `setEndAggregation` no puede ver el
 * `upperBound` ya guardado, y `ck_composite_multiplicity` es el ÚNICO punto
 * de aplicación de SC-B09 — un guard de DTO acá lo evitaría.
 */
export interface SetEndAggregationRequest {
  aggregation: AggregationKind;
}

export interface SetRelationshipWaypointsRequest {
  waypoints: Waypoint[];
}

export interface SetRelationshipAnchorsRequest {
  sourceAnchor: string | null;
  targetAnchor: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AMPLIADO por `uml-validation` (M2, rebanada 3 de 3 — fase 1)
// ─────────────────────────────────────────────────────────────────────────────
// Se AGREGA sobre lo existente, mismo criterio que `uml-relationships` arriba.
// Diseño: `openspec/changes/uml-validation/design.md` §3, §6, D10.
// Especificación: `.../specs/uml-validation-backend/spec.md`.
// ─────────────────────────────────────────────────────────────────────────────

export interface SetElementParentRequest {
  parentId: string | null;
}

export interface SetElementStereotypeRequest {
  stereotype: string | null;
}

export interface SetElementBodyRequest {
  body: string;
}

/** Cuerpo idéntico al de elemento — misma normalización en las dos rutas (D10). */
export interface SetRelationshipStereotypeRequest {
  stereotype: string | null;
}

/** Tope tras normalizar (design.md D10, spec "Estereotipo de texto libre"). */
export const MAX_STEREOTYPE_LENGTH = 64;

/**
 * Lanzada por `normalizeStereotype()` cuando el valor normalizado supera
 * `MAX_STEREOTYPE_LENGTH`. Clase propia, sin depender de ningún framework
 * (`packages/contracts` es "solo tipos y constantes, sin dependencias de
 * ejecución" — D5): el servidor la atrapa y la traduce a
 * `409 { code: 'stereotype_invalid' }`; M5 (importación XMI), que llama a
 * esta misma función fuera de los DTOs de esta rebanada, decide su propio
 * manejo.
 */
export class StereotypeTooLongError extends Error {
  constructor(public readonly normalizedLength: number) {
    super(`stereotype excede ${MAX_STEREOTYPE_LENGTH} caracteres tras normalizar (largo: ${normalizedLength})`);
    this.name = 'StereotypeTooLongError';
  }
}

/**
 * `trim` → quitar **un** par envolvente `«…»` → `trim` otra vez → `null` si
 * queda vacío → lanza `StereotypeTooLongError` si supera
 * `MAX_STEREOTYPE_LENGTH` tras normalizar (design.md D10). Los `«»` son
 * NOTACIÓN — el lienzo los agrega al dibujar; guardarlos haría de `entity` y
 * `«entity»` dos estereotipos distintos y filtraría presentación al XMI de
 * M5. Sin lista blanca ni normalización de mayúsculas (PRD §599).
 *
 * PURA, sin dependencias: el servidor la llama en `setElementStereotype`/
 * `setRelationshipStereotype` (mismas dos rutas), y M5 la llama otra vez al
 * escribir esta columna al importar XMI, fuera de estos DTOs.
 */
export function normalizeStereotype(raw: string | null): string | null {
  if (raw === null) return null;

  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('«') && value.endsWith('»')) {
    value = value.slice(1, -1).trim();
  }
  if (value.length === 0) return null;
  if (value.length > MAX_STEREOTYPE_LENGTH) {
    throw new StereotypeTooLongError(value.length);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errores propios de esta rebanada (design.md §6)
// ─────────────────────────────────────────────────────────────────────────────

export const UML_ERROR = {
  ELEMENT_NAME_TAKEN: 'element_name_taken',
  ATTRIBUTE_NAME_TAKEN: 'attribute_name_taken',
  ENUM_LITERAL_NAME_TAKEN: 'enum_literal_name_taken',
  /**
   * Inalcanzable desde la API de esta rebanada: ningún DTO de mutación
   * acepta `direction: 'RETURN'` (design.md §7, SC-B04 es aserción de
   * esquema). Se documenta igual porque M5 (importación XMI) sí escribe
   * parámetros `RETURN` fuera de estos DTOs y va a necesitar el código.
   */
  OPERATION_ALREADY_HAS_RETURN: 'operation_already_has_return',
  /**
   * El usuario no puede provocarlo: las posiciones las asigna el servidor.
   * Si aparece, es un bug de `reorderParameters` — el llamador MUST
   * responder `500`, nunca `409` (design.md §6).
   */
  PARAMETER_POSITION_CONFLICT: 'parameter_position_conflict',
  /** Guarda de `reorderParameters`: el conjunto recibido no coincide con el real (§5 de design.md). */
  PARAMETER_SET_MISMATCH: 'parameter_set_mismatch',

  // ── Agregados por `uml-relationships` (design.md §6, D1/D4/D6) ────────────
  /** `ck_relationship_not_self_generalization`: `GENERALIZATION` con `source = target`. */
  RELATIONSHIP_SELF_GENERALIZATION: 'relationship_self_generalization',
  /**
   * `ck_composite_multiplicity`: `aggregation === 'COMPOSITE'` con
   * `upperBound` > 1, `null` (`*`) o sin definir — los tres casos, un solo
   * código.
   */
  COMPOSITE_MULTIPLICITY_INVALID: 'composite_multiplicity_invalid',
  /** `ck_end_multiplicity`: `upperBound < lowerBound` en `setEndMultiplicity`. */
  END_MULTIPLICITY_INVALID: 'end_multiplicity_invalid',
  /**
   * `deleteElement` con relaciones incidentes (D6, fase 3). Cuerpo del `409`:
   * `{ code, count, relationships: IncidentRelationshipView[] }`.
   */
  ELEMENT_HAS_RELATIONSHIPS: 'element_has_relationships',

  // ── Agregados por `uml-validation` (design.md §3, D3, D4, D10) ────────────
  /**
   * `setElementParent`: el `parentId` propuesto está dentro del subárbol de
   * descendientes del elemento (incluido `parentId === elementId`), o
   * `ck_element_not_own_parent` alcanzado por una carrera (D3, `uml-errors.ts`).
   */
  CONTAINMENT_CYCLE: 'containment_cycle',
  /**
   * `setElementParent`: el `kind` del padre propuesto no admite al hijo por
   * su `kind` (D4). Cuerpo: `{ code, parentKind }`.
   */
  INVALID_PARENT_KIND: 'invalid_parent_kind',
  /** `setElementBody` sobre un elemento que no es `kind: 'COMMENT'` (§3). */
  BODY_REQUIRES_COMMENT: 'body_requires_comment',
  /**
   * `setElementStereotype`/`setRelationshipStereotype`: el valor supera
   * `MAX_STEREOTYPE_LENGTH` tras `normalizeStereotype()` (D10).
   */
  STEREOTYPE_INVALID: 'stereotype_invalid',
} as const;

export type UmlErrorCode = (typeof UML_ERROR)[keyof typeof UML_ERROR];

// ─────────────────────────────────────────────────────────────────────────────
// AMPLIADO por `uml-validation` (M2, rebanada 3 de 3 — fase 2)
// ─────────────────────────────────────────────────────────────────────────────
// Catálogo de validación (design.md D5, D7, D9; tasks.md 2.1). `VALIDATION_RULES`
// vive ACÁ (no en `apps/api`, ajuste sobre la propuesta — D5): servidor,
// lienzo y M5 leen la MISMA tabla de severidad. Precedente literal:
// `PROJECT_PERMISSIONS` en `projects.ts`.
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationSeverity = 'blocking' | 'warning';
export type ValidationEnforcement = 'query' | 'constraint' | 'mixed';

export type ValidationRuleId =
  | 'generalization_cycle'
  | 'interface_instance_attribute'
  | 'abstract_without_concrete'
  | 'duplicate_feature_signature'
  | 'composite_multiplicity'
  | 'dangling_relationship_end';

export interface ValidationRule {
  readonly severity: ValidationSeverity;
  readonly enforcedBy: ValidationEnforcement;
  /** Qué `409` ve el usuario cuando la regla se aplica al escribir. `null` si solo se marca (o si, como `dangling_relationship_end`, ningún DTO puede alcanzarla). */
  readonly writeErrorCode: UmlErrorCode | null;
  readonly source: string;
}

/**
 * Fuente ÚNICA de severidad (D5, D7) — servidor (`ValidationService`,
 * `report.blocking`), lienzo (color del marcador) y M5 (compuerta FR-F09)
 * leen ESTA tabla. Las dos reglas `enforcedBy: 'constraint'` NO ejecutan
 * consulta — devolverían siempre cero filas sobre datos ya almacenados
 * (Hallazgo 4). Se declaran igual porque `writeErrorCode` es lo que le
 * permite al panel decir "esto te dio 409 al escribir" sin adivinarlo.
 */
export const VALIDATION_RULES = {
  generalization_cycle: {
    severity: 'blocking',
    enforcedBy: 'query',
    writeErrorCode: null,
    source: 'SC-B10',
  },
  interface_instance_attribute: {
    severity: 'blocking',
    enforcedBy: 'query',
    writeErrorCode: null,
    source: 'SC-B11',
  },
  abstract_without_concrete: {
    severity: 'warning',
    enforcedBy: 'query',
    writeErrorCode: null,
    source: 'DATA-MODEL.md:942',
  },
  duplicate_feature_signature: {
    severity: 'blocking',
    // La mitad de atributos la hace imposible `uq_attribute_name_per_owner`
    // (parcial, `WHERE kind = 'ATTRIBUTE'`); la mitad de operaciones SÍ
    // consulta (Hallazgo 3, D8) — de ahí `mixed`, no `query` a secas.
    enforcedBy: 'mixed',
    writeErrorCode: null,
    source: 'Hallazgo 3, D8',
  },
  composite_multiplicity: {
    severity: 'blocking',
    enforcedBy: 'constraint',
    writeErrorCode: UML_ERROR.COMPOSITE_MULTIPLICITY_INVALID,
    source: 'SC-B09',
  },
  dangling_relationship_end: {
    severity: 'blocking',
    enforcedBy: 'constraint',
    // Sin `writeErrorCode`: ningún DTO puede provocarla — `sourceElementId`/
    // `targetElementId` son `NOT NULL` en todos los DTOs de creación, así
    // que la CHECK nunca se alcanza desde la API (Hallazgo 4). No hay un
    // `409` real que nombrar.
    writeErrorCode: null,
    source: 'FK NOT NULL + RESTRICT (Hallazgo 4)',
  },
} as const satisfies Record<ValidationRuleId, ValidationRule>;

export const isBlockingRule = (id: ValidationRuleId): boolean => VALIDATION_RULES[id].severity === 'blocking';

/**
 * Una fila del informe de validación. `ruleId`, NUNCA `severity` (D5,
 * Corolario): la severidad se resuelve leyendo `VALIDATION_RULES` — en
 * servidor y cliente por igual — para que no puedan divergir.
 *
 * `elements` siempre trae ≥1 elemento (FR-F09: cada hallazgo enlaza a un
 * nodo real del lienzo). Un ciclo de herencia de tres clases produce TRES
 * `ValidationFinding`, cada uno con exactamente un elemento — nunca uno con
 * los tres (D9).
 */
export interface ValidationFinding {
  ruleId: ValidationRuleId;
  elements: { id: string; qualifiedName: string | null }[];
  /** p. ej. `transferir(Cuenta, BigDecimal)` — `null` si la regla no arma detalle. */
  detail: string | null;
  /**
   * Agregado por `uml-validation` (verify-report W-6). Solo lo llena
   * `duplicate_feature_signature` — los `UmlFeature.id` de las operaciones
   * involucradas (≥2), en el mismo orden que `array_agg` de la consulta. Sin
   * esto, dos operaciones duplicadas comparten el mismo `detail` (misma
   * firma) y ni el cliente ni M5 pueden decir cuál de las dos sobra.
   * `undefined`/ausente para el resto de las reglas — no forma parte de su
   * contrato.
   */
  featureIds?: string[];
}

export interface ValidationReport {
  diagramId: string;
  generatedAt: string;
  findings: ValidationFinding[];
  /** Derivada en el servidor: `∃ finding` cuya regla es `severity: 'blocking'` (D6). Compuerta de FR-F09. */
  blocking: boolean;
}

/**
 * Pliegue hacia arriba por `parentId`, PURO — la misma función que usa el
 * servidor para nombrar elementos en los hallazgos y el cliente para el
 * árbol y las etiquetas de nodo (D3, D5 flujo de datos). `null` para
 * `kind: 'COMMENT'` (una nota no tiene nombre calificado — `name` es
 * siempre `null` para ese `kind`) y para cualquier id ausente del índice.
 *
 * Corta al repetir un id — NUNCA se cuelga, incluso sobre un ciclo de
 * contención preexistente (Hallazgo 5, D3): la guarda de escritura hace el
 * ciclo *raro*, no *imposible* bajo `READ COMMITTED` sin el registro de
 * locks de M4, y M5 puede importar un XMI que ya traiga uno. Devuelve el
 * camino PARCIAL construido hasta el corte, no `null` — un nombre parcial
 * es más útil que ninguno para depurar un ciclo real.
 */
export function qualifiedName(
  elementId: string,
  index: Record<string, Pick<UmlElementView, 'parentId' | 'name' | 'kind'>>,
): string | null {
  const start = index[elementId];
  if (!start || start.kind === 'COMMENT') return null;

  const segments: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = elementId;
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const node: Pick<UmlElementView, 'parentId' | 'name' | 'kind'> | undefined = index[currentId];
    if (!node || node.name === null) break;
    segments.unshift(node.name);
    currentId = node.parentId;
  }
  return segments.length > 0 ? segments.join('::') : null;
}

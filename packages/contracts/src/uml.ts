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
 * Carga completa de un diagrama (design.md §8, FR-B09). Cinco colecciones
 * planas, cada una filtrada por relación hasta `diagramId` — nunca un árbol
 * anidado ni una lista de ids acumulada entre consultas. `features` viene
 * ordenada por `(ownerId, kind, position)` y `parameters` por
 * `(operationId, position)` — el orden es parte del contrato.
 *
 * Sin `relationships`/`relationshipLayouts` en esta rebanada: son campos
 * NUEVOS que agrega `uml-relationships`, no campos vacíos.
 */
export interface DiagramContent {
  diagram: DiagramSummary;
  elements: UmlElementView[];
  features: UmlFeatureView[];
  parameters: UmlParameterView[];
  enumLiterals: UmlEnumLiteralView[];
  layouts: ElementLayoutView[];
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
} as const;

export type UmlErrorCode = (typeof UML_ERROR)[keyof typeof UML_ERROR];

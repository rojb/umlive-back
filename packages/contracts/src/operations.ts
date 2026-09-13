/**
 * Protocolo de operaciones — el contrato central del sistema.
 *
 * Una operación es la unidad atómica de cambio sobre un diagrama. El cliente
 * manda INTENCIÓN; el servidor valida, ordena, persiste y difunde (INV-1).
 *
 * Este archivo lo comparten la API y la web a propósito: si el protocolo
 * divergiera entre las dos mitades, los bugs aparecerían en producción y no
 * en el compilador.
 *
 * Especificación: SPECS.md §4 (SPEC-C)
 */

import type {
  AggregationKind,
  ElementKind,
  ParameterDirection,
  RelationshipKind,
  Visibility,
} from './uml';

// ─────────────────────────────────────────────────────────────────────────────
// Sobre
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el cliente envía. Todavía no es un hecho. */
export interface OperationRequest<T extends OperationType = OperationType> {
  /** UUID generado por el cliente. Clave de idempotencia (SC-C10, SC-C26). */
  opId: string;
  diagramId: string;
  /** Última versión que el cliente conocía al construir esta operación. */
  baseVersion: number;
  type: T;
  payload: PayloadFor<T>;
}

/** Lo que el servidor difunde. Ya es un hecho, con lugar en el orden. */
export interface OperationCommitted<T extends OperationType = OperationType> {
  opId: string;
  diagramId: string;
  /** Monótona por diagrama, sin huecos (SC-C09). */
  version: number;
  type: T;
  payload: PayloadFor<T>;
  actorId: string | null;
  actorKind: ActorKind;
  /** Presente solo si la produjo un turno del asistente (FR-D18). */
  aiTurnId?: string;
  committedAt: string;
}

export type ActorKind = 'USER' | 'AI' | 'IMPORT';

// ─────────────────────────────────────────────────────────────────────────────
// Rechazos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los motivos de rechazo siguen el orden de admisión de PRD Apéndice A.1:
 * del más barato y amplio al más caro y específico.
 */
export type RejectionReason =
  /** No es miembro del proyecto → 403 (INV-8) */
  | 'NOT_A_MEMBER'
  /** Es miembro pero su rol no alcanza → 403 */
  | 'ROLE_FORBIDDEN'
  /** El diagrama está congelado → 423. Alcanza al host y a la IA (SC-C19, SC-C20) */
  | 'DIAGRAM_FROZEN'
  /** Algún elemento lo tiene otro → 409 (SC-C02, SC-C08, SC-C14) */
  | 'ELEMENT_LOCKED'
  /** El modelo quedaría mal formado → 422 (SPEC-B) */
  | 'INVALID_MODEL'
  /** La operación no se entiende */
  | 'MALFORMED';

export interface OperationRejected {
  opId: string;
  diagramId: string;
  reason: RejectionReason;
  /** Texto para la persona, en su idioma. Nunca un código crudo. */
  message: string;
  /** Presente en ELEMENT_LOCKED: quién lo tiene. Denegar sin decir quién es el bug que FR-C04 evita. */
  holder?: LockHolder;
  /** Presente en INVALID_MODEL: qué regla se rompió y dónde. */
  violations?: ModelViolation[];
  /** Versión autoritativa actual, para que el cliente reconcilie tras revertir (SC-C12). */
  currentVersion: number;
}

export interface ModelViolation {
  rule: string;
  severity: 'blocking' | 'warning';
  message: string;
  elementIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloqueos
// ─────────────────────────────────────────────────────────────────────────────

export interface LockHolder {
  userId: string;
  displayName: string;
  /** Color de presencia. El borde del elemento en la pizarra usa este valor. */
  color: string;
}

export interface LockGranted {
  elementId: string;
  holder: LockHolder;
  /** ISO. El cliente muestra la cuenta regresiva a partir de esto. */
  expiresAt: string;
}

export interface LockDenied {
  elementId: string;
  holder: LockHolder;
}

export interface LockReleased {
  elementId: string;
  /** Para qué se soltó. Útil para distinguir un final normal de una caída. */
  cause: 'released' | 'expired' | 'disconnected' | 'frozen' | 'forced';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos de operación
// ─────────────────────────────────────────────────────────────────────────────

export type OperationType =
  | 'element.create'
  | 'element.update'
  | 'element.move'
  | 'element.resize'
  | 'element.delete'
  | 'feature.create'
  | 'feature.update'
  | 'feature.reorder'
  | 'feature.delete'
  | 'parameter.set'
  | 'literal.set'
  | 'relationship.create'
  | 'relationship.update'
  | 'relationship.reroute'
  | 'relationship.delete'
  | 'layout.waypoints';

export type PayloadFor<T extends OperationType> = T extends 'element.create'
  ? ElementCreate
  : T extends 'element.update'
    ? ElementUpdate
    : T extends 'element.move'
      ? ElementMove
      : T extends 'element.resize'
        ? ElementResize
        : T extends 'element.delete'
          ? ElementDelete
          : T extends 'feature.create'
            ? FeatureCreate
            : T extends 'feature.update'
              ? FeatureUpdate
              : T extends 'feature.reorder'
                ? FeatureReorder
                : T extends 'feature.delete'
                  ? IdOnly
                  : T extends 'parameter.set'
                    ? ParameterSet
                    : T extends 'literal.set'
                      ? LiteralSet
                      : T extends 'relationship.create'
                        ? RelationshipCreate
                        : T extends 'relationship.update'
                          ? RelationshipUpdate
                          : T extends 'relationship.reroute'
                            ? RelationshipReroute
                            : T extends 'relationship.delete'
                              ? IdOnly
                              : T extends 'layout.waypoints'
                                ? WaypointsSet
                                : never;

export interface IdOnly {
  id: string;
}

export interface ElementCreate {
  /** Lo genera el cliente para poder referenciarlo antes del ida y vuelta. */
  id: string;
  kind: ElementKind;
  name: string;
  parentId: string | null;
  isAbstract?: boolean;
  stereotype?: string;
  /** Los comentarios llevan cuerpo y no nombre. */
  body?: string;
  layout: Rect;
}

export interface ElementUpdate {
  id: string;
  name?: string;
  isAbstract?: boolean;
  stereotype?: string | null;
  body?: string;
}

export interface ElementMove {
  id: string;
  x: number;
  y: number;
}

export interface ElementResize {
  id: string;
  width: number;
  height: number;
}

/**
 * Borrar un clasificador exige lock sobre él Y sobre cada relación incidente,
 * atómicamente (SC-C14, SC-C15). El cliente manda las relaciones que cree que
 * hay; el servidor NO confía en esa lista: la recalcula. El campo existe para
 * que el cliente pueda pedir los locks antes de intentar.
 */
export interface ElementDelete {
  id: string;
  expectedIncidentRelationshipIds: string[];
}

export interface FeatureCreate {
  id: string;
  ownerId: string;
  kind: 'ATTRIBUTE' | 'OPERATION';
  name: string;
  visibility: Visibility;
  typeElementId?: string | null;
  typeName?: string | null;
  lowerBound?: number;
  /** null significa `*`. Sin centinelas (SC-B02). */
  upperBound?: number | null;
  position: number;
  isStatic?: boolean;
  isReadonly?: boolean;
  isDerived?: boolean;
  isAbstract?: boolean;
  isQuery?: boolean;
  defaultValue?: string | null;
}

export type FeatureUpdate = Partial<Omit<FeatureCreate, 'id' | 'ownerId' | 'kind'>> & {
  id: string;
};

export interface FeatureReorder {
  ownerId: string;
  /** Orden completo, no un delta. Evita estados intermedios inválidos. */
  orderedIds: string[];
}

export interface ParameterSet {
  operationId: string;
  parameters: Array<{
    id: string;
    name: string;
    direction: ParameterDirection;
    typeElementId?: string | null;
    typeName?: string | null;
    position: number;
    defaultValue?: string | null;
  }>;
}

export interface LiteralSet {
  enumerationId: string;
  literals: Array<{ id: string; name: string; position: number }>;
}

export interface RelationshipCreate {
  id: string;
  kind: RelationshipKind;
  sourceElementId: string;
  targetElementId: string;
  name?: string;
  /** Dos extremos para ASSOCIATION; vacío para las demás. */
  ends: RelationshipEndInput[];
  waypoints?: Point[];
}

export interface RelationshipEndInput {
  id: string;
  endIndex: 0 | 1;
  elementId: string;
  roleName?: string | null;
  lowerBound: number;
  upperBound: number | null;
  isNavigable: boolean;
  aggregation: AggregationKind;
}

export interface RelationshipUpdate {
  id: string;
  name?: string | null;
  ends?: RelationshipEndInput[];
}

export interface RelationshipReroute {
  id: string;
  endIndex: 0 | 1;
  newElementId: string;
}

export interface WaypointsSet {
  relationshipId: string;
  waypoints: Point[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Qué locks exige cada operación
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tabla del PRD Apéndice A.3, ejecutable.
 *
 * El cliente la usa para pedir los locks antes de intentar la operación, y así
 * evitar un ida y vuelta perdido. El servidor la vuelve a aplicar: esto es una
 * optimización de interfaz, nunca la autoridad.
 *
 * `[]` no significa "sin control de acceso" — la membresía, el rol y el
 * congelado se verifican igual. Significa que no hay contención de elemento.
 */
export const LOCK_REQUIREMENTS: Record<OperationType, LockRequirement> = {
  // Identidad nueva: nada con qué contender.
  'element.create': { targets: [] },
  'relationship.create': { targets: ['payload.sourceElementId', 'payload.targetElementId'] },

  // El lock del clasificador cubre sus rasgos por jerarquía (SC-C07).
  'element.update': { targets: ['payload.id'] },
  'element.move': { targets: ['payload.id'], note: 'Las relaciones se re-rutean solas (SC-C16)' },
  'element.resize': { targets: ['payload.id'] },
  'feature.create': { targets: ['payload.ownerId'] },
  'feature.update': { targets: ['owner(payload.id)'] },
  'feature.reorder': { targets: ['payload.ownerId'] },
  'feature.delete': { targets: ['owner(payload.id)'] },
  'parameter.set': { targets: ['owner(payload.operationId)'] },
  'literal.set': { targets: ['payload.enumerationId'] },

  // Atómico: si falta uno, se rechaza todo (SC-C14).
  'element.delete': { targets: ['payload.id', 'incidentRelationships(payload.id)'], atomic: true },

  'relationship.update': { targets: ['payload.id'] },
  'relationship.reroute': { targets: ['payload.id', 'payload.newElementId'] },
  'relationship.delete': { targets: ['payload.id'] },
  'layout.waypoints': { targets: ['payload.relationshipId'] },
};

export interface LockRequirement {
  /** Expresiones resueltas por el servidor contra el payload. */
  targets: string[];
  /** Si es true, la denegación de cualquiera rechaza la operación entera. */
  atomic?: boolean;
  note?: string;
}

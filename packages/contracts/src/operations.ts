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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Corrección 2026-09-18 (recuento tras M2) — `operations-pipeline`, fase 0.
 * ─────────────────────────────────────────────────────────────────────────
 * El recuento original de design.md (D1) daba 27 tipos para 27 cuerpos de
 * transacción (`elements` 6, `relationships` 10, `features` 4, `parameters`
 * 7), verificado ANTES de que `uml-validation` y `association-class`
 * aterrizaran. Reconfirmado con los mismos dos `rg` de D1, el 2026-09-18:
 *
 *   rg -c '\$transaction\('  → elements 9 / relationships 12 / features 4 / parameters 7  = 32
 *   rg -c '^  async [a-z]'   → elements 9 / relationships 13 / features 4 / parameters 7  = 33
 *
 * (33 funciones públicas, 32 cuerpos de transacción: `rerouteRelationshipSource`
 * y `rerouteRelationshipTarget` siguen delegando en el mismo `rerouteEnd`
 * privado — la diferencia de D1 se mantiene idéntica.)
 *
 * `uml-validation` agregó TRES funciones a `elements.service.ts`
 * (`setElementParent`, `setElementStereotype`, `setElementBody`) y `uml-errors.ts`
 * documenta un cuarto hallazgo (`ck_element_not_own_parent`, ver abajo).
 * `association-class` agregó DOS funciones a `relationships.service.ts`
 * (`setRelationshipStereotype`, `setAssociationClass`; la segunda la trae la
 * propia `association-class`, la primera es un hallazgo de `uml-validation`
 * sobre el archivo de relaciones — "la propuesta se olvidó de una ruta",
 * `relationships.service.ts:152-156`). `features.service.ts` y
 * `parameters.service.ts` NO cambiaron: siguen en 4/4 y 7/7.
 *
 * **CINCO `OperationType` nuevos, 27 → 32**, uno por cada función nueva:
 *
 *   `element.setParent`, `element.setStereotype`, `element.setBody`,
 *   `relationship.setStereotype`, `relationship.setAssociationClass`
 *
 * Esto también REVIERTE la contradicción #2 de la propuesta original
 * ("`ElementUpdate` declara `stereotype`/`body` y ninguna función los muta")
 * — ahora SÍ hay funciones dedicadas, así que el protocolo los expresa con
 * tipo propio en vez de dejarlos caer.
 *
 * `LOCK_REQUIREMENTS` (M4, `element-lock-enforcement/design.md` D2/D2-bis) se
 * escribe DIRECTAMENTE con la forma tipada (`LockTarget<T>`, unión
 * discriminada con `field: StringKeys<PayloadFor<T>>`) — nunca
 * `Record<OperationType, LockRequirement>` con expresiones de texto. Fijar la
 * forma ahora cuesta una línea; cambiarla después cuesta 32 filas más una
 * migración de forma (D2-bis).
 */

import type {
  AggregationKind,
  ElementKind,
  EditableParameterDirection,
  IncidentRelationshipView,
  RelationshipKind,
  UmlErrorCode,
  Visibility,
  Waypoint,
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
 * Los seis primeros siguen el orden de admisión de PRD Apéndice A.1: del más
 * barato y amplio al más caro y específico. Los TRES últimos son de
 * `operations-pipeline` y van al final porque son los únicos que exigen haber
 * abierto la transacción e intentado la mutación (design.md D8).
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
  /** El modelo quedaría mal formado → 422 (SPEC-B). Motivo de `uml-validation`, NO de acá. */
  | 'INVALID_MODEL'
  /** La operación no se entiende (forma, `opId` mal formado, eco de otro actor/tipo distinto) */
  | 'MALFORMED'
  /** Violó una restricción de la base. El ejemplo textual de SC-C11. */
  | 'CONSTRAINT_VIOLATION'
  /** Lo que direccionó no está (ya) en este diagrama. Carrera NORMAL, no un bug del cliente. */
  | 'TARGET_NOT_FOUND'
  /**
   * Fallo del servidor. ÚNICO motivo que obliga a un `Logger.error`. Existe
   * para que todo `op:submit` produzca EXACTAMENTE una salida: un cliente que
   * no recibe nada nunca revierte su mutación optimista (rebanada 4).
   */
  | 'INTERNAL';

/** Mismas formas que los cuerpos de los `409` HTTP, para reusar la copia ya escrita. */
export interface UmlErrorDetail {
  code: UmlErrorCode;
  /** Las violaciones de unicidad (p. ej. `element_name_taken`). */
  conflictingName?: string;
  /** `element_has_relationships`. */
  count?: number;
  /** `element_has_relationships`. */
  relationships?: IncidentRelationshipView[];
}

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
  /** CONSTRAINT_VIOLATION (y algunos MALFORMED): qué regla de dominio se rompió, con el cuerpo rico del 409 HTTP. */
  umlError?: UmlErrorDetail;
  /**
   * Versión autoritativa actual, para que el cliente reconcilie tras
   * revertir (SC-C12). Leída DESPUÉS del rollback: si otro confirmó
   * mientras tanto, el cliente necesita la versión de AHORA.
   *
   * Nota fechada 2026-09-18 (verify-report, RW-1): OPCIONAL a propósito.
   * Antes de esta corrección, un rechazo temprano del gateway (socket no
   * unido a la sala, miembro sin permiso vigente) leía `currentVersion` del
   * `diagramId` que mandaba el CLIENTE — un oráculo de versión/existencia
   * por UUID para un diagrama al que el remitente podía no tener acceso.
   * Ahora el campo SOLO viaja cuando la autorización para ESE diagrama ya
   * se confirmó (el remitente reconoce el diagrama, o su falta de acceso a
   * él es justo lo que se está rechazando). Un consumidor (`collaboration.
   * store.ts`, rebanada 3+) DEBE conservar la última `currentVersion`
   * conocida cuando el rechazo llega sin ella, nunca pisarla con `undefined`.
   */
  currentVersion?: number;
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
  /**
   * Para qué se soltó. Útil para distinguir un final normal de una caída.
   * `'removed_from_project'` es el default de
   * `LocksService.releaseAllForUserInDiagrams` (SC-A12). Faltaba en la
   * unión: el día que `MembersService.remove()` lo cablee emitiría un
   * `cause` que el cliente no sabe leer (reconnect-and-presence/design.md
   * §D1). No lleva `userId` a propósito: hay UN lock por `elementId`, así
   * que el cliente borra por clave (design.md §D12).
   */
  cause: 'released' | 'expired' | 'disconnected' | 'frozen' | 'forced' | 'removed_from_project';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tipos de operación — 32, uno por CUERPO de transacción (ver nota de cabecera)
// ─────────────────────────────────────────────────────────────────────────────

export type OperationType =
  | 'element.create'
  | 'element.rename'
  | 'element.setAbstract'
  | 'element.setParent'
  | 'element.setStereotype'
  | 'element.setBody'
  | 'element.move'
  | 'element.resize'
  | 'element.delete'
  | 'feature.create'
  | 'feature.update'
  | 'feature.delete'
  | 'feature.reorder'
  | 'parameter.add'
  | 'parameter.update'
  | 'parameter.remove'
  | 'parameter.reorder'
  | 'literal.add'
  | 'literal.remove'
  | 'literal.reorder'
  | 'relationship.create'
  | 'relationship.rename'
  | 'relationship.setStereotype'
  | 'relationship.setAssociationClass'
  | 'relationship.reroute'
  | 'relationship.delete'
  | 'relationshipEnd.setRoleName'
  | 'relationshipEnd.setMultiplicity'
  | 'relationshipEnd.setNavigability'
  | 'relationshipEnd.setAggregation'
  | 'layout.waypoints'
  | 'layout.anchors';

export interface IdOnly {
  id: string;
}

export interface ElementCreate {
  /**
   * INERTE: el servidor lo IGNORA. Existe solo por forma del sobre, jamás es
   * identidad — el único id válido es `committed.payload.id` (D5 de
   * `operations-pipeline`, contradicción #18 de `frontend-cutover`). No se
   * puede referenciar nada con este valor antes del ida y vuelta: la
   * creación NO es optimista y el cliente que lo tratara como identidad
   * inventaría un id fantasma.
   */
  id: string;
  kind: ElementKind;
  /** `null` SOLO para `kind: 'COMMENT'`: `ck_element_named` exige body en ese caso y nombre no vacío en el resto (#13). */
  name: string | null;
  parentId: string | null;
  isAbstract?: boolean;
  stereotype?: string;
  /** Los comentarios llevan cuerpo y no nombre. */
  body?: string;
  layout: Rect;
}

export interface ElementRename {
  id: string;
  name: string;
}

export interface ElementSetAbstract {
  id: string;
  isAbstract: boolean;
}

/** `uml-validation`. El padre solo se resuelve por el `kind` del HIJO — el `parentId` NUNCA es objetivo de lock (D1-bis de `element-lock-enforcement`). */
export interface ElementSetParent {
  id: string;
  parentId: string | null;
}

/** `uml-validation`. Mismo tope y normalización que `RelationshipSetStereotype` (D10). */
export interface ElementSetStereotype {
  id: string;
  stereotype: string | null;
}

/** `uml-validation`. Solo válido si `kind === 'COMMENT'` (comprobado en el servicio, no acá). */
export interface ElementSetBody {
  id: string;
  body: string;
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
  /** INERTE: el servidor lo IGNORA — el único id válido es `committed.payload.id` (contradicción #18 de `frontend-cutover`). El campo se queda por forma del sobre, nunca como identidad. */
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

export interface ParameterAdd {
  /** INERTE: el servidor lo IGNORA — el único id válido es `committed.payload.id` (contradicción #18 de `frontend-cutover`). El campo se queda por forma del sobre, nunca como identidad. */
  id: string;
  operationId: string;
  name: string;
  direction: EditableParameterDirection;
  typeElementId?: string | null;
  typeName?: string | null;
  defaultValue?: string | null;
  position: number;
}

export type ParameterUpdate = Partial<Omit<ParameterAdd, 'id' | 'operationId' | 'position'>> & {
  id: string;
};

export interface ParameterReorder {
  operationId: string;
  orderedIds: string[];
}

export interface LiteralAdd {
  /** INERTE: el servidor lo IGNORA — el único id válido es `committed.payload.id` (contradicción #18 de `frontend-cutover`). El campo se queda por forma del sobre, nunca como identidad. */
  id: string;
  enumerationId: string;
  name: string;
  position: number;
}

export interface LiteralReorder {
  enumerationId: string;
  orderedIds: string[];
}

/** Un extremo de `relationship.create` — solo con `kind: 'ASSOCIATION'` (D4). */
export interface RelationshipCreateEnd {
  roleName?: string | null;
  lowerBound: number;
  upperBound: number | null;
  isNavigable: boolean;
  aggregation: AggregationKind;
}

export interface RelationshipCreate {
  /** INERTE: el servidor lo IGNORA — el único id válido es `committed.payload.id` (contradicción #18 de `frontend-cutover`). Ver `ElementCreate.id` para el criterio completo. */
  id: string;
  kind: RelationshipKind;
  sourceElementId: string;
  targetElementId: string;
  name?: string | null;
  /** Dos extremos para ASSOCIATION; ausente para las demás (D4). */
  ends?: [RelationshipCreateEnd, RelationshipCreateEnd];
}

export interface RelationshipRename {
  id: string;
  name: string;
}

/** `uml-validation` — hallazgo sobre `uml-relationships` ("se olvidó de una ruta"). Mismo cuerpo que `ElementSetStereotype`. */
export interface RelationshipSetStereotype {
  id: string;
  stereotype: string | null;
}

/** `association-class`. `elementId: string` liga; `elementId: null` desliga (D5). */
export interface RelationshipSetAssociationClass {
  id: string;
  elementId: string | null;
}

/**
 * Cubre `rerouteRelationshipSource` (`endIndex: 0`) y `rerouteRelationshipTarget`
 * (`endIndex: 1`) — las dos delegan en el mismo `rerouteEnd` privado (D1).
 */
export interface RelationshipReroute {
  id: string;
  endIndex: 0 | 1;
  elementId: string;
  anchor?: string | null;
}

export type RelationshipDelete = IdOnly;

export interface RelationshipEndSetRoleName {
  relationshipId: string;
  endIndex: 0 | 1;
  roleName: string | null;
}

export interface RelationshipEndSetMultiplicity {
  relationshipId: string;
  endIndex: 0 | 1;
  lowerBound: number;
  upperBound: number | null;
}

export interface RelationshipEndSetNavigability {
  relationshipId: string;
  endIndex: 0 | 1;
  isNavigable: boolean;
}

/** Sin `upperBound` (D2 de `uml-relationships`): `ck_composite_multiplicity` es el único punto de aplicación de SC-B09. */
export interface RelationshipEndSetAggregation {
  relationshipId: string;
  endIndex: 0 | 1;
  aggregation: AggregationKind;
}

export interface LayoutWaypoints {
  relationshipId: string;
  waypoints: Waypoint[];
}

/** Texto libre sin interpretar (D7) — el servidor nunca lee ni valida el formato del ancla. */
export interface LayoutAnchors {
  relationshipId: string;
  sourceAnchor: string | null;
  targetAnchor: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Un `OperationType` sin fila acá no compila `PayloadFor`/`OperationHandlers`
 * (D5 del despachador). Es la mitad de la garantía que D1 documenta: el
 * compilador solo audita ESTE sentido.
 */
interface OperationPayloadMap {
  'element.create': ElementCreate;
  'element.rename': ElementRename;
  'element.setAbstract': ElementSetAbstract;
  'element.setParent': ElementSetParent;
  'element.setStereotype': ElementSetStereotype;
  'element.setBody': ElementSetBody;
  'element.move': ElementMove;
  'element.resize': ElementResize;
  'element.delete': ElementDelete;
  'feature.create': FeatureCreate;
  'feature.update': FeatureUpdate;
  'feature.delete': IdOnly;
  'feature.reorder': FeatureReorder;
  'parameter.add': ParameterAdd;
  'parameter.update': ParameterUpdate;
  'parameter.remove': IdOnly;
  'parameter.reorder': ParameterReorder;
  'literal.add': LiteralAdd;
  'literal.remove': IdOnly;
  'literal.reorder': LiteralReorder;
  'relationship.create': RelationshipCreate;
  'relationship.rename': RelationshipRename;
  'relationship.setStereotype': RelationshipSetStereotype;
  'relationship.setAssociationClass': RelationshipSetAssociationClass;
  'relationship.reroute': RelationshipReroute;
  'relationship.delete': RelationshipDelete;
  'relationshipEnd.setRoleName': RelationshipEndSetRoleName;
  'relationshipEnd.setMultiplicity': RelationshipEndSetMultiplicity;
  'relationshipEnd.setNavigability': RelationshipEndSetNavigability;
  'relationshipEnd.setAggregation': RelationshipEndSetAggregation;
  'layout.waypoints': LayoutWaypoints;
  'layout.anchors': LayoutAnchors;
}

export type PayloadFor<T extends OperationType> = OperationPayloadMap[T];

// ─────────────────────────────────────────────────────────────────────────────
// Qué locks exige cada operación (M4, `element-lock-enforcement`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cómo se llega desde el payload hasta el id que se bloquea.
 *
 * ⚠️ NO SIMPLIFICAR A `string[]` CON EXPRESIONES DE TEXTO. Con 16 tipos,
 * `owner(...)` recibía SIEMPRE un `featureId` — un salto, una tabla. Con 32
 * eso deja de ser cierto: `owner(payload.id)` en `parameter.update` recibe un
 * `parameterId` (DOS saltos, `uml_parameters → operation → owner_id`);
 * en `literal.remove` recibe un `literalId` (otra tabla, `uml_enum_literals`).
 * Un UUID no dice de qué tabla es, así que un intérprete de texto tendría que
 * ramificar por `OperationType` para resolverlo — y en ese momento la tabla
 * deja de ser la fuente de la respuesta y pasa a ser decoración
 * (`element-lock-enforcement/design.md` D2).
 *
 * `field` se coteja contra `PayloadFor<T>` vía `StringKeys`: un typo en un
 * nombre de campo es error de COMPILACIÓN, no una fila que deja de excluir
 * en silencio.
 */
export type LockTarget<T extends OperationType> =
  | { from: 'payload'; field: StringKeys<PayloadFor<T>> } // ya es el id
  | { from: 'featureOwner'; field: StringKeys<PayloadFor<T>> } // feature   → elemento
  | { from: 'parameterOwner'; field: StringKeys<PayloadFor<T>> } // parámetro → feature → elemento
  | { from: 'literalOwner'; field: StringKeys<PayloadFor<T>> } // literal   → enumeración
  | { from: 'incidentRelationships'; field: StringKeys<PayloadFor<T>> }; // elemento  → relaciones (0..n)

type StringKeys<P> = { [K in keyof P]-?: P[K] extends string ? K : never }[keyof P];

export interface LockRequirement<T extends OperationType> {
  targets: LockTarget<T>[];
  /** Si es true, la denegación de cualquiera rechaza la operación entera. */
  atomic?: boolean;
  note?: string;
}

/**
 * Tabla del PRD Apéndice A.3, ejecutable, extendida a las 32. Sin llamador en
 * esta rebanada (`canWrite()` es M4) — completarla acá es lo que exige
 * `element-lock-enforcement/design.md` D2-bis: la forma se fija ANTES de que
 * la tabla se escriba, que es el único momento barato.
 */
export const LOCK_REQUIREMENTS: { [T in OperationType]: LockRequirement<T> } = {
  // Identidad nueva: nada con qué contender.
  'element.create': { targets: [] },
  'element.rename': { targets: [{ from: 'payload', field: 'id' }] },
  'element.setAbstract': { targets: [{ from: 'payload', field: 'id' }] },
  'element.setParent': {
    targets: [{ from: 'payload', field: 'id' }],
    note: 'El padre NUNCA es objetivo (D1-bis de element-lock-enforcement): el lock de un paquete no protege su contenido futuro.',
  },
  'element.setStereotype': { targets: [{ from: 'payload', field: 'id' }] },
  'element.setBody': { targets: [{ from: 'payload', field: 'id' }] },
  'element.move': { targets: [{ from: 'payload', field: 'id' }], note: 'Las relaciones se re-rutean solas (SC-C16)' },
  'element.resize': { targets: [{ from: 'payload', field: 'id' }] },
  // Atómico: si falta uno, se rechaza todo (SC-C14).
  'element.delete': {
    targets: [{ from: 'payload', field: 'id' }, { from: 'incidentRelationships', field: 'id' }],
    atomic: true,
  },

  // El id que recibe la firma del servicio ya es el del elemento.
  'feature.create': { targets: [{ from: 'payload', field: 'ownerId' }] },
  'feature.update': { targets: [{ from: 'featureOwner', field: 'id' }] },
  'feature.delete': { targets: [{ from: 'featureOwner', field: 'id' }] },
  'feature.reorder': { targets: [{ from: 'payload', field: 'ownerId' }] },

  // `operationId` ya ES un feature — un salto para llegar al elemento.
  'parameter.add': { targets: [{ from: 'featureOwner', field: 'operationId' }] },
  'parameter.update': { targets: [{ from: 'parameterOwner', field: 'id' }], note: 'DOS saltos: uml_parameters → operation → owner_id' },
  'parameter.remove': { targets: [{ from: 'parameterOwner', field: 'id' }], note: 'DOS saltos' },
  'parameter.reorder': { targets: [{ from: 'featureOwner', field: 'operationId' }] },

  // `enumerationId` ya ES el elemento.
  'literal.add': { targets: [{ from: 'payload', field: 'enumerationId' }] },
  'literal.remove': { targets: [{ from: 'literalOwner', field: 'id' }], note: 'Un salto por OTRA tabla: uml_enum_literals → enumeration_id' },
  'literal.reorder': { targets: [{ from: 'payload', field: 'enumerationId' }] },

  'relationship.create': { targets: [{ from: 'payload', field: 'sourceElementId' }, { from: 'payload', field: 'targetElementId' }] },
  'relationship.rename': { targets: [{ from: 'payload', field: 'id' }] },
  'relationship.setStereotype': { targets: [{ from: 'payload', field: 'id' }] },
  'relationship.setAssociationClass': {
    targets: [{ from: 'payload', field: 'id' }],
    note: 'La clase asociación (payload.elementId) NO es objetivo: es nullable, StringKeys la excluye por construcción, y ligar/desligar no muta la clase en sí.',
  },
  'relationship.reroute': { targets: [{ from: 'payload', field: 'id' }, { from: 'payload', field: 'elementId' }], note: 'El extremo VIEJO no se bloquea (A.3)' },
  'relationship.delete': { targets: [{ from: 'payload', field: 'id' }] },

  'relationshipEnd.setRoleName': { targets: [{ from: 'payload', field: 'relationshipId' }] },
  'relationshipEnd.setMultiplicity': { targets: [{ from: 'payload', field: 'relationshipId' }] },
  'relationshipEnd.setNavigability': { targets: [{ from: 'payload', field: 'relationshipId' }] },
  'relationshipEnd.setAggregation': { targets: [{ from: 'payload', field: 'relationshipId' }] },

  'layout.waypoints': { targets: [{ from: 'payload', field: 'relationshipId' }] },
  'layout.anchors': { targets: [{ from: 'payload', field: 'relationshipId' }] },
};

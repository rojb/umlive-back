import type {
  DiagramSummary,
  ElementLayoutView,
  RelationshipLayoutView,
  UmlElementView,
  UmlEnumLiteralView,
  UmlFeatureView,
  UmlParameterView,
  UmlRelationshipEndView,
  UmlRelationshipView,
  Waypoint,
} from '@umlive/contracts';
import type {
  Diagram,
  ElementLayout,
  RelationshipLayout,
  UmlElement,
  UmlEnumLiteral,
  UmlFeature,
  UmlParameter,
  UmlRelationship,
  UmlRelationshipEnd,
} from '../generated/prisma/client';

/**
 * Mapeo Prisma row → vista de contrato (design.md §8, §11), factorizado una
 * sola vez porque `elements.service.ts`, `features.service.ts`,
 * `parameters.service.ts` y `diagram-content.service.ts` (fase 3/4) lo
 * necesitan idéntico. Funciones puras, sin dependencias de Nest — no es una
 * capa de dominio, es serialización (PRD §9: sin hexagonal).
 */

export function toDiagramSummary(d: Pick<Diagram, 'id' | 'name' | 'lockState' | 'currentVersion' | 'createdAt' | 'updatedAt'>): DiagramSummary {
  return {
    id: d.id,
    name: d.name,
    lockState: d.lockState,
    currentVersion: Number(d.currentVersion),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export function toElementView(e: UmlElement): UmlElementView {
  return {
    id: e.id,
    diagramId: e.diagramId,
    parentId: e.parentId,
    kind: e.kind,
    name: e.name,
    isAbstract: e.isAbstract,
    stereotype: e.stereotype,
    body: e.body,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function toFeatureView(f: UmlFeature): UmlFeatureView {
  return {
    id: f.id,
    ownerId: f.ownerId,
    kind: f.kind,
    name: f.name,
    visibility: f.visibility,
    typeElementId: f.typeElementId,
    typeName: f.typeName,
    lowerBound: f.lowerBound,
    upperBound: f.upperBound,
    position: f.position,
    defaultValue: f.defaultValue,
    isStatic: f.isStatic,
    isReadonly: f.isReadonly,
    isDerived: f.isDerived,
    isAbstract: f.isAbstract,
    isQuery: f.isQuery,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function toParameterView(p: UmlParameter): UmlParameterView {
  return {
    id: p.id,
    operationId: p.operationId,
    name: p.name,
    direction: p.direction,
    typeElementId: p.typeElementId,
    typeName: p.typeName,
    position: p.position,
    defaultValue: p.defaultValue,
  };
}

export function toLiteralView(l: UmlEnumLiteral): UmlEnumLiteralView {
  return {
    id: l.id,
    enumerationId: l.enumerationId,
    name: l.name,
    position: l.position,
  };
}

export function toLayoutView(l: ElementLayout): ElementLayoutView {
  return {
    elementId: l.elementId,
    x: l.x,
    y: l.y,
    width: l.width,
    height: l.height,
    zIndex: l.zIndex,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregado por `uml-relationships` (design.md §5, §6; tasks.md 2.9).
// ─────────────────────────────────────────────────────────────────────────────

export function toRelationshipView(r: UmlRelationship): UmlRelationshipView {
  return {
    id: r.id,
    diagramId: r.diagramId,
    kind: r.kind,
    sourceElementId: r.sourceElementId,
    targetElementId: r.targetElementId,
    name: r.name,
    stereotype: r.stereotype,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    // FR-B10 (`association-class`, D1) — agregado por esa rebanada.
    associationClassId: r.associationClassId,
  };
}

export function toRelationshipEndView(e: UmlRelationshipEnd): UmlRelationshipEndView {
  return {
    id: e.id,
    relationshipId: e.relationshipId,
    endIndex: e.endIndex as 0 | 1,
    elementId: e.elementId,
    roleName: e.roleName,
    lowerBound: e.lowerBound,
    upperBound: e.upperBound,
    isNavigable: e.isNavigable,
    aggregation: e.aggregation,
  };
}

/** `waypoints` es `Json` en Prisma (`RelationshipLayout.waypoints`) — la forma `{x, y}` la garantiza el DTO, nunca la base (D7). */
export function toRelationshipLayoutView(l: RelationshipLayout): RelationshipLayoutView {
  return {
    relationshipId: l.relationshipId,
    waypoints: (l.waypoints ?? []) as unknown as Waypoint[],
    sourceAnchor: l.sourceAnchor,
    targetAnchor: l.targetAnchor,
  };
}

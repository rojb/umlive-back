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
import { toDiagramSummary as toSharedDiagramSummary } from '../projects/diagram-summary';

/**
 * Mapeo Prisma row → vista de contrato (design.md §8, §11), factorizado una
 * sola vez porque `elements.service.ts`, `features.service.ts`,
 * `parameters.service.ts` y `diagram-content.service.ts` (fase 3/4) lo
 * necesitan idéntico. Funciones puras, sin dependencias de Nest — no es una
 * capa de dominio, es serialización (PRD §9: sin hexagonal).
 */

/**
 * ADAPTADOR sobre el mapper compartido (`concurrency-ux` D7), no una segunda
 * implementación: la vista de `DiagramSummary` se arma en UN solo lugar,
 * `projects/diagram-summary.ts`, y acá solo se completa lo que este llamador
 * no tiene.
 *
 * El único consumidor de esta firma es `diagram-content.service.ts` (el
 * snapshot del esqueleto), cuya consulta proyecta seis columnas y NO trae
 * `lockedAt`/`lockedByUser` — dos columnas que el mapper compartido exige.
 * Ese archivo no está entre las superficies de esta rebanada, así que acá se
 * pasan `null` explícitos y el snapshot sale con `freeze: null`.
 *
 * La consecuencia es acotada y deliberada: `DiagramContent.diagram` es el
 * esqueleto que el lienzo usa para dibujar, y **ningún** componente lee su
 * `freeze` (D6 de `concurrency-ux`: el cartel se alimenta solo de
 * `collaboration.store.frozen`, que viene de `diagram:frozen`). Un diagrama
 * congelado que se sincronice por el snapshot recibe el cartel por el evento,
 * en el mismo bloque síncrono que su `diagram:sync`. Cuando esa consulta se
 * ensanche (fuera de esta rebanada), esta función desaparece y el servicio
 * importa el mapper compartido directo.
 */
export function toDiagramSummary(d: Pick<Diagram, 'id' | 'name' | 'lockState' | 'currentVersion' | 'createdAt' | 'updatedAt'>): DiagramSummary {
  return toSharedDiagramSummary({ ...d, lockedAt: null, lockedByUser: null });
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

import type {
  DiagramSummary,
  ElementLayoutView,
  UmlElementView,
  UmlEnumLiteralView,
  UmlFeatureView,
  UmlParameterView,
} from '@umlive/contracts';
import type { Diagram, ElementLayout, UmlElement, UmlEnumLiteral, UmlFeature, UmlParameter } from '../generated/prisma/client';

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

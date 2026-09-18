import {
  XMI_EXPORT_NOTE,
  type DiagramContent,
  type ElementKind,
  type UmlElementView,
  type UmlEnumLiteralView,
  type UmlFeatureView,
  type UmlParameterView,
  type UmlRelationshipEndView,
  type UmlRelationshipView,
  type XmiExportNote,
} from '@umlive/contracts';
import { att, type XmiAttr, type XmiEmitter } from './xmi-emitter';
import type { IdentityMap } from './xmi-identity';
import type { TypeResolver } from './xmi-types';

/**
 * Mapeo E.2 completo (Apéndice E del PRD) + fusión D5 de `AssociationClass`.
 *
 * **Este archivo NO recibe la estrategia de versión** (D4). No está en su
 * firma, así que no puede leerla ni por accidente: la ausencia de ramas por
 * versión es una propiedad ESTRUCTURAL, no una disciplina. Lo único que este
 * archivo conoce es el emisor, el `IdentityMap` (D1/D2) y el `TypeResolver`
 * (D3).
 *
 * El orden del documento es el orden de las consultas de
 * `uml/diagram-content.service.ts`, propagado por un agrupado por `parentId`
 * de UNA pasada: no hay `sort` ni reinserción, así que es estable por
 * construcción (y `assertOrderContract` afirma el supuesto con el que eso
 * cuenta).
 *
 * `defaultValue` (de `UmlFeatureView`/`UmlParameterView`) y los `waypoints` de
 * `RelationshipLayoutView` NO tienen fila en E.2 y no hay código de nota para
 * ellos: se omiten y se declaran como huecos en el informe de la rebanada, en
 * vez de inventarles una forma.
 */

/** `ElementKind` → `xmi:type`. `COMMENT` no está: se emite como `ownedComment`, no como `packagedElement`. */
const XMI_TYPE_BY_KIND: Readonly<Record<Exclude<ElementKind, 'COMMENT'>, string>> = {
  PACKAGE: 'uml:Package',
  CLASS: 'uml:Class',
  INTERFACE: 'uml:Interface',
  ENUMERATION: 'uml:Enumeration',
  DATATYPE: 'uml:DataType',
  PRIMITIVE_TYPE: 'uml:PrimitiveType',
};

/** Clases que pueden alojar `ownedAttribute`/`ownedEnd`/`generalization` según el metamodelo UML 2.5. */
const CLASSIFIER_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'CLASS',
  'INTERFACE',
  'ENUMERATION',
  'DATATYPE',
  'PRIMITIVE_TYPE',
]);

const DIRECTION_TOKEN: Readonly<Record<UmlParameterView['direction'], string>> = {
  IN: 'in',
  OUT: 'out',
  INOUT: 'inout',
  RETURN: 'return',
};

const AGGREGATION_TOKEN: Readonly<Record<UmlRelationshipEndView['aggregation'], string>> = {
  NONE: 'none',
  SHARED: 'shared',
  COMPOSITE: 'composite',
};

export interface SerializeInput {
  readonly contents: readonly DiagramContent[];
  readonly identity: IdentityMap;
  readonly types: TypeResolver;
}

export interface SerializeOutcome {
  readonly counts: {
    readonly elements: number;
    readonly relationships: number;
    readonly associationClassesMerged: number;
  };
  readonly notes: readonly XmiExportNote[];
}

interface Tally {
  elements: number;
  relationships: number;
  associationClassesMerged: number;
}

interface DiagramIndex {
  readonly content: DiagramContent;
  readonly elementsById: Map<string, UmlElementView>;
  readonly childrenByParent: Map<string | null, UmlElementView[]>;
  readonly featuresByOwner: Map<string, UmlFeatureView[]>;
  readonly parametersByOperation: Map<string, UmlParameterView[]>;
  readonly literalsByEnumeration: Map<string, UmlEnumLiteralView[]>;
  readonly layoutElementIds: ReadonlySet<string>;
  readonly endsByRelationship: Map<string, UmlRelationshipEndView[]>;
  /** Extremos NAVEGABLES, indexados por el elemento que los posee como `ownedAttribute` (E.2 / E.5 trampa 5). */
  readonly navigableEndsByElement: Map<string, UmlRelationshipEndView[]>;
}

export function serializeModel(emitter: XmiEmitter, input: SerializeInput): SerializeOutcome {
  const notes: XmiExportNote[] = [];
  const tally: Tally = { elements: 0, relationships: 0, associationClassesMerged: 0 };

  for (const content of input.contents) {
    const index = indexDiagram(content, input.identity.suppressedElementIds());
    const packageId = input.identity.packageId(content.diagram.id);
    emitter.subject(packageId);
    emitter.open('packagedElement', [att('xmi:type', 'uml:Package'), att('xmi:id', packageId), att('name', content.diagram.name)]);

    for (const child of index.childrenByParent.get(null) ?? []) {
      emitElement(emitter, index, input, child, notes, tally);
    }

    // Dependencias y usos: E.2 los mapea a `packagedElement`. Se emiten al
    // nivel del paquete del diagrama (decisión de esta rebanada: el diseño no
    // fija su posición; el paquete del diagrama es el menos sorprendente).
    for (const relationship of index.content.relationships) {
      if (relationship.kind === 'DEPENDENCY' || relationship.kind === 'USAGE') {
        emitDependency(emitter, input, relationship, notes, tally);
      } else if (relationship.kind === 'ASSOCIATION') {
        emitAssociation(emitter, index, input, relationship, notes, tally);
      }
    }

    emitter.close('packagedElement');
  }

  return {
    counts: { elements: tally.elements, relationships: tally.relationships, associationClassesMerged: tally.associationClassesMerged },
    notes,
  };
}

function indexDiagram(content: DiagramContent, suppressed: ReadonlySet<string>): DiagramIndex {
  const elementsById = new Map<string, UmlElementView>();
  const parentOf = new Map<string, string | null>();
  const featuresByOwner = new Map<string, UmlFeatureView[]>();
  const parametersByOperation = new Map<string, UmlParameterView[]>();
  const literalsByEnumeration = new Map<string, UmlEnumLiteralView[]>();
  const endsByRelationship = new Map<string, UmlRelationshipEndView[]>();
  const navigableEndsByElement = new Map<string, UmlRelationshipEndView[]>();

  for (const element of content.elements) {
    elementsById.set(element.id, element);
    parentOf.set(element.id, element.parentId);
  }

  // Una pasada, sin `sort`: el orden de las consultas ES el orden del documento.
  const childrenByParent = new Map<string | null, UmlElementView[]>();
  for (const element of content.elements) {
    push(childrenByParent, effectiveParent(element.id, parentOf, suppressed), element);
  }

  for (const feature of content.features) push(featuresByOwner, feature.ownerId, feature);
  for (const parameter of content.parameters) push(parametersByOperation, parameter.operationId, parameter);
  for (const literal of content.enumLiterals) push(literalsByEnumeration, literal.enumerationId, literal);
  for (const end of content.relationshipEnds) push(endsByRelationship, end.relationshipId, end);

  for (const end of content.relationshipEnds) {
    const participant = elementsById.get(end.elementId);
    if (end.isNavigable && participant !== undefined && CLASSIFIER_KINDS.has(participant.kind)) {
      push(navigableEndsByElement, end.elementId, end);
    }
  }

  return {
    content,
    elementsById,
    childrenByParent,
    featuresByOwner,
    parametersByOperation,
    literalsByEnumeration,
    layoutElementIds: new Set(content.layouts.map((layout) => layout.elementId)),
    endsByRelationship,
    navigableEndsByElement,
  };
}

/** D5: los hijos de una clase suprimida se reparentan al padre de esa clase (corta si hubiera un ciclo). */
function effectiveParent(id: string, parentOf: ReadonlyMap<string, string | null>, suppressed: ReadonlySet<string>): string | null {
  const seen = new Set<string>([id]);
  let parent = parentOf.get(id) ?? null;
  while (parent !== null && suppressed.has(parent)) {
    if (seen.has(parent)) return null;
    seen.add(parent);
    parent = parentOf.get(parent) ?? null;
  }
  return parent;
}

function emitElement(emitter: XmiEmitter, index: DiagramIndex, input: SerializeInput, element: UmlElementView, notes: XmiExportNote[], tally: Tally): void {
  if (input.identity.suppressedElementIds().has(element.id)) return;
  const xmiId = input.identity.forElement(element.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  if (!index.layoutElementIds.has(element.id)) {
    notes.push(note(XMI_EXPORT_NOTE.ELEMENT_WITHOUT_LAYOUT, xmiId, `el elemento ${element.id} no tiene fila en element_layouts`));
  }
  if (element.stereotype !== null) {
    notes.push(note(XMI_EXPORT_NOTE.STEREOTYPE_NOT_IN_MODEL, xmiId, `stereotype '${element.stereotype}' del elemento '${element.name ?? element.id}'`));
  }

  if (element.kind === 'COMMENT') {
    notes.push(note(XMI_EXPORT_NOTE.COMMENT_WITHOUT_ANNOTATED_ELEMENT, xmiId, `el COMMENT ${element.id} no tiene columna de anotación: parent_id es su contenedor, no lo anotado`));
    const commentAttrs: XmiAttr[] = [att('xmi:type', 'uml:Comment'), att('xmi:id', xmiId)];
    if (element.body !== null) commentAttrs.push(att('body', element.body));
    emitter.leaf('ownedComment', commentAttrs);
    tally.elements += 1;
    return;
  }

  const attrs: XmiAttr[] = [att('xmi:type', XMI_TYPE_BY_KIND[element.kind]), att('xmi:id', xmiId)];
  if (element.name !== null) attrs.push(att('name', element.name));
  // E.2 lista `isAbstract` solo para Class. Se emite también para Interface:
  // es un atributo de `Classifier` en el metamodelo, la base solo deja abstraer
  // a esas dos, y omitirlo en una interfaz abstracta sería pérdida silenciosa.
  if (element.isAbstract && (element.kind === 'CLASS' || element.kind === 'INTERFACE')) attrs.push(att('isAbstract', 'true'));

  emitter.open('packagedElement', attrs);
  emitClassifierBody(emitter, index, input, element, tally);
  for (const child of index.childrenByParent.get(element.id) ?? []) {
    emitElement(emitter, index, input, child, notes, tally);
  }
  emitter.close('packagedElement');
  tally.elements += 1;
}

/**
 * Orden fijo del cuerpo de un clasificador: features propias → literales
 * (solo enumeraciones) → extremos navegables que lo poseen como
 * `ownedAttribute` → `generalization`/`interfaceRealization` → hijos.
 */
function emitClassifierBody(emitter: XmiEmitter, index: DiagramIndex, input: SerializeInput, element: UmlElementView, tally: Tally): void {
  for (const feature of index.featuresByOwner.get(element.id) ?? []) {
    if (feature.kind === 'ATTRIBUTE') emitAttribute(emitter, input, feature);
    else emitOperation(emitter, index, input, feature);
  }

  for (const literal of index.literalsByEnumeration.get(element.id) ?? []) emitEnumLiteral(emitter, input, literal);

  for (const end of index.navigableEndsByElement.get(element.id) ?? []) emitEndProperty(emitter, input, end);

  if (CLASSIFIER_KINDS.has(element.kind)) {
    for (const relationship of index.content.relationships) {
      if (relationship.sourceElementId !== element.id) continue;
      if (relationship.kind === 'GENERALIZATION') emitGeneralization(emitter, input, relationship, tally);
      else if (relationship.kind === 'INTERFACE_REALIZATION') emitInterfaceRealization(emitter, input, relationship, tally);
    }
  }
}

function emitAttribute(emitter: XmiEmitter, input: SerializeInput, feature: UmlFeatureView): void {
  const xmiId = input.identity.forFeature(feature.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  const attrs: XmiAttr[] = [att('xmi:type', 'uml:Property'), att('xmi:id', xmiId), att('name', feature.name)];
  attrs.push(att('visibility', feature.visibility.toLowerCase()));
  if (feature.isStatic) attrs.push(att('isStatic', 'true'));
  if (feature.isReadonly) attrs.push(att('isReadOnly', 'true'));
  if (feature.isDerived) attrs.push(att('isDerived', 'true'));
  const type = input.types.resolveType(feature.typeElementId, feature.typeName);
  if (type !== null) attrs.push(att('type', type));

  emitter.open('ownedAttribute', attrs);
  emitMultiplicity(emitter, feature.lowerBound, feature.upperBound);
  emitter.close('ownedAttribute');
}

function emitOperation(emitter: XmiEmitter, index: DiagramIndex, input: SerializeInput, feature: UmlFeatureView): void {
  const xmiId = input.identity.forFeature(feature.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  const attrs: XmiAttr[] = [att('xmi:type', 'uml:Operation'), att('xmi:id', xmiId), att('name', feature.name)];
  attrs.push(att('visibility', feature.visibility.toLowerCase()));
  if (feature.isStatic) attrs.push(att('isStatic', 'true'));
  if (feature.isAbstract) attrs.push(att('isAbstract', 'true'));
  if (feature.isQuery) attrs.push(att('isQuery', 'true'));

  emitter.open('ownedOperation', attrs);
  for (const parameter of index.parametersByOperation.get(feature.id) ?? []) emitParameter(emitter, input, parameter);
  emitter.close('ownedOperation');
}

function emitParameter(emitter: XmiEmitter, input: SerializeInput, parameter: UmlParameterView): void {
  const xmiId = input.identity.forParameter(parameter.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  const attrs: XmiAttr[] = [att('xmi:type', 'uml:Parameter'), att('xmi:id', xmiId), att('name', parameter.name)];
  attrs.push(att('direction', DIRECTION_TOKEN[parameter.direction]));
  const type = input.types.resolveType(parameter.typeElementId, parameter.typeName);
  if (type !== null) attrs.push(att('type', type));
  emitter.leaf('ownedParameter', attrs);
}

function emitEnumLiteral(emitter: XmiEmitter, input: SerializeInput, literal: UmlEnumLiteralView): void {
  const xmiId = input.identity.forLiteral(literal.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);
  emitter.leaf('ownedLiteral', [att('xmi:type', 'uml:EnumerationLiteral'), att('xmi:id', xmiId), att('name', literal.name)]);
}

/**
 * D5 — la fusión: UN `packagedElement uml:AssociationClass` bajo el `xmi:id`
 * de la RELACIÓN, con `memberEnd` ×2 → `ownedEnd` ×2 → las features de la
 * clase ligada. La clase en sí no se emite (el recorrido la salta) y todo
 * `idref` hacia ella ya resuelve a la relación por D1.
 *
 * `name` e `isAbstract` salen de la CLASE (`relationship.name` es nullable y
 * `ck_element_named` garantiza nombre no vacío para todo no-`COMMENT`). Si la
 * relación también tenía nombre y difiere, el de la relación va al reporte:
 * pérdida visible, no silenciosa.
 */
function emitAssociation(emitter: XmiEmitter, index: DiagramIndex, input: SerializeInput, relationship: UmlRelationshipView, notes: XmiExportNote[], tally: Tally): void {
  const ends = index.endsByRelationship.get(relationship.id) ?? [];
  const fused = relationship.associationClassId === null ? null : index.elementsById.get(relationship.associationClassId) ?? null;
  const relationshipId = input.identity.forRelationship(relationship.id);
  if (relationshipId === null) return;

  if (relationship.stereotype !== null) {
    notes.push(note(XMI_EXPORT_NOTE.STEREOTYPE_NOT_IN_MODEL, relationshipId, `stereotype '${relationship.stereotype}' de la relación ${relationship.id}`));
  }

  if (fused !== null) {
    if (relationship.name !== null && relationship.name !== fused.name) {
      notes.push(note(XMI_EXPORT_NOTE.ASSOCIATION_CLASS_NAME_DISCARDED, relationshipId, `la relación ${relationship.id} se llamaba '${relationship.name}' y su clase asociación '${fused.name ?? ''}': se conserva el de la clase`));
    }
    for (const child of index.childrenByParent.get(fused.id) ?? []) {
      notes.push(note(XMI_EXPORT_NOTE.ASSOCIATION_CLASS_CHILDREN_REPARENTED, input.identity.forElement(child.id), `'${child.name ?? child.id}', hijo de la clase asociación '${fused.name ?? fused.id}', se reparenta al padre de esa clase`));
    }
    tally.associationClassesMerged += 1;
  }

  emitter.subject(relationshipId);
  const attrs: XmiAttr[] = [att('xmi:type', fused === null ? 'uml:Association' : 'uml:AssociationClass'), att('xmi:id', relationshipId)];
  const name = fused === null ? relationship.name : fused.name;
  if (name !== null) attrs.push(att('name', name));
  if (fused !== null && fused.isAbstract) attrs.push(att('isAbstract', 'true'));

  emitter.open('packagedElement', attrs);

  for (const end of ends) {
    const endId = input.identity.forEnd(end.id);
    if (endId !== null) emitter.leaf('memberEnd', [att('xmi:idref', endId)]);
  }

  for (const end of ends) {
    // Fusión: la clase ligada no aloja sus propios extremos (D5 fija
    // `ownedEnd` ×2), así que se emiten acá siempre. Asociación simple: un
    // extremo navegable es un `ownedAttribute` del participante (E.2 / E.5
    // trampa 5) y solo el no navegable queda como `ownedEnd`.
    const participant = index.elementsById.get(end.elementId);
    const ownedByParticipant =
      fused === null && end.isNavigable && participant !== undefined && CLASSIFIER_KINDS.has(participant.kind);
    if (!ownedByParticipant) emitEndProperty(emitter, input, end);
  }

  if (fused !== null) {
    for (const feature of index.featuresByOwner.get(fused.id) ?? []) {
      if (feature.kind === 'ATTRIBUTE') emitAttribute(emitter, input, feature);
      else emitOperation(emitter, index, input, feature);
    }
    for (const relationshipRow of index.content.relationships) {
      if (relationshipRow.sourceElementId !== fused.id) continue;
      if (relationshipRow.kind === 'GENERALIZATION') emitGeneralization(emitter, input, relationshipRow, tally);
      else if (relationshipRow.kind === 'INTERFACE_REALIZATION') emitInterfaceRealization(emitter, input, relationshipRow, tally);
    }
  }

  emitter.close('packagedElement');
  tally.relationships += 1;
}

/** Un extremo materializado como `ownedEnd`: rol, `aggregation`, multiplicidad y tipo resuelto por D1. */
function emitEndProperty(emitter: XmiEmitter, input: SerializeInput, end: UmlRelationshipEndView): void {
  const xmiId = input.identity.forEnd(end.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  const attrs: XmiAttr[] = [att('xmi:type', 'uml:Property'), att('xmi:id', xmiId)];
  if (end.roleName !== null) attrs.push(att('name', end.roleName));
  attrs.push(att('aggregation', AGGREGATION_TOKEN[end.aggregation]));
  attrs.push(att('type', input.identity.requireElement(end.elementId, `el extremo ${end.id}`)));

  emitter.open('ownedEnd', attrs);
  emitMultiplicity(emitter, end.lowerBound, end.upperBound);
  emitter.close('ownedEnd');
}

/** E.2: `generalization` hijo del clasificador específico, `general` por `xmi:idref` (la redirección D1 aplica acá). */
function emitGeneralization(emitter: XmiEmitter, input: SerializeInput, relationship: UmlRelationshipView, tally: Tally): void {
  const xmiId = input.identity.forRelationship(relationship.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);
  emitter.leaf('generalization', [
    att('xmi:type', 'uml:Generalization'),
    att('xmi:id', xmiId),
    att('general', input.identity.requireElement(relationship.targetElementId, `la generalización ${relationship.id}`)),
  ]);
  tally.relationships += 1;
}

/** E.2: `interfaceRealization` con `client`, `supplier` y `contract` (el contrato es la interfaz proveedora). */
function emitInterfaceRealization(emitter: XmiEmitter, input: SerializeInput, relationship: UmlRelationshipView, tally: Tally): void {
  const xmiId = input.identity.forRelationship(relationship.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);
  const supplier = input.identity.requireElement(relationship.targetElementId, `la realización ${relationship.id}`);
  emitter.leaf('interfaceRealization', [
    att('xmi:type', 'uml:InterfaceRealization'),
    att('xmi:id', xmiId),
    att('client', input.identity.requireElement(relationship.sourceElementId, `la realización ${relationship.id}`)),
    att('supplier', supplier),
    att('contract', supplier),
  ]);
  tally.relationships += 1;
}

function emitDependency(emitter: XmiEmitter, input: SerializeInput, relationship: UmlRelationshipView, notes: XmiExportNote[], tally: Tally): void {
  const xmiId = input.identity.forRelationship(relationship.id);
  if (xmiId === null) return;
  emitter.subject(xmiId);

  if (relationship.stereotype !== null) {
    notes.push(note(XMI_EXPORT_NOTE.STEREOTYPE_NOT_IN_MODEL, xmiId, `stereotype '${relationship.stereotype}' de la relación ${relationship.id}`));
  }

  const attrs: XmiAttr[] = [
    att('xmi:type', relationship.kind === 'DEPENDENCY' ? 'uml:Dependency' : 'uml:Usage'),
    att('xmi:id', xmiId),
  ];
  if (relationship.name !== null) attrs.push(att('name', relationship.name));
  attrs.push(att('client', input.identity.requireElement(relationship.sourceElementId, `la relación ${relationship.id}`)));
  attrs.push(att('supplier', input.identity.requireElement(relationship.targetElementId, `la relación ${relationship.id}`)));
  emitter.leaf('packagedElement', attrs);
  tally.relationships += 1;
}

/** E.2: `lowerValue` `uml:LiteralInteger` + `upperValue` `uml:LiteralUnlimitedNatural` (`*` si `null`). */
function emitMultiplicity(emitter: XmiEmitter, lower: number, upper: number | null): void {
  emitter.leaf('lowerValue', [att('xmi:type', 'uml:LiteralInteger'), att('value', lower)]);
  emitter.leaf('upperValue', [att('xmi:type', 'uml:LiteralUnlimitedNatural'), att('value', upper === null ? '*' : upper)]);
}

function note(code: XmiExportNote['code'], subjectId: string | null, detail: string): XmiExportNote {
  return { code, subjectId, detail };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

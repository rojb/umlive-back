import {
  XMI_IMPORT_ERROR,
  XMI_IMPORT_NAME_MAX_LENGTH,
  XMI_IMPORT_WARNING,
  XMI_UNSUPPORTED_REASON,
  type AggregationKind,
  type ElementKind,
  type FeatureKind,
  type ParameterDirection,
  type RelationshipKind,
  type Visibility,
  type XmiImportWarning,
  type XmiSourceEncoding,
  type XmiUnsupportedItem,
  type XmiVersion,
} from '@umlive/contracts';
import { layoutFor, readEaExtension, type LayoutOutcome } from './ea-extension-reader';
import {
  XmiAdmissionError,
  localName,
  namespaceUriOf,
  type XmiAdmission,
  type XmlElementNode,
} from './xmi-admission';
import { SYNTHETIC_TYPES_PACKAGE_ID, SYNTHETIC_TYPES_PACKAGE_NAME } from './xmi-types';

/**
 * Lector de dos pasadas y mapeo E.2 INVERSO (D6, D7, D9) — Fase 2,
 * tareas 2.1–2.3 y 2.5.
 *
 * Pasada 1 define identidad (`xmi:id`) y descubre las referencias; pasada 2
 * las resuelve. La trampa 6 de E.5 (`xmi:idref` puede aparecer ANTES de su
 * definición) es la razón de que sean dos: un lector de una sola pasada pierde
 * toda referencia hacia adelante, y SC-E06 es un caso obligatorio.
 *
 * ── Las tres ramas de tipos primitivos (D6, tarea 2.2) ─────────────────────
 * El discriminante es **de quién es hijo el elemento**, NUNCA el prefijo del
 * `xmi:id`:
 * 1. hijo de un `uml:Package` de nivel superior llamado `UMLIVE_TYPES` →
 *    colapsa a `typeName` por hex-decode inverso, **no se materializa**;
 * 2. `<type href="…/PrimitiveTypes.xmi#String"/>` → `typeName`, **no se
 *    materializa** (el `href` apunta fuera del documento);
 * 3. cualquier otro paquete → **fila real** `kind='PRIMITIVE_TYPE'`.
 * Nada impide que un `xmi:id` ajeno empiece con `UMLIVE_PT_`: por prefijo el
 * importador se comería un elemento real, que es la pérdida silenciosa que M5
 * entero persigue.
 *
 * ── La partición de `AssociationClass` (D7, tarea 2.3) ─────────────────────
 * UN `packagedElement xmi:type="uml:AssociationClass"` produce DOS filas: una
 * de relación con el `xmi:id` canónico y una de clase con `xmi_id = NULL`,
 * enlazadas por `association_class_id`. La columna EXISTE (`association-class`
 * está aplicada), así que se implementa la partición real y NO el descarte a
 * `unsupported` que la nota vieja de `tasks.md` prescribía.
 *
 * Solo lectura: no escribe una fila, no toca Prisma.
 */

/** Tope de nombre de los DTOs compartidos (hallazgo `operations-pipeline` RW-4). */
const MAX_NAME = XMI_IMPORT_NAME_MAX_LENGTH;

const CLASSIFIER_KINDS: ReadonlySet<ElementKind> = new Set<ElementKind>(['CLASS', 'INTERFACE', 'ENUMERATION', 'DATATYPE', 'PRIMITIVE_TYPE']);

const VISIBILITY: Readonly<Record<string, Visibility>> = {
  public: 'PUBLIC',
  private: 'PRIVATE',
  protected: 'PROTECTED',
  package: 'PACKAGE',
};

const DIRECTION: Readonly<Record<string, ParameterDirection>> = {
  in: 'IN',
  out: 'OUT',
  inout: 'INOUT',
  return: 'RETURN',
};

const PACKAGED_KIND: Readonly<Record<string, ElementKind>> = {
  Class: 'CLASS',
  Interface: 'INTERFACE',
  Enumeration: 'ENUMERATION',
  DataType: 'DATATYPE',
  PrimitiveType: 'PRIMITIVE_TYPE',
};

/**
 * Clave interna de la fila de CLASE de una `AssociationClass` (D7). **No es un
 * `xmi:id`** y nunca se escribe como tal: existe solo para que las features y
 * los hijos de esa clase tengan un dueño dentro del modelo parseado.
 */
export function associationClassKey(relationshipXmiId: string): string {
  return `assoc-class:${relationshipXmiId}`;
}

export interface ParsedElement {
  /** Clave interna: igual al `xmi:id`, salvo la fila de clase de una `AssociationClass`. */
  key: string;
  /** `xmi:id` de origen, LITERAL (FR-E14); `null` SOLO para la fila de clase de D7. */
  xmiId: string | null;
  parentKey: string | null;
  kind: ElementKind;
  name: string | null;
  isAbstract: boolean;
  body: string | null;
  stereotype: string | null;
  /** Índice en orden de documento — el que usa el auto-layout (D8). */
  documentIndex: number;
  /** Geometría final: la del archivo, o la grilla determinista (D8, tarea 3.2). */
  layout: LayoutOutcome;
  /** D7: `xmi:id` de la relación a la que esta fila de clase se enlaza; `null` en el resto. */
  associationClassOfXmiId: string | null;
}

export interface ParsedFeature {
  xmiId: string;
  ownerKey: string;
  kind: FeatureKind;
  name: string;
  visibility: Visibility;
  typeName: string | null;
  typeElementKey: string | null;
  lowerBound: number;
  upperBound: number | null;
  position: number;
  isStatic: boolean;
  isReadonly: boolean;
  isDerived: boolean;
  isAbstract: boolean;
  isQuery: boolean;
}

export interface ParsedParameter {
  xmiId: string;
  operationXmiId: string;
  name: string;
  direction: ParameterDirection;
  typeName: string | null;
  typeElementKey: string | null;
  position: number;
}

export interface ParsedLiteral {
  xmiId: string;
  enumerationKey: string;
  name: string;
  position: number;
}

export interface ParsedRelationshipEnd {
  /** `xmi:id` de la Property (el `ownedEnd` o el `ownedAttribute` del participante). */
  xmiId: string;
  /** Clave del elemento participante, o `null` si su `type` no resolvió. */
  elementKey: string | null;
  roleName: string | null;
  lowerBound: number;
  upperBound: number | null;
  isNavigable: boolean;
  aggregation: AggregationKind;
  endIndex: number;
}

export interface ParsedRelationship {
  xmiId: string;
  kind: RelationshipKind;
  name: string | null;
  sourceKey: string | null;
  targetKey: string | null;
  ends: ParsedRelationshipEnd[];
  /** D7: clave de la fila de clase enlazada, o `null`. */
  associationClassKey: string | null;
}

export interface ParsedModel {
  version: XmiVersion;
  sourceEncoding: XmiSourceEncoding;
  exporter: string | null;
  elements: ParsedElement[];
  features: ParsedFeature[];
  parameters: ParsedParameter[];
  literals: ParsedLiteral[];
  relationships: ParsedRelationship[];
  unsupported: XmiUnsupportedItem[];
  warnings: XmiImportWarning[];
  counts: {
    classifiers: number;
    relationships: number;
    features: number;
    withGeometry: number;
    totalPositionable: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de atributos (todo string: `parseAttributeValue:false`)
// ─────────────────────────────────────────────────────────────────────────────

function attr(node: XmlElementNode, name: string): string | null {
  const value = node.attributes[name];
  return value === undefined ? null : value;
}

function childByLocal(node: XmlElementNode, name: string): XmlElementNode | null {
  return node.children.find((child) => localName(child.name) === name) ?? null;
}

function isPackagedElement(node: XmlElementNode): boolean {
  return localName(node.name) === 'packagedElement';
}

function readBoolean(value: string | null): boolean {
  return value === 'true' || value === '1';
}

function readInt(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function readVisibility(value: string | null): Visibility {
  return (value !== null ? VISIBILITY[value.toLowerCase()] : undefined) ?? 'PUBLIC';
}

function readDirection(value: string | null): ParameterDirection {
  return (value !== null ? DIRECTION[value.toLowerCase()] : undefined) ?? 'IN';
}

function readAggregation(value: string | null): AggregationKind {
  if (value === null) return 'NONE';
  const token = value.toLowerCase();
  if (token === 'shared') return 'SHARED';
  if (token === 'composite') return 'COMPOSITE';
  return 'NONE';
}

function readMultiplicity(node: XmlElementNode): { lower: number; upper: number | null } {
  const lowerNode = childByLocal(node, 'lowerValue');
  const upperNode = childByLocal(node, 'upperValue');
  const rawLower = lowerNode !== null ? attr(lowerNode, 'value') : attr(node, 'lowerValue');
  const rawUpper = upperNode !== null ? attr(upperNode, 'value') : attr(node, 'upperValue');
  const lower = readInt(rawLower) ?? 0;
  if (rawUpper === null || rawUpper.trim() === '*') return { lower, upper: null };
  return { lower, upper: readInt(rawUpper) };
}

/** `<type href="…/PrimitiveTypes.xmi#String"/>` → `String` (último segmento si no hay `#`). */
function nameFromHref(href: string | null): string | null {
  if (href === null || href === '') return null;
  const fragment = href.includes('#') ? href.slice(href.indexOf('#') + 1) : href;
  const segment = fragment.split(/[\\/]/).pop() ?? fragment;
  return segment === '' ? null : segment;
}

function decodeSyntheticTypeName(xmiId: string): string | null {
  const prefix = 'UMLIVE_PT_';
  if (!xmiId.startsWith(prefix)) return null;
  const hex = xmiId.slice(prefix.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

interface RawFeature {
  xmiId: string;
  ownerKey: string;
  kind: FeatureKind;
  name: string;
  node: XmlElementNode;
  position: number;
}

interface RawLiteral {
  xmiId: string;
  enumerationKey: string;
  name: string;
  position: number;
}

interface RawRelationship {
  xmiId: string;
  kind: RelationshipKind;
  name: string | null;
  node: XmlElementNode;
  ownerKey: string | null;
  memberEnds: readonly string[];
  clientRef: string | null;
  supplierRef: string | null;
  generalRef: string | null;
  associationClassKey: string | null;
}

/**
 * Lee el modelo. Toda referencia se resuelve en la fase final contra el mapa
 * de definiciones completo, así que el orden del documento no importa (SC-E06).
 */
export function readXmiModel(admission: XmiAdmission): ParsedModel {
  const namespaces = admission.namespaces;
  const umlNs = admission.strategy.umlNs;

  const unsupported: XmiUnsupportedItem[] = [];
  const warnings: XmiImportWarning[] = [];
  const elements: ParsedElement[] = [];
  const features: ParsedFeature[] = [];
  const parameters: ParsedParameter[] = [];
  const literals: ParsedLiteral[] = [];
  const rawFeatures: RawFeature[] = [];
  const rawRelationships: RawRelationship[] = [];
  const rawLiterals: RawLiteral[] = [];

  const elementKeyByXmiId = new Map<string, string>();
  const aliasToClassKey = new Map<string, string>();
  const rawParameters: { operationXmiId: string; node: XmlElementNode }[] = [];
  /** Primitivos sintéticos colapsados: `xmi:id` → `typeName` (D6, rama 1). */
  const syntheticNames = new Map<string, string>();
  /** TODAS las definiciones con `xmi:id` (semánticas y de extensión): la red del `dangling_idref`. */
  const nodeByXmiId = new Map<string, XmlElementNode>();

  const extension = readEaExtension(admission.root);
  const exporter = readExporter(admission.root);
  let documentIndex = 0;

  // ── Pasada 1: definiciones + detección de `xmi:id` duplicado (nivel A) ────
  for (const node of walkAll(admission.root)) {
    const xmiId = attr(node, 'xmi:id');
    if (xmiId === null || xmiId === '') continue;
    if (nodeByXmiId.has(xmiId)) {
      throw new XmiAdmissionError(
        XMI_IMPORT_ERROR.DUPLICATE_XMI_ID,
        `el xmi:id "${xmiId}" está definido dos veces en el documento: con ids ambiguos toda referencia queda indeterminada`,
      );
    }
    nodeByXmiId.set(xmiId, node);
  }

  /**
   * Los `memberEnd` se descubren ANTES de materializar features: una Property
   * referenciada por un `memberEnd` es un EXTREMO, no un atributo (trampa 5).
   * `memberEnd` NO tiene `xmi:id` (tiene `xmi:idref`), así que NO está en
   * `nodeByXmiId`: hay que recorrer el árbol otra vez.
   */
  const endPropertyIds = new Set<string>();
  for (const node of walkAll(admission.root)) {
    if (localName(node.name) !== 'memberEnd') continue;
    const ref = attr(node, 'xmi:idref');
    if (ref !== null) endPropertyIds.add(ref);
  }

  const modelNode = findModel(admission.root, namespaces, umlNs);

  const usedNames = new Map<string, string>();
  const positionByOwner = new Map<string, number>();
  const parameterPositionByOperation = new Map<string, number>();
  const literalPositionByEnumeration = new Map<string, number>();

  // ── Materialización en orden de documento ─────────────────────────────────
  function nextDocumentIndex(): number {
    const index = documentIndex;
    documentIndex += 1;
    return index;
  }

  function pushUnsupported(xmiId: string | null, name: string | null, type: string, reason: XmiUnsupportedItem['reason'], detail?: string): void {
    unsupported.push({ xmiId, name, type, reason, ...(detail === undefined ? {} : { detail }) });
  }

  /** Tope de 120 caracteres: un nombre más largo se REPORTA y nunca se escribe (RW-4). */
  function nameAllowed(xmiId: string | null, name: string | null, type: string): boolean {
    if (name !== null && name.length > MAX_NAME) {
      pushUnsupported(xmiId, name, type, XMI_UNSUPPORTED_REASON.NAME_TOO_LONG, `el nombre tiene ${name.length} caracteres y el tope es ${MAX_NAME}`);
      return false;
    }
    return true;
  }

  function umlTypeOf(node: XmlElementNode): string | null {
    const raw = attr(node, 'xmi:type');
    if (raw === null) return null;
    return namespaceUriOf(raw, namespaces) === umlNs ? localName(raw) : null;
  }

  function addElement(node: XmlElementNode, kind: ElementKind, parentKey: string | null, name: string | null, associationClassOfXmiId: string | null = null): ParsedElement {
    const xmiId = attr(node, 'xmi:id');
    const key = associationClassOfXmiId === null ? xmiId ?? `anon:${documentIndex}` : associationClassKey(associationClassOfXmiId);
    const index = nextDocumentIndex();
    const element: ParsedElement = {
      key,
      xmiId: associationClassOfXmiId === null ? xmiId : null,
      parentKey,
      kind,
      name,
      isAbstract: readBoolean(attr(node, 'isAbstract')),
      body: attr(node, 'body'),
      stereotype: xmiId !== null ? extension.stereotypeBySubject.get(xmiId) ?? null : null,
      documentIndex: index,
      layout: layoutFor(extension, xmiId, index),
      associationClassOfXmiId,
    };
    elements.push(element);
    if (xmiId !== null) elementKeyByXmiId.set(xmiId, key);
    return element;
  }

  function addFeature(raw: RawFeature, node: XmlElementNode): void {
    const type = resolveType(node);
    const multiplicity = readMultiplicity(node);
    features.push({
      xmiId: raw.xmiId,
      ownerKey: raw.ownerKey,
      kind: raw.kind,
      name: raw.name,
      visibility: readVisibility(attr(node, 'visibility')),
      typeName: type.typeName,
      typeElementKey: type.typeElementKey,
      lowerBound: multiplicity.lower,
      upperBound: multiplicity.upper,
      position: raw.position,
      isStatic: readBoolean(attr(node, 'isStatic')),
      isReadonly: readBoolean(attr(node, 'isReadOnly')),
      isDerived: readBoolean(attr(node, 'isDerived')),
      isAbstract: readBoolean(attr(node, 'isAbstract')),
      isQuery: readBoolean(attr(node, 'isQuery')),
    });
  }

  function collectParameters(operation: XmlElementNode, operationXmiId: string): void {
    for (const child of operation.children) {
      if (localName(child.name) !== 'ownedParameter') continue;
      if (attr(child, 'xmi:id') === null) continue;
      rawParameters.push({ operationXmiId, node: child });
    }
  }

  /** Los `position` se asignan en orden de aparición del hijo, nunca por un contador global (D9). */
  function addParameter(operationXmiId: string, node: XmlElementNode): void {
    const xmiId = attr(node, 'xmi:id');
    if (xmiId === null) return;
    const rawName = attr(node, 'name') ?? '';
    if (!nameAllowed(xmiId, rawName, 'uml:Parameter')) return;
    const position = parameterPositionByOperation.get(operationXmiId) ?? 0;
    parameterPositionByOperation.set(operationXmiId, position + 1);
    const type = resolveType(node);
    parameters.push({
      xmiId,
      operationXmiId,
      name: rawName,
      direction: readDirection(attr(node, 'direction')),
      typeName: type.typeName,
      typeElementKey: type.typeElementKey,
      position,
    });
  }

  function processClassifierBody(owner: XmlElementNode, ownerKey: string): void {
    for (const child of owner.children) {
      const local = localName(child.name);
      if (local === 'ownedAttribute') {
        const xmiId = attr(child, 'xmi:id');
        if (xmiId === null || endPropertyIds.has(xmiId)) continue; // extremo de asociación, no atributo
        const name = attr(child, 'name') ?? '';
        if (!nameAllowed(xmiId, name, 'uml:Property')) continue;
        const position = positionByOwner.get(`${ownerKey}:ATTRIBUTE`) ?? 0;
        positionByOwner.set(`${ownerKey}:ATTRIBUTE`, position + 1);
        rawFeatures.push({ xmiId, ownerKey, kind: 'ATTRIBUTE', name, node: child, position });
      } else if (local === 'ownedOperation') {
        const xmiId = attr(child, 'xmi:id');
        if (xmiId === null) continue;
        const name = attr(child, 'name') ?? '';
        if (!nameAllowed(xmiId, name, 'uml:Operation')) continue;
        const position = positionByOwner.get(`${ownerKey}:OPERATION`) ?? 0;
        positionByOwner.set(`${ownerKey}:OPERATION`, position + 1);
        rawFeatures.push({ xmiId, ownerKey, kind: 'OPERATION', name, node: child, position });
        collectParameters(child, xmiId);
      } else if (local === 'ownedLiteral') {
        const xmiId = attr(child, 'xmi:id');
        if (xmiId === null) continue;
        const name = attr(child, 'name') ?? '';
        if (!nameAllowed(xmiId, name, 'uml:EnumerationLiteral')) continue;
        const position = literalPositionByEnumeration.get(ownerKey) ?? 0;
        literalPositionByEnumeration.set(ownerKey, position + 1);
        rawLiterals.push({ xmiId, enumerationKey: ownerKey, name, position });
      } else if (local === 'ownedComment') {
        processComment(child, ownerKey);
      } else if (local === 'generalization') {
        collectRelationship(child, 'GENERALIZATION', ownerKey, null);
      } else if (local === 'interfaceRealization') {
        collectRelationship(child, 'INTERFACE_REALIZATION', ownerKey, null);
      } else if (isPackagedElement(child)) {
        processPackagedElement(child, ownerKey);
      }
    }
  }

  function processComment(node: XmlElementNode, parentKey: string | null): void {
    const xmiId = attr(node, 'xmi:id');
    if (xmiId === null) return;
    addElement(node, 'COMMENT', parentKey, null);
  }

  function collectRelationship(node: XmlElementNode, kind: RelationshipKind, ownerKey: string | null, associationClassKeyValue: string | null): void {
    const xmiId = attr(node, 'xmi:id');
    if (xmiId === null) return;
    const name = attr(node, 'name');
    if (!nameAllowed(xmiId, name, `uml:${kind}`)) return;
    const memberEnds: string[] = [];
    for (const child of node.children) {
      if (localName(child.name) !== 'memberEnd') continue;
      const ref = attr(child, 'xmi:idref');
      if (ref !== null) memberEnds.push(ref);
    }
    rawRelationships.push({
      xmiId,
      kind,
      name,
      node,
      ownerKey,
      memberEnds,
      clientRef: attr(node, 'client'),
      supplierRef: attr(node, 'supplier') ?? attr(node, 'contract'),
      generalRef: attr(node, 'general'),
      associationClassKey: associationClassKeyValue,
    });
  }

  function processAssociation(node: XmlElementNode, parentKey: string | null, isAssociationClass: boolean): void {
    const xmiId = attr(node, 'xmi:id');
    if (xmiId === null) {
      pushUnsupported(null, attr(node, 'name'), isAssociationClass ? 'uml:AssociationClass' : 'uml:Association', XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, 'la asociación no tiene xmi:id');
      return;
    }
    const name = attr(node, 'name');
    let classKey: string | null = null;
    if (isAssociationClass) {
      if (!nameAllowed(xmiId, name, 'uml:AssociationClass')) return;
      // D7: la fila de CLASE lleva `xmi_id = NULL` y el nombre obligatorio.
      const classElement = addElement(node, 'CLASS', parentKey, name, xmiId);
      classKey = classElement.key;
      aliasToClassKey.set(xmiId, classKey);
      warnings.push({
        xmiId,
        name,
        code: XMI_IMPORT_WARNING.ASSOCIATION_CLASS_PARENTHOOD_NOT_RECOVERABLE,
        detail: 'la paternidad de los hijos de una AssociationClass exportada se pierde en el XMI (D7): el import no tiene de dónde reconstruirla',
      });
    } else if (!nameAllowed(xmiId, name, 'uml:Association')) {
      return;
    }

    collectRelationship(node, 'ASSOCIATION', parentKey, classKey);

    // `ownedAttribute`/`ownedOperation` de una AssociationClass pertenecen a la
    // fila de CLASE (D7), no a la relación. `processClassifierBody` ya recursa
    // los `packagedElement` anidados: no se vuelven a procesar acá.
    if (classKey !== null) processClassifierBody(node, classKey);
  }

  function processPackagedElement(node: XmlElementNode, parentKey: string | null): void {
    const xmiId = attr(node, 'xmi:id');
    const type = umlTypeOf(node);
    const name = attr(node, 'name');

    if (type === null) {
      pushUnsupported(xmiId, name, 'desconocido', XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, 'el packagedElement no declara un xmi:type del namespace UML');
      return;
    }

    if (type === 'Package') {
      // D6 rama 1: paquete de tipos acuñado, de nivel superior. NO se materializa.
      //
      // OJO con el discriminante, medido contra el artefacto REAL: el
      // exportador emite `xmi:id="UMLIVE_TYPES"` con `name="UMLivePrimitiveTypes"`
      // (`xmi-types.ts`, `SYNTHETIC_TYPES_PACKAGE_ID` / `_NAME`). El texto de
      // D6/tasks dice `padre.name === 'UMLIVE_TYPES'`, que NO coincide con lo
      // emitido; seguirlo al pie haría que nuestro propio paquete sintético se
      // materializara y rompería FR-E20. Se acepta el id O el nombre, y lo que
      // importa —que el PRIMITIVO se decida por POSICIÓN y no por el prefijo de
      // su id— queda intacto.
      const isSyntheticTypesPackage =
        parentKey === null && (xmiId === SYNTHETIC_TYPES_PACKAGE_ID || name === SYNTHETIC_TYPES_PACKAGE_ID || name === SYNTHETIC_TYPES_PACKAGE_NAME);
      if (isSyntheticTypesPackage) {
        for (const child of node.children) {
          if (!isPackagedElement(child) || umlTypeOf(child) !== 'PrimitiveType') continue;
          const childId = attr(child, 'xmi:id');
          if (childId === null) continue;
          const decoded = decodeSyntheticTypeName(childId);
          if (decoded === null) {
            pushUnsupported(childId, attr(child, 'name'), 'uml:PrimitiveType', XMI_UNSUPPORTED_REASON.PRIMITIVE_TYPE_NAME_UNDECODABLE, 'el xmi:id del tipo sintético no decodifica a UTF-8 válido por hex');
            continue;
          }
          syntheticNames.set(childId, decoded);
        }
        return;
      }
      if (!nameAllowed(xmiId, name, 'uml:Package')) return;
      const element = addElement(node, 'PACKAGE', parentKey, name);
      for (const child of node.children) {
        if (isPackagedElement(child)) processPackagedElement(child, element.key);
        else if (localName(child.name) === 'ownedComment') processComment(child, element.key);
      }
      return;
    }

    const kind = PACKAGED_KIND[type];
    if (kind !== undefined) {
      if (!nameAllowed(xmiId, name, `uml:${type}`)) return;
      // ck_element_named: un clasificador sin nombre no se materializa (lo nombra Fase 4 con el detalle completo).
      const element = addElement(node, kind, parentKey, name);
      processClassifierBody(node, element.key);
      return;
    }

    if (type === 'Association') {
      processAssociation(node, parentKey, false);
      return;
    }
    if (type === 'AssociationClass') {
      processAssociation(node, parentKey, true);
      return;
    }
    if (type === 'Dependency' || type === 'Usage') {
      if (!nameAllowed(xmiId, name, `uml:${type}`)) return;
      collectRelationship(node, type === 'Dependency' ? 'DEPENDENCY' : 'USAGE', null, null);
      return;
    }

    // Fuera de E.2: diagramas de secuencia (`uml:Interaction`), actores, casos
    // de uso, etc. Se DESCARTA y se nombra — nunca se ignora en silencio.
    pushUnsupported(xmiId, name, `uml:${type}`, XMI_UNSUPPORTED_REASON.UNSUPPORTED_CONSTRUCT, `uml:${type} no tiene fila en el mapeo E.2`);
  }

  /**
   * Resuelve el `type` de una feature/parámetro/extremo. Orden: `type` por
   * atributo (`xmi:idref` textual en nuestro dialecto) → `<type href>` (vía
   * OMG) → nada. Un id COLGADO aborta (nivel A, tarea 2.5).
   */
  function resolveType(node: XmlElementNode): { typeName: string | null; typeElementKey: string | null } {
    const ref = attr(node, 'type');
    if (ref !== null) {
      if (!nodeByXmiId.has(ref)) {
        throw new XmiAdmissionError(
          XMI_IMPORT_ERROR.DANGLING_IDREF,
          `el type="${ref}" no resuelve a ningún xmi:id definido en el documento`,
        );
      }
      const synthetic = syntheticNames.get(ref);
      if (synthetic !== undefined) return { typeName: synthetic, typeElementKey: null };
      return { typeName: null, typeElementKey: resolveElementKey(ref) };
    }
    const hrefNode = childByLocal(node, 'type');
    if (hrefNode !== null) return { typeName: nameFromHref(attr(hrefNode, 'href')), typeElementKey: null };
    return { typeName: null, typeElementKey: null };
  }

  function resolveElementKey(ref: string | null): string | null {
    if (ref === null) return null;
    if (syntheticNames.has(ref)) return null;
    const alias = aliasToClassKey.get(ref);
    if (alias !== undefined) return alias;
    return elementKeyByXmiId.get(ref) ?? null;
  }

  function requireDefined(ref: string | null, site: string): void {
    if (ref !== null && !nodeByXmiId.has(ref)) {
      throw new XmiAdmissionError(XMI_IMPORT_ERROR.DANGLING_IDREF, `${site} apunta a "${ref}", que no resuelve a ningún xmi:id del documento`);
    }
  }

  // ── Recorrido ─────────────────────────────────────────────────────────────
  if (modelNode !== null) {
    for (const child of modelNode.children) {
      if (isPackagedElement(child)) processPackagedElement(child, null);
      else if (localName(child.name) === 'ownedComment') processComment(child, null);
    }
  }

  // ── Pasada 2: features, literales y relaciones contra las definiciones ────
  for (const raw of rawFeatures) addFeature(raw, raw.node);
  for (const raw of rawParameters) addParameter(raw.operationXmiId, raw.node);
  for (const raw of rawLiterals) literals.push(raw);

  const relationships: ParsedRelationship[] = [];
  for (const raw of rawRelationships) {
    const relationship: ParsedRelationship = {
      xmiId: raw.xmiId,
      kind: raw.kind,
      name: raw.name,
      sourceKey: null,
      targetKey: null,
      ends: [],
      associationClassKey: raw.associationClassKey,
    };

    if (raw.kind === 'ASSOCIATION') {
      relationship.ends = raw.memberEnds.map((ref, index) => resolveEnd(ref, index));
      relationship.sourceKey = relationship.ends[0]?.elementKey ?? null;
      relationship.targetKey = relationship.ends[1]?.elementKey ?? null;
    } else if (raw.kind === 'GENERALIZATION') {
      requireDefined(raw.generalRef, 'el general de una generalización');
      relationship.sourceKey = raw.ownerKey;
      relationship.targetKey = resolveElementKey(raw.generalRef);
    } else if (raw.kind === 'INTERFACE_REALIZATION') {
      requireDefined(raw.clientRef, 'el client de una realización');
      requireDefined(raw.supplierRef, 'el supplier de una realización');
      // El cliente ES el clasificador que posee la `interfaceRealization`; el
      // atributo `client` es la misma información explícita.
      relationship.sourceKey = resolveElementKey(raw.clientRef) ?? raw.ownerKey;
      relationship.targetKey = resolveElementKey(raw.supplierRef);
    } else {
      requireDefined(raw.clientRef, 'el client de una dependencia');
      requireDefined(raw.supplierRef, 'el supplier de una dependencia');
      relationship.sourceKey = resolveElementKey(raw.clientRef);
      relationship.targetKey = resolveElementKey(raw.supplierRef);
    }

    relationships.push(relationship);
  }

  function resolveEnd(ref: string, index: number): ParsedRelationshipEnd {
    if (!nodeByXmiId.has(ref)) {
      throw new XmiAdmissionError(XMI_IMPORT_ERROR.DANGLING_IDREF, `el memberEnd xmi:idref="${ref}" no resuelve a ningún xmi:id del documento`);
    }
    const node = nodeByXmiId.get(ref) as XmlElementNode;
    const multiplicity = readMultiplicity(node);
    const typeRef = attr(node, 'type');
    requireDefined(typeRef, 'el type de un extremo de asociación');
    const explicitNavigability = attr(node, 'isNavigable');
    const isNavigable = explicitNavigability !== null
      ? readBoolean(explicitNavigability)
      : localName(node.name) === 'ownedAttribute';
    return {
      xmiId: ref,
      elementKey: resolveElementKey(typeRef),
      roleName: attr(node, 'name'),
      lowerBound: multiplicity.lower,
      upperBound: multiplicity.upper,
      isNavigable,
      aggregation: readAggregation(attr(node, 'aggregation')),
      endIndex: index,
    };
  }

  // ── Warnings de geometría: TODOS los casos inutilizables, uno por elemento ─
  for (const element of elements) {
    if (element.layout.source === 'extension') continue;
    const detail = element.layout.rawGeometry === null
      ? 'sin geometría en el bloque de extensión: se aplicó auto-layout determinista (D8)'
      : `geometry '${element.layout.rawGeometry}' inutilizable: se aplicó auto-layout determinista (D8)`;
    warnings.push({ xmiId: element.xmiId, name: element.name, code: XMI_IMPORT_WARNING.DEGENERATE_GEOMETRY, detail });
  }
  if (extension.seqnoSeen) {
    warnings.push({ xmiId: null, name: null, code: XMI_IMPORT_WARNING.SEQNO_IGNORED, detail: 'el z-order (seqno) de EA no tiene columna en el modelo: se ignoró' });
  }

  const classifierCount = elements.filter((element) => CLASSIFIER_KINDS.has(element.kind)).length;
  return {
    version: admission.version,
    sourceEncoding: admission.encoding,
    exporter,
    elements,
    features,
    parameters,
    literals,
    relationships,
    unsupported,
    warnings,
    counts: {
      classifiers: classifierCount,
      relationships: relationships.length,
      features: features.length,
      withGeometry: elements.filter((element) => element.layout.source === 'extension').length,
      totalPositionable: elements.length,
    },
  };
}

function walkAll(root: XmlElementNode): XmlElementNode[] {
  const nodes: XmlElementNode[] = [];
  const stack: XmlElementNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as XmlElementNode;
    nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return nodes;
}

function findModel(root: XmlElementNode, namespaces: ReadonlyMap<string, string>, umlNs: string): XmlElementNode | null {
  for (const node of walkAll(root)) {
    if (localName(node.name) !== 'Model') continue;
    if (namespaceUriOf(node.name, namespaces) === umlNs) return node;
    if (attr(node, 'xmi:type') !== null && namespaceUriOf(attr(node, 'xmi:type') as string, namespaces) === umlNs) return node;
  }
  return null;
}

function readExporter(root: XmlElementNode): string | null {
  for (const node of walkAll(root)) {
    if (localName(node.name) !== 'Documentation') continue;
    const exporter = attr(node, 'exporter');
    if (exporter !== null) return exporter;
  }
  return null;
}

/**
 * `buildIr` — la compuerta de decisión de la rebanada (D1, D2, D5, D6).
 *
 * Entrada: el contenido del diagrama y el informe de validación, los DOS leídos
 * del mismo snapshot (`RepeatableRead`, D1). Salida: la IR más los hallazgos.
 *
 * Todas las decisiones viven acá; los emisores solo traducen (D2):
 *
 * - **PK** (D5, contradicción 5): un atributo llamado `id` es la PK. `Integer`/
 *   `Long` → `IDENTITY`; `UUID` → `GenerationType.UUID`; cualquier otro tipo o
 *   multivaluado → bloqueo `pk_type_invalid`. Sin `id`, se inyecta `Long id` y
 *   se reporta `pk_injected`.
 * - **Clasificadores** (D6): se emite `CLASS` concreta sin estereotipo o con
 *   `entity`. Todo lo demás se omite CON nota.
 * - **Tipos** (D5): por la tabla de 9 filas. Un tipo que no resuelve se omite
 *   con `unknown_type`; nunca se asume `String` (SC-F09).
 * - **Operaciones** (contradicción 2): stub; la clave de firma es
 *   `nombre(tipos Java mapeados)` y comparte espacio con los accesores y con
 *   los métodos de `Object`.
 * - **Nombres** (D3): NFC sin plegar para Java/SQL; la ruta es la única que
 *   pliega a ASCII, y lo declara con `route_ascii_folded`.
 * - **Relaciones** (D3, D4, D10): cada `ASSOCIATION` se resuelve a campos JPA, columnas
 *   FK, join tables y restricciones según la multiplicidad y la agregación (cascada
 *   del TODO); `DEPENDENCY`/`USAGE` y los extremos sobre no-entidad quedan declarados
 *   con `relationship_not_emitted`. La herencia y las interfaces las cubren las pasadas
 *   D2 de esta rebanada; `relationship_deferred` ya no existe (D1). El grafo de
 *   referencias obligatorias (D9) cierra con `fixturePlan` o con un bloqueo, y nunca
 *   con un ZIP que no arranque.
 * - **Orden de los hallazgos** (D6): primero los de validación en el orden del
 *   servicio, después los del generador en el orden de esta construcción.
 */

import {
  isBlockingRule,
  qualifiedName,
  type CodegenBlockCode,
  type CodegenElementRef,
  type CodegenFinding,
  type CodegenNote,
  type CodegenRelationshipRef,
  type DiagramContent,
  type UmlElementView,
  type UmlEnumLiteralView,
  type UmlFeatureView,
  type UmlParameterView,
  type UmlRelationshipEndView,
  type UmlRelationshipView,
  type ValidationReport,
} from '@umlive/contracts';
import {
  OBJECT_METHOD_SIGNATURES,
  collisionKey,
  columnName,
  enumLiteralName,
  hqlEntityName,
  isSqlIdentifierShortened,
  memberName,
  routeSegment,
  snakeCase,
  sqlIdent,
  tableName,
  typeName,
} from './java-names';
import { mapPrimitive } from './type-mapping';
import type {
  CodegenIr,
  IrDtoField,
  IrEntity,
  IrEnum,
  IrField,
  IrForeignKey,
  IrInterface,
  IrJoinTable,
  IrOperation,
  IrParameter,
  IrRelationField,
  IrTypeRef,
  IrUnique,
} from './codegen-ir';

/**
 * Paquete base fijo del proyecto emitido (D11). FR-F13 —poder elegirlo— está en
 * la lista de corte, así que es una constante, no una opción.
 */
export const BASE_PACKAGE = 'com.umlive.generated';

/** `artifactId` de reserva cuando el nombre del diagrama no deja ninguna palabra (D11). */
export const FALLBACK_ARTIFACT_ID = 'umlive-app';

const ENTITY_PACKAGE = `${BASE_PACKAGE}.entity`;

/** Motivo por el que un bloqueo/nota no pudo enlazarse a un elemento. Nunca vacío. */
type ElementIndex = Record<string, Pick<UmlElementView, 'parentId' | 'name' | 'kind'>>;

interface ResolvedType {
  status: 'ok' | 'unknown' | 'skip';
  type?: IrTypeRef;
  enumerated?: boolean;
  reason?: string;
}

/** Un clasificador emitible y el conjunto de tipos que ocupa en el espacio global (D3). */
interface TypeSet {
  elementId: string;
  label: string;
  keys: Map<string, string>;
}

/**
 * Lo que la pasada de asociaciones necesita de cada entidad ya construida y lo
 * que la comprobación de colisiones lee DESPUÉS de agregar los campos de
 * relación (D1, D3, D8).
 */
interface EntityBookkeeping {
  entity: IrEntity;
  /** Nombre Java de la clase, para el detalle del bloqueo. */
  label: string;
  /** Miembros de la entidad: atributos, accesores y ahora campos de relación. */
  memberOwners: Map<string, string[]>;
  /** Columnas de la tabla: atributos y ahora las columnas FK. */
  columnOwners: Map<string, string[]>;
  /** Componentes de los `record` DTO, que comparten espacio propio. */
  dtoOwners: Map<string, string[]>;
  /** Importaciones que agregan los campos de relación, para fusionar al final. */
  extraImports: string[];
}

/** Un extremo de la asociación en curso, con su entidad y el extremo opuesto (D3). */
interface RelationshipSide {
  build: EntityBookkeeping;
  /** Extremo que cae SOBRE esta clase. */
  end: UmlRelationshipEndView;
  /** Extremo que cae sobre la clase opuesta: de ahí sale la multiplicidad de la FK. */
  other: UmlRelationshipEndView;
  otherBuild: EntityBookkeeping;
}

/** Rol de una clase en la jerarquía de generalizaciones (D2). */
type ClassRole = 'entity' | 'mappedSuperclass' | 'skipped';

/**
 * Nodo de la jerarquía de `GENERALIZATION` (D2). El sentido es
 * `source` = hija, `target` = padre, así que `childrenElementIds` se llena
 * desde el padre.
 */
interface ClassNode {
  elementId: string;
  rawName: string;
  role: ClassRole;
  isAbstract: boolean;
  /** Clase Java resuelta (`typeName`); `null` si el nombre no es representable. */
  javaName: string | null;
  /** Generalizaciones con un padre clasificado (clase/UML), en orden del modelo. */
  parents: { elementId: string; relationship: UmlRelationshipView }[];
  /** Padre emitido elegido: el primero de `parents` que se emite, o `null`. */
  parentElementId: string | null;
  childrenElementIds: string[];
  /** `true` si algún hijo directo se emite. */
  hasEmittedChild: boolean;
  /** `true` si algún descendiente es una clase concreta emitible. */
  hasConcreteDescendant: boolean;
  /** `true` si la clase pasa la clasificación y la decisión de emisión (D6). */
  emitted: boolean;
}

/** Arista del grafo de referencias obligatorias (D9): una FK `NOT NULL`. */
interface MandatoryEdge {
  fromElementId: string;
  toElementId: string;
  relationship: UmlRelationshipView;
  elements: CodegenElementRef[];
  relationships: CodegenRelationshipRef[];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const byPosition = <T extends { position: number }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.position - b.position);

/** Orden estable: por unidades de código UTF-16, nunca `localeCompare` (D7). */
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

function blocker(
  code: CodegenBlockCode,
  elements: CodegenElementRef[],
  detail: string | null,
  relationships: CodegenRelationshipRef[] = [],
): CodegenFinding {
  return { source: 'codegen', code, elements, relationships, detail };
}

function note(
  code: CodegenNote['code'],
  elements: CodegenElementRef[],
  detail: string | null,
  relationships: CodegenRelationshipRef[] = [],
): CodegenNote {
  return { code, elements, relationships, detail };
}

/** Etiqueta de una arista para el lienzo (D10): el nombre de la relación si lo tiene, si no los dos extremos calificados. */
function relationshipLabel(relationship: UmlRelationshipView, ctx: BuildContext): string {
  const declared = (relationship.name ?? '').trim();
  if (declared !== '') return declared;
  const source = ctx.ref(relationship.sourceElementId).qualifiedName ?? relationship.sourceElementId;
  const target = ctx.ref(relationship.targetElementId).qualifiedName ?? relationship.targetElementId;
  return `${source} — ${target} (${relationship.kind})`;
}

/** Referencia a una arista, para los bloqueos que apuntan a relaciones (D10). */
function relationshipRef(relationship: UmlRelationshipView, ctx: BuildContext): CodegenRelationshipRef {
  return { id: relationship.id, label: relationshipLabel(relationship, ctx) };
}

/** Motivo de `classifier_skipped` para una clase que la jerarquía no emite (D6). */
function skipDetail(el: UmlElementView, node: ClassNode | undefined): string {
  const rawName = el.name ?? '';
  const stereotype = (el.stereotype ?? '').trim();
  if (node !== undefined && node.role === 'skipped' && stereotype.toLowerCase() === 'mappedsuperclass') {
    return `${rawName}: estereotipo «${stereotype}» en una clase concreta`;
  }
  if (el.isAbstract) return `${rawName}: clase abstracta sin hijas emitidas`;
  if (stereotype !== '') return `${rawName}: estereotipo «${stereotype}»`;
  return `${rawName}: no es una clase emitible`;
}

/** Resultado de mapear las operaciones de una clase o interfaz (D5). */
interface MappedOperations {
  operations: IrOperation[];
  imports: string[];
  registered: { signature: string; label: string }[];
}

/**
 * Mapea las operaciones de un clasificador a stubs Java (contradicción 2 de la
 * propuesta, D5). Compartido por las clases y por las interfaces (D2): la firma
 * es el nombre más los tipos Java de los parámetros después de mapear, sin el
 * retorno, así que `foo(int)` y `foo(Integer)` comparten clave y bloquean.
 */
function mapOperations(
  ownerId: string,
  ctx: BuildContext,
  blockers: CodegenFinding[],
  notes: CodegenNote[],
): MappedOperations {
  const operations: IrOperation[] = [];
  const imports: string[] = [];
  const registered: { signature: string; label: string }[] = [];
  for (const operation of ctx.operationsByOwner.get(ownerId) ?? []) {
    const operationName = operation.name;
    const ownParameters = ctx.parametersByOperation.get(operation.id) ?? [];
    const parameters = ownParameters.filter((p) => p.direction !== 'RETURN');
    const returnParameter = ownParameters.find((p) => p.direction === 'RETURN');

    const parameterResults: IrParameter[] = [];
    let skippedParameter = false;
    for (const parameter of parameters) {
      const resolvedType = resolveType(parameter.typeElementId, parameter.typeName, ctx);
      if (resolvedType.status !== 'ok') {
        skippedParameter = true;
        break;
      }
      parameterResults.push({
        name: memberName(parameter.name).name || 'p',
        type: resolvedType.type as IrTypeRef,
      });
    }
    if (skippedParameter) {
      notes.push(note('operation_skipped', [ctx.ref(ownerId)], `${operationName}: parámetro de tipo no emitido`));
      continue;
    }

    let returns = 'void';
    let returnImports: string[] = [];
    if (returnParameter) {
      const resolvedReturn = resolveType(returnParameter.typeElementId, returnParameter.typeName, ctx);
      if (resolvedReturn.status !== 'ok') {
        notes.push(note('operation_skipped', [ctx.ref(ownerId)], `${operationName}: retorno de tipo no emitido`));
        continue;
      }
      const returnType = resolvedReturn.type as IrTypeRef;
      returns = returnType.java;
      returnImports = returnType.imports;
    }

    const member = memberName(operationName);
    if (member.unrepresentable) {
      blockers.push(blocker('name_unrepresentable', [ctx.ref(ownerId)], operationName));
      continue;
    }
    const signature = `${member.name}(${parameterResults.map((p) => p.type.java).join(',')})`;
    const operationImports = sortedUnique([...parameterResults.flatMap((p) => p.type.imports), ...returnImports]);
    imports.push(...operationImports);
    registered.push({ signature, label: operationName });
    operations.push({
      elementId: operation.id,
      name: member.name,
      signature,
      parameters: parameterResults,
      returns,
      imports: operationImports,
    });
    if (member.escaped) {
      notes.push(note('name_escaped', [ctx.ref(ownerId)], `${operationName} → ${member.name}`));
    }
  }
  return { operations, imports, registered };
}

/**
 * Clasifica las clases y resuelve la jerarquía de `GENERALIZATION` (D2, tareas
 * 4.1 y 4.2) ANTES de la Fase B: quién se emite, quién es la raíz, quién cuelga
 * de quién y qué relaciones lo bloquean. `source` = hija, `target` = padre.
 */
function buildClassNodes(
  content: DiagramContent,
  ctx: BuildContext,
  blockers: CodegenFinding[],
  notes: CodegenNote[],
): Map<string, ClassNode> {
  const nodes = new Map<string, ClassNode>();
  for (const el of content.elements) {
    if (el.kind !== 'CLASS') continue;
    const rawName = el.name ?? '';
    const stereotype = (el.stereotype ?? '').trim().toLowerCase();
    const resolved = typeName(rawName);
    let role: ClassRole = 'skipped';
    if (stereotype === 'mappedsuperclass') role = el.isAbstract ? 'mappedSuperclass' : 'skipped';
    else if (stereotype === '' || stereotype === 'entity') role = 'entity';
    nodes.set(el.id, {
      elementId: el.id,
      rawName,
      role,
      isAbstract: el.isAbstract,
      javaName: resolved.unrepresentable ? null : resolved.name,
      parents: [],
      parentElementId: null,
      childrenElementIds: [],
      hasEmittedChild: false,
      hasConcreteDescendant: false,
      emitted: false,
    });
  }
  for (const rel of content.relationships) {
    if (rel.kind !== 'GENERALIZATION') continue;
    const child = nodes.get(rel.sourceElementId);
    const parent = nodes.get(rel.targetElementId);
    if (child === undefined || parent === undefined) continue;
    child.parents.push({ elementId: parent.elementId, relationship: rel });
    parent.childrenElementIds.push(child.elementId);
  }

  const hasConcreteDescendant = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) return false;
    if (node.role === 'entity' && !node.isAbstract) return true;
    return node.childrenElementIds.some((child) => hasConcreteDescendant(child, seen));
  };
  const emits = (node: ClassNode): boolean => {
    if (node.role === 'mappedSuperclass') return true;
    if (node.role === 'entity') return !node.isAbstract || node.hasConcreteDescendant;
    return false;
  };

  for (const node of nodes.values()) {
    node.hasConcreteDescendant = hasConcreteDescendant(node.elementId, new Set());
  }
  for (const node of nodes.values()) {
    node.hasEmittedChild = node.childrenElementIds.some((child) => {
      const c = nodes.get(child);
      return c !== undefined && emits(c);
    });
    node.emitted = emits(node);
  }

  for (const node of nodes.values()) {
    if (!node.emitted) continue;
    // Padres EMITIBLES: solo ellos hacen jerarquía. Un padre omitido o una
    // interfaz dejan a la hija sin `extends` (D2).
    const emittedParents = node.parents.filter((parent) => {
      const p = nodes.get(parent.elementId);
      return p !== undefined && p.emitted && (p.role === 'entity' || p.role === 'mappedSuperclass');
    });
    if (emittedParents.length > 1) {
      blockers.push(
        blocker(
          'multiple_inheritance',
          [ctx.ref(node.elementId)],
          `${node.rawName}: ${emittedParents.length} padres emitibles`,
          emittedParents.map((parent) => relationshipRef(parent.relationship, ctx)),
        ),
      );
    }
    node.parentElementId = emittedParents[0]?.elementId ?? null;
    const parentNode = node.parentElementId === null ? null : (nodes.get(node.parentElementId) ?? null);
    if (node.role === 'mappedSuperclass' && parentNode !== null && parentNode.role === 'entity' && parentNode.emitted) {
      blockers.push(
        blocker('mapped_superclass_not_root', [ctx.ref(node.elementId)], `${node.rawName}: @MappedSuperclass con un ancestro entidad`),
      );
    }
    if (parentNode !== null && parentNode.emitted) {
      const declaresId = (ctx.attributesByOwner.get(node.elementId) ?? []).some((a) => a.name.toLowerCase() === 'id');
      if (declaresId) {
        blockers.push(
          blocker('pk_in_subclass', [ctx.ref(node.elementId)], `${node.rawName}: declara id y no es la raíz de su jerarquía`),
        );
      }
    }
  }
  return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto — lo que comparten las fases
// ─────────────────────────────────────────────────────────────────────────────

interface BuildContext {
  elementById: Map<string, UmlElementView>;
  ref: (id: string) => CodegenElementRef;
  attributesByOwner: Map<string, UmlFeatureView[]>;
  operationsByOwner: Map<string, UmlFeatureView[]>;
  parametersByOperation: Map<string, UmlParameterView[]>;
  enumByElementId: Map<string, IrEnum>;
  enumLiteralsByElementId: Map<string, UmlEnumLiteralView[]>;
}

function buildContext(content: DiagramContent): BuildContext {
  const elementById = new Map<string, UmlElementView>();
  const qualifiedIndex: ElementIndex = {};
  for (const el of content.elements) {
    elementById.set(el.id, el);
    qualifiedIndex[el.id] = { parentId: el.parentId, name: el.name, kind: el.kind };
  }

  const attributesByOwner = new Map<string, UmlFeatureView[]>();
  for (const [owner, list] of groupBy(content.features.filter((f) => f.kind === 'ATTRIBUTE'), (f) => f.ownerId)) {
    attributesByOwner.set(owner, byPosition(list));
  }
  const operationsByOwner = new Map<string, UmlFeatureView[]>();
  for (const [owner, list] of groupBy(content.features.filter((f) => f.kind === 'OPERATION'), (f) => f.ownerId)) {
    operationsByOwner.set(owner, byPosition(list));
  }
  const parametersByOperation = new Map<string, UmlParameterView[]>();
  for (const [op, list] of groupBy(content.parameters, (p) => p.operationId)) {
    parametersByOperation.set(op, byPosition(list));
  }
  const enumLiteralsByElementId = new Map<string, UmlEnumLiteralView[]>();
  for (const [en, list] of groupBy(content.enumLiterals, (l) => l.enumerationId)) {
    enumLiteralsByElementId.set(en, byPosition(list));
  }

  return {
    elementById,
    ref: (id) => ({ id, qualifiedName: qualifiedName(id, qualifiedIndex) }),
    attributesByOwner,
    operationsByOwner,
    parametersByOperation,
    enumByElementId: new Map(),
    enumLiteralsByElementId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrada principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Construye la IR. Función pura: no toca base, no escribe nada, no depende del
 * reloj ni del azar. Dos corridas sobre el mismo contenido dan el mismo
 * resultado, que es lo que SC-F11 necesita de la IR.
 */
export function buildIr(content: DiagramContent, validationReport: ValidationReport): CodegenIr {
  const { blocking, warnings } = extractValidation(validationReport);
  const ctx = buildContext(content);

  const generatorBlockers: CodegenFinding[] = [];
  const generatorNotes: CodegenNote[] = [];
  const typeSets: TypeSet[] = [];

  // ── Fase A: enumeraciones ─────────────────────────────────────────────────
  const enums: IrEnum[] = [];
  for (const el of content.elements) {
    if (el.kind !== 'ENUMERATION') continue;
    const rawName = el.name ?? '';
    const resolved = typeName(rawName);
    if (resolved.unrepresentable) {
      generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], rawName));
      continue;
    }
    const rawLiterals = ctx.enumLiteralsByElementId.get(el.id) ?? [];
    if (rawLiterals.length === 0) {
      generatorNotes.push(note('classifier_skipped', [ctx.ref(el.id)], `${rawName}: enumeración sin literales`));
      continue;
    }
    const literalOwners = new Map<string, string[]>();
    const literals: { elementId: string; name: string }[] = [];
    for (const literal of rawLiterals) {
      const lit = enumLiteralName(literal.name);
      if (lit.unrepresentable) {
        generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], literal.name));
        continue;
      }
      const key = collisionKey(lit.name);
      const owners = literalOwners.get(key);
      if (owners) owners.push(literal.name);
      else literalOwners.set(key, [literal.name]);
      literals.push({ elementId: literal.id, name: lit.name });
      if (lit.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `literal ${literal.name} → ${lit.name}`));
      }
    }
    for (const [, owners] of literalOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(el.id)], `literales de ${rawName}: ${owners.join(', ')}`),
        );
      }
    }
    if (resolved.escaped) {
      generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `${rawName} → ${resolved.name}`));
    }
    const irEnum: IrEnum = { elementId: el.id, name: resolved.name, literals };
    enums.push(irEnum);
    ctx.enumByElementId.set(el.id, irEnum);
    typeSets.push({ elementId: el.id, label: `enumeración ${rawName}`, keys: new Map([[collisionKey(resolved.name), resolved.name]]) });
  }

  // ── Fase A.2: interfaces (D2, tarea 4.3) ─────────────────────────────────
  //
  // Un `INTERFACE` con operaciones mapeables se emite como `interface` Java en
  // `entity/`, con sus firmas ya resueltas: son las que después usan los stubs
  // de las clases que lo realizan. Antes de esta fase, `INTERFACE` se omitía y
  // toda `INTERFACE_REALIZATION` quedaba declarada como `relationship_not_emitted`
  // (decisión de alcance de la Fase 2).
  const interfaces: IrInterface[] = [];
  const interfaceByElementId = new Map<string, IrInterface>();
  for (const el of content.elements) {
    if (el.kind !== 'INTERFACE') continue;
    const rawName = el.name ?? '';
    const resolvedName = typeName(rawName);
    if (resolvedName.unrepresentable) {
      generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], rawName));
      continue;
    }
    if (resolvedName.escaped) {
      generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `${rawName} → ${resolvedName.name}`));
    }
    const mapped = mapOperations(el.id, ctx, generatorBlockers, generatorNotes);
    const irInterface: IrInterface = {
      elementId: el.id,
      name: resolvedName.name,
      extends: [],
      methods: mapped.operations,
    };
    interfaces.push(irInterface);
    interfaceByElementId.set(el.id, irInterface);
    typeSets.push({
      elementId: el.id,
      label: `interfaz ${rawName}`,
      keys: new Map([[collisionKey(resolvedName.name), resolvedName.name]]),
    });
  }
  // `extends` de una interfaz: generalización entre interfaces. Java admite
  // herencia múltiple de interfaces, así que el costo es cero (D2).
  for (const el of content.elements) {
    if (el.kind !== 'INTERFACE') continue;
    const irInterface = interfaceByElementId.get(el.id);
    if (irInterface === undefined) continue;
    const parents: string[] = [];
    for (const rel of content.relationships) {
      if (rel.kind !== 'GENERALIZATION' || rel.sourceElementId !== el.id) continue;
      const parent = interfaceByElementId.get(rel.targetElementId);
      if (parent) parents.push(parent.name);
    }
    irInterface.extends = sortedUnique(parents);
  }

  // ── Fase A.3: jerarquías de generalización (D2, tareas 4.1 y 4.2) ────────
  const classNodes = buildClassNodes(content, ctx, generatorBlockers, generatorNotes);
  const realizationsBySource = groupBy(
    content.relationships.filter((rel) => rel.kind === 'INTERFACE_REALIZATION'),
    (rel) => rel.sourceElementId,
  );

  // ── Fase B: entidades ─────────────────────────────────────────────────────
  const entities: IrEntity[] = [];
  const tableOwners = new Map<string, { name: string; ids: string[]; labels: string[] }>();
  const routeOwners = new Map<string, { name: string; ids: string[]; labels: string[] }>();
  // Espacio de unicidad "restricciones e índices del esquema" (D8), nuevo en
  // esta rebanada: PostgreSQL exige nombres de índice únicos por esquema, así
  // que `pk_*`, `fk_*` y `uk_*` comparten un solo conjunto.
  const constraintOwners = new Map<
    string,
    { name: string; entries: { elements: CodegenElementRef[]; relationships: CodegenRelationshipRef[]; label: string }[] }
  >();
  // Lo que la pasada de asociaciones necesita para completar cada entidad
  // (campos de relación, componentes de DTO, columnas FK) y para emitir las
  // colisiones de nombres DESPUÉS de agregarlos.
  const entityBuilds = new Map<string, EntityBookkeeping>();

  for (const el of content.elements) {
    if (el.kind !== 'CLASS') continue;
    const rawName = el.name ?? '';
    const node = classNodes.get(el.id);
    if (node === undefined || !node.emitted) {
      generatorNotes.push(note('classifier_skipped', [ctx.ref(el.id)], skipDetail(el, node)));
      continue;
    }
    const parentNode = node.parentElementId === null ? null : (classNodes.get(node.parentElementId) ?? null);
    const parentMappedSuperclass = parentNode !== null && parentNode.role === 'mappedSuperclass';
    const hasParent = parentNode !== null;

    const resolvedName = typeName(rawName);
    if (resolvedName.unrepresentable) {
      generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], rawName));
      continue;
    }
    if (resolvedName.escaped) {
      generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `${rawName} → ${resolvedName.name}`));
    }

    const attributes = ctx.attributesByOwner.get(el.id) ?? [];
    const operations = ctx.operationsByOwner.get(el.id) ?? [];
    const fields: IrField[] = [];
    const imports: string[] = [];
    const memberOwners = new Map<string, string[]>();
    const columnOwners = new Map<string, string[]>();
    const dtoOwners = new Map<string, string[]>();

    const registerMember = (name: string): void => {
      const key = collisionKey(name);
      const owners = memberOwners.get(key);
      if (owners) owners.push(name);
      else memberOwners.set(key, [name]);
    };
    const registerColumn = (column: string): void => {
      const key = collisionKey(column);
      const owners = columnOwners.get(key);
      if (owners) owners.push(column);
      else columnOwners.set(key, [column]);
    };
    const registerDto = (name: string): void => {
      const key = collisionKey(name);
      const owners = dtoOwners.get(key);
      if (owners) owners.push(name);
      else dtoOwners.set(key, [name]);
    };

    // PK declarada o inyectada (D5). En una jerarquía la PK vive en la clase
    // más alta (D2): una hija no la inyecta ni la declara —si la declara,
    // bloquea `pk_in_subclass`— y la hereda del ancestro.
    const idAttr = attributes.find((a) => a.name.toLowerCase() === 'id');
    let idInjected = false;
    if (hasParent) {
      // La PK vive en la clase más alta de la jerarquía (D2): una hija no la
      // inyecta ni la declara, la hereda. Si la declara, la Fase A.3 ya emitió
      // `pk_in_subclass`; acá solo se omite el campo propio.
    } else if (idAttr) {
      const idField = resolveIdField(idAttr, resolvedName.name, ctx, generatorBlockers, generatorNotes);
      if (idField) {
        fields.push(idField);
        registerMember(idField.name);
        registerColumn(idField.column);
        imports.push(...idField.type.imports);
      }
    } else {
      idInjected = true;
      fields.push(injectedIdField());
      registerMember('id');
      registerColumn('id');
      generatorNotes.push(note('pk_injected', [ctx.ref(el.id)], `${resolvedName.name}: Long id (IDENTITY)`));
    }

    // Atributos por la tabla de D5.
    for (const attribute of attributes) {
      if (idAttr && attribute.id === idAttr.id) continue;
      const attributeName = attribute.name;
      const skipReason = attributeSkipReason(attribute);
      if (skipReason !== null) {
        generatorNotes.push(note('attribute_skipped', [ctx.ref(el.id)], `${attributeName}: ${skipReason}`));
        continue;
      }
      const resolvedType = resolveType(attribute.typeElementId, attribute.typeName, ctx);
      if (resolvedType.status === 'unknown') {
        generatorNotes.push(note('unknown_type', [ctx.ref(el.id)], `${attributeName}: ${describeType(attribute)}`));
        continue;
      }
      if (resolvedType.status === 'skip') {
        generatorNotes.push(note('attribute_skipped', [ctx.ref(el.id)], `${attributeName}: ${resolvedType.reason}`));
        continue;
      }
      const member = memberName(attributeName);
      if (member.unrepresentable) {
        generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], attributeName));
        continue;
      }
      const column = columnName(attributeName);
      const type = resolvedType.type as IrTypeRef;
      fields.push({
        elementId: attribute.id,
        name: member.name,
        getter: `get${capitalizeName(member.name)}`,
        setter: `set${capitalizeName(member.name)}`,
        column: column.name,
        type,
        enumerated: resolvedType.enumerated === true,
        nullable: attribute.lowerBound < 1,
        isId: false,
        generation: null,
        inherited: false,
      });
      registerMember(member.name);
      registerColumn(column.name);
      imports.push(...type.imports);
      if (member.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `${attributeName} → ${member.name}`));
      }
      if (column.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `columna ${attributeName} → ${column.name}`));
      }
      if (attribute.defaultValue !== null) {
        generatorNotes.push(note('default_value_ignored', [ctx.ref(el.id)], `${attributeName} = ${attribute.defaultValue}`));
      }
    }

    // Componentes de los `record` DTO (D1, D5): la PK primero —solo en la
    // respuesta—, después los atributos, que viajan en las dos. La pasada de
    // asociaciones agrega los componentes de relación. Se registran en su
    // propio espacio porque los componentes comparten nombre con los campos.
    const dtoFields: IrDtoField[] = fields.map((field) => {
      registerDto(field.name);
      return { name: field.name, type: field.type.java, imports: field.type.imports, inRequest: !field.isId };
    });

    // Operaciones: stub con la clave de firma ya mapeada (contradicción 2, D5).
    const irOperations: IrOperation[] = [];
    const methodOwners = new Map<string, { label: string; operation: boolean }[]>();
    const registerMethod = (key: string, label: string, operation: boolean): void => {
      const k = collisionKey(key);
      const owners = methodOwners.get(k);
      if (owners) owners.push({ label, operation });
      else methodOwners.set(k, [{ label, operation }]);
    };
    for (const objectSignature of OBJECT_METHOD_SIGNATURES) registerMethod(objectSignature, 'Object', false);
    for (const field of fields) {
      registerMethod(`${field.getter}()`, `accesor ${field.getter}`, false);
      registerMethod(`${field.setter}(${field.type.java})`, `accesor ${field.setter}`, false);
    }

    const mappedOperations = mapOperations(el.id, ctx, generatorBlockers, generatorNotes);
    for (const registered of mappedOperations.registered) {
      registerMethod(registered.signature, `operación ${registered.label}`, true);
    }
    irOperations.push(...mappedOperations.operations);
    imports.push(...mappedOperations.imports);
    for (const [, owners] of methodOwners) {
      if (owners.length > 1 && owners.some((o) => o.operation)) {
        const labels = owners.filter((o) => o.operation || o.label !== 'Object').map((o) => o.label);
        const objectClash = owners.some((o) => o.label === 'Object');
        generatorBlockers.push(
          blocker(
            'operation_signature_collision',
            [ctx.ref(el.id)],
            `${resolvedName.name}: ${labels.join(' y ')}${objectClash ? ' (colisiona con un método de Object)' : ''}`,
          ),
        );
      }
    }

    // Realización de interfaces (D2, tarea 4.3): `implements` más un stub por
    // cada método que la clase no declare. Un método declarado con la misma
    // firma y el mismo retorno ya satisface la interfaz (`@Override`); con
    // retorno distinto, bloquea.
    const implementsInterfaces: string[] = [];
    for (const rel of realizationsBySource.get(el.id) ?? []) {
      const target = interfaceByElementId.get(rel.targetElementId);
      if (target === undefined) continue;
      implementsInterfaces.push(target.name);
      for (const method of target.methods) {
        const declared = irOperations.find((op) => op.signature === method.signature);
        if (declared !== undefined) {
          if (declared.returns !== method.returns) {
            generatorBlockers.push(
              blocker(
                'inherited_member_collision',
                [ctx.ref(el.id)],
                `${resolvedName.name}.${method.signature}: retorno distinto al declarado por ${target.name}`,
              ),
            );
          }
          continue;
        }
        const clash = methodOwners.get(collisionKey(method.signature));
        if (clash !== undefined && clash.some((owner) => owner.label !== 'Object')) {
          generatorBlockers.push(
            blocker('inherited_member_collision', [ctx.ref(el.id)], `${resolvedName.name}.${method.signature}: choca con un miembro existente`),
          );
          continue;
        }
        irOperations.push(method);
        registerMethod(method.signature, `interfaz ${target.name}`, true);
        imports.push(...method.imports);
      }
    }

    // Tabla, entidad JPA y ruta. Un `@MappedSuperclass` no tiene tabla propia
    // ni ruta: sus atributos y su PK bajan a la tabla de cada hija, que pasa a
    // ser raíz de su propia tabla (D2).
    const table = tableName(rawName);
    const hql = hqlEntityName(rawName);
    const route = routeSegment(rawName);
    if (node.role !== 'mappedSuperclass') {
      if (route.unrepresentable) {
        generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], rawName));
        continue;
      }
      if (table.escaped) {
        const detail = table.truncated
          ? `tabla ${rawName} → ${table.name} (recortada a 63 bytes UTF-8)`
          : `tabla ${rawName} → ${table.name}`;
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], detail));
      }
      if (hql.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `entidad JPA ${rawName} → ${hql.name}`));
      }
      if (route.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `ruta ${rawName} → /${route.name}`));
      }
      if (route.asciiFolded) {
        generatorNotes.push(note('route_ascii_folded', [ctx.ref(el.id)], `${rawName} → /${route.name}`));
      }
    }

    const derivedTypeNames = buildDerivedTypeNames(resolvedName.name);
    // La raíz `JOINED` es la clase con hijas emitidas que no cuelga de otra
    // entidad: la que lleva `@Inheritance(strategy = JOINED)` y la PK (D2).
    const inheritanceRoot = node.role !== 'mappedSuperclass' && node.hasEmittedChild && (!hasParent || parentMappedSuperclass);
    const hasOwnId = fields.some((field) => field.isId);
    const jpaImports = ['jakarta.persistence.Column'];
    if (node.role === 'mappedSuperclass') {
      jpaImports.push('jakarta.persistence.MappedSuperclass');
    } else {
      jpaImports.push('jakarta.persistence.Entity', 'jakarta.persistence.Table');
    }
    if (hasOwnId) {
      jpaImports.push('jakarta.persistence.GeneratedValue', 'jakarta.persistence.GenerationType', 'jakarta.persistence.Id');
    }
    if (inheritanceRoot) {
      jpaImports.push('jakarta.persistence.Inheritance', 'jakarta.persistence.InheritanceType');
    }
    if (hasParent && !parentMappedSuperclass) {
      jpaImports.push('jakarta.persistence.PrimaryKeyJoinColumn');
    }
    if (fields.some((f) => f.enumerated)) {
      jpaImports.push('jakarta.persistence.EnumType', 'jakarta.persistence.Enumerated');
    }

    const entity: IrEntity = {
      elementId: el.id,
      name: resolvedName.name,
      hqlName: hql.name,
      table: table.name,
      route: route.name,
      fields,
      operations: irOperations,
      // Herencia e interfaces, resueltas en la Fase A.3 y acá arriba (D1, D2).
      superclass: parentNode === null ? null : parentNode.javaName,
      inheritanceRoot,
      isAbstract: el.isAbstract,
      mappedSuperclass: node.role === 'mappedSuperclass',
      parentMappedSuperclass,
      implementsInterfaces: sortedUnique(implementsInterfaces),
      relations: [],
      dtoFields,
      derivedTypeNames,
      imports: sortedUnique([...jpaImports, ...imports]),
      idInjected,
    };
    entities.push(entity);
    entityBuilds.set(el.id, {
      entity,
      label: resolvedName.name,
      memberOwners,
      columnOwners,
      dtoOwners,
      extraImports: [],
    });

    const keys = new Map<string, string>([[collisionKey(resolvedName.name), resolvedName.name]]);
    for (const derived of derivedTypeNames) keys.set(collisionKey(derived), derived);
    typeSets.push({ elementId: el.id, label: `clase ${rawName}`, keys });

    if (node.role !== 'mappedSuperclass') {
      registerNamespace(tableOwners, table.name, el.id, `tabla de ${resolvedName.name}`);
      registerNamespace(routeOwners, route.name, el.id, `ruta de ${resolvedName.name}`);
    }
  }

  // ── Fase B.2: aplanado de campos heredados (D2) ───────────────────────────
  //
  // La PK y los atributos bajan del ancestro al descendiente: el DTO los ve
  // (los `record` no heredan) y el mapper los escribe con el accesor heredado.
  // `entity.ts` NO los vuelve a declarar y `flyway.ts` materializa solo los que
  // corresponden —la PK de una hija `JOINED`, o todos los atributos si el
  // ancestro es un `@MappedSuperclass`—.
  flattenInheritedFields(entities, classNodes);

  // ── Fase C: colisiones de tipos ───────────────────────────────────────────
  // Se comparan CONJUNTOS de tipos, no nombres sueltos: `Order` y `order`
  // chocan en los ocho tipos que cada uno aporta, y reportar ocho hallazgos por
  // el mismo par sería ruido, no información.
  for (let i = 0; i < typeSets.length; i += 1) {
    for (let j = i + 1; j < typeSets.length; j += 1) {
      const a = typeSets[i] as TypeSet;
      const b = typeSets[j] as TypeSet;
      const shared = [...a.keys.entries()]
        .filter(([key]) => b.keys.has(key))
        .map(([, display]) => display);
      if (shared.length > 0) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(a.elementId), ctx.ref(b.elementId)], `tipos compartidos: ${shared.join(', ')}`),
        );
      }
    }
  }
  // `Application` ocupa el espacio de tipos aunque no venga del modelo (D3, D11).
  const applicationKey = collisionKey('Application');
  for (const set of typeSets) {
    if (set.keys.has(applicationKey)) {
      generatorBlockers.push(
        blocker('name_collision', [ctx.ref(set.elementId)], `el nombre Application choca con la clase de arranque generada`),
      );
    }
  }
  // ── Fase D: asociaciones, agregación, herencia y grafo obligatorio (D3, D4, D8, D9) ──
  //
  // Acá se decide la forma (simple–múltiple, simple–simple, múltiple–múltiple), el
  // lado dueño, el `mappedBy`, la nulabilidad, las columnas FK, las join tables y
  // las restricciones; y —con la agregación ya resuelta— la cascada del lado TODO
  // (D4). `GENERALIZATION` e `INTERFACE_REALIZATION` se emiten: los atendieron la
  // Fase A.2/A.3 y el aplanado de las fases B.2 y D.2. Lo único que queda sin
  // emitir son los extremos sobre no-entidad y `DEPENDENCY`/`USAGE`.
  const joinTables: IrJoinTable[] = [];
  const foreignKeys: IrForeignKey[] = [];
  const uniques: IrUnique[] = [];
  // Aristas del grafo de referencias obligatorias (D9): una por FK `NOT NULL`.
  const mandatoryEdges: MandatoryEdge[] = [];
  const endsByRelationship = groupBy(content.relationshipEnds, (end) => end.relationshipId);

  const shortenSql = (
    raw: string,
    elements: CodegenElementRef[],
    relationships: CodegenRelationshipRef[],
    what: string,
  ): string => {
    const name = sqlIdent(raw);
    if (isSqlIdentifierShortened(raw)) {
      generatorNotes.push(
        note('name_shortened', elements, `${what} ${raw} → ${name} (acortado a 63 bytes UTF-8)`, relationships),
      );
    }
    return name;
  };

  const registerConstraint = (
    rawName: string,
    elements: CodegenElementRef[],
    relationships: CodegenRelationshipRef[],
    label: string,
  ): string => {
    const name = shortenSql(rawName, elements, relationships, 'restricción');
    const key = collisionKey(name);
    const entry = constraintOwners.get(key);
    if (entry) entry.entries.push({ elements, relationships, label });
    else constraintOwners.set(key, { name, entries: [{ elements, relationships, label }] });
    return name;
  };

  const ownIn = (registry: Map<string, string[]>, name: string): void => {
    const key = collisionKey(name);
    const owners = registry.get(key);
    if (owners) owners.push(name);
    else registry.set(key, [name]);
  };

  const pkField = (build: EntityBookkeeping): IrField => {
    const id = build.entity.fields.find((field) => field.isId);
    if (id === undefined) {
      throw new Error(`la IR de ${build.entity.name} no tiene clave primaria y no está bloqueada`);
    }
    return id;
  };

  /** `rol ?? camel(Clase)` del extremo apuntado; `null` si no deja ninguna palabra (D5, D3). */
  const fieldBase = (side: RelationshipSide): string | null => {
    const declared = (side.other.roleName ?? '').trim();
    const resolved = memberName(declared === '' ? side.otherBuild.entity.name : declared);
    return resolved.unrepresentable || resolved.name === '' ? null : resolved.name;
  };

  const relationJpaImports = (relation: IrRelationField, targetType: string): string[] => {
    const imports = [`${ENTITY_PACKAGE}.${targetType}`, `jakarta.persistence.${relation.kind}`];
    if (relation.kind === 'ManyToOne' || relation.kind === 'OneToOne') imports.push('jakarta.persistence.FetchType');
    if (relation.joinColumn !== null) imports.push('jakarta.persistence.JoinColumn');
    if (relation.joinTable !== null) imports.push('jakarta.persistence.JoinColumn', 'jakarta.persistence.JoinTable');
    if (relation.kind === 'OneToMany' || relation.kind === 'ManyToMany') {
      imports.push('java.util.ArrayList', 'java.util.List');
    }
    return imports;
  };

  const collectionOf = (relation: IrRelationField): boolean =>
    relation.kind === 'OneToMany' || relation.kind === 'ManyToMany';

  /**
   * Cascada del lado TODO según su agregación (D4). `aggregation` marca el
   * extremo que ES el TODO: `SHARED` → `{PERSIST, MERGE}`; `COMPOSITE` → `ALL`
   * más `orphanRemoval` sobre el `mappedBy` del TODO; sin agregación, `NONE`.
   */
  const cascadeFor = (end: UmlRelationshipEndView): Pick<IrRelationField, 'cascade' | 'orphanRemoval'> =>
    end.aggregation === 'SHARED'
      ? { cascade: 'PERSIST_MERGE', orphanRemoval: false }
      : end.aggregation === 'COMPOSITE'
        ? { cascade: 'ALL', orphanRemoval: true }
        : { cascade: 'NONE', orphanRemoval: false };

  /** Agrega el campo a su entidad, registra sus nombres e importaciones y suma el componente de DTO. */
  const addRelation = (side: RelationshipSide, relation: IrRelationField): void => {
    const build = side.build;
    build.entity.relations.push(relation);
    build.extraImports.push(...relationJpaImports(relation, side.otherBuild.entity.name));
    ownIn(build.memberOwners, relation.name);
    ownIn(build.dtoOwners, relation.dto.name);
    if (relation.joinColumn !== null) ownIn(build.columnOwners, relation.joinColumn.name);
    const pk = pkField(side.otherBuild);
    build.entity.dtoFields.push({
      name: relation.dto.name,
      type: collectionOf(relation) ? `List<${relation.dto.idType}>` : relation.dto.idType,
      imports: [...(collectionOf(relation) ? ['java.util.List'] : []), ...pk.type.imports],
      inRequest: relation.dto.inRequest,
    });
  };

  for (const relationship of content.relationships) {
    const elements = [ctx.ref(relationship.sourceElementId), ctx.ref(relationship.targetElementId)];
    const label = relationshipLabel(relationship, ctx);
    const relRefs: CodegenRelationshipRef[] = [{ id: relationship.id, label }];

    if (relationship.kind === 'DEPENDENCY' || relationship.kind === 'USAGE') {
      generatorNotes.push(
        note('relationship_not_emitted', elements, `${label}: ${relationship.kind} no produce código`, relRefs),
      );
      continue;
    }

    if (relationship.kind === 'GENERALIZATION') {
      const parent = classNodes.get(relationship.targetElementId);
      if (parent === undefined || !parent.emitted || (parent.role !== 'entity' && parent.role !== 'mappedSuperclass')) {
        generatorNotes.push(
          note('relationship_not_emitted', elements, `${label}: el padre no se emite y la hija queda sin extends`, relRefs),
        );
      }
      continue;
    }

    if (relationship.kind !== 'ASSOCIATION') {
      // INTERFACE_REALIZATION se emite como `implements` cuando la interfaz se
      // emite (Fase A.2); si no, se declara acá. Nunca se pierde en silencio
      // (D2) y `relationship_deferred` ya no existe (D1).
      if (relationship.kind !== 'INTERFACE_REALIZATION' || !interfaceByElementId.has(relationship.targetElementId)) {
        generatorNotes.push(
          note('relationship_not_emitted', elements, `${label}: ${relationship.kind} no produce código`, relRefs),
        );
      }
      continue;
    }

    // Un `@MappedSuperclass` no tiene tabla: no puede ser extremo de una
    // asociación (D2, bloqueo `mapped_superclass_as_association_end`).
    if ([relationship.sourceElementId, relationship.targetElementId].some((id) => classNodes.get(id)?.role === 'mappedSuperclass')) {
      generatorBlockers.push(
        blocker(
          'mapped_superclass_as_association_end',
          elements,
          `${label}: un extremo es un @MappedSuperclass y no tiene tabla`,
          relRefs,
        ),
      );
      continue;
    }

    const ends = [...(endsByRelationship.get(relationship.id) ?? [])].sort((a, b) => a.endIndex - b.endIndex);
    const end0 = ends.find((end) => end.endIndex === 0);
    const end1 = ends.find((end) => end.endIndex === 1);
    const sourceBuild = entityBuilds.get(relationship.sourceElementId);
    const targetBuild = entityBuilds.get(relationship.targetElementId);
    if (!end0 || !end1 || !sourceBuild || !targetBuild) {
      // D9: un destino obligatorio que sea una clase abstracta sin descendiente
      // concreto no se puede instanciar para el fixture → bloqueo, no nota.
      for (const endpointId of [relationship.sourceElementId, relationship.targetElementId]) {
        const node = classNodes.get(endpointId);
        if (node === undefined || node.role !== 'entity' || !node.isAbstract || node.hasConcreteDescendant) continue;
        // La FK es `NOT NULL` si el extremo SOBRE el destino ausente tiene
        // `lower ≥ 1` (D3): es el destino obligatorio inalcanzable (D9).
        const targetEnd = endpointId === relationship.sourceElementId ? end0 : end1;
        if (targetEnd !== undefined && targetEnd.lowerBound >= 1) {
          generatorBlockers.push(
            blocker(
              'unsatisfiable_mandatory_reference',
              elements,
              `${label}: destino abstracto sin descendiente concreto`,
              relRefs,
            ),
          );
        }
      }
      generatorNotes.push(
        note('relationship_not_emitted', elements, `${label}: un extremo no se emite como entidad`, relRefs),
      );
      continue;
    }

    // «Simple» = `upper ≤ 1`; «múltiple» = `upper` nulo o `> 1` (D3).
    const simple0 = end0.upperBound !== null && end0.upperBound <= 1;
    const simple1 = end1.upperBound !== null && end1.upperBound <= 1;
    const sideOf = (source: boolean): RelationshipSide =>
      source
        ? { build: sourceBuild, end: end0, other: end1, otherBuild: targetBuild }
        : { build: targetBuild, end: end1, other: end0, otherBuild: sourceBuild };

    // Agregación marcada en los DOS extremos: no hay TODO determinista (D4).
    const aggregationConflict = end0.aggregation !== 'NONE' && end1.aggregation !== 'NONE';

    if (simple0 !== simple1) {
      // ── simple — múltiple: la FK vive en la tabla del extremo múltiple ────
      // D4: con agregación en los dos extremos no hay TODO determinista.
      if (aggregationConflict) {
        generatorBlockers.push(
          blocker('ambiguous_aggregation', elements, `${label}: agregación declarada en los dos extremos`, relRefs),
        );
        continue;
      }
      const owner = simple0 ? sideOf(false) : sideOf(true);
      const inverse = simple0 ? sideOf(true) : sideOf(false);
      const ownerBase = fieldBase(owner);
      const inverseBase = fieldBase(inverse);
      if (ownerBase === null || inverseBase === null) {
        generatorBlockers.push(blocker('name_unrepresentable', elements, `${label}: nombre de rol vacío`));
        continue;
      }
      const targetPk = pkField(owner.otherBuild);
      const column = shortenSql(`${snakeCase(ownerBase)}_id`, elements, relRefs, 'columna FK');
      const nullable = owner.other.lowerBound < 1;
      // El TODO es el extremo marcado; su campo hacia la parte lleva la
      // cascada. En `simple—múltiple` la FK cae siempre en el extremo múltiple,
      // así que si el TODO es el extremo simple su campo es el INVERSO: se
      // emite igual aunque no sea navegable (D4, `navigability_widened`).
      const ownerIsSource = !simple0;
      const todoEnd = end0.aggregation !== 'NONE' ? end0 : end1.aggregation !== 'NONE' ? end1 : null;
      const todoIsOwner = todoEnd !== null && (todoEnd.endIndex === 0) === ownerIsSource;
      const ownerCascade =
        todoEnd !== null && todoIsOwner ? cascadeFor(todoEnd) : { cascade: 'NONE' as const, orphanRemoval: false };
      const inverseCascade =
        todoEnd !== null && !todoIsOwner ? cascadeFor(todoEnd) : { cascade: 'NONE' as const, orphanRemoval: false };
      const ownerRelation: IrRelationField = {
        name: ownerBase,
        target: owner.otherBuild.entity.name,
        kind: 'ManyToOne',
        owning: true,
        mappedBy: null,
        cascade: ownerCascade.cascade,
        orphanRemoval: ownerCascade.orphanRemoval,
        joinColumn: { name: column, nullable, unique: false },
        joinTable: null,
        dto: { name: `${ownerBase}Id`, inRequest: true, required: !nullable, idType: targetPk.type.java },
        inherited: false,
      };
      addRelation(owner, ownerRelation);
      if (!owner.other.isNavigable) {
        generatorNotes.push(
          note(
            'navigability_widened',
            [ctx.ref(owner.build.entity.elementId)],
            `${label}: ${ownerBase} se emite con @ManyToOne aunque su extremo no sea navegable`,
            relRefs,
          ),
        );
      }
      foreignKeys.push({
        name: registerConstraint(
          `fk_${owner.build.entity.table}_${column}`,
          elements,
          relRefs,
          `${label}: FK de ${ownerBase}`,
        ),
        table: owner.build.entity.table,
        columns: [column],
        refTable: owner.otherBuild.entity.table,
        refColumns: [targetPk.column],
        onDeleteCascade: false,
      });
      if (!nullable) {
        mandatoryEdges.push({
          fromElementId: owner.build.entity.elementId,
          toElementId: owner.otherBuild.entity.elementId,
          relationship,
          elements,
          relationships: relRefs,
        });
      }

      if (owner.end.isNavigable || inverseCascade.cascade !== 'NONE') {
        const ownerPk = pkField(owner.build);
        addRelation(inverse, {
          name: `${inverseBase}List`,
          target: owner.build.entity.name,
          kind: 'OneToMany',
          owning: false,
          mappedBy: ownerRelation.name,
          cascade: inverseCascade.cascade,
          orphanRemoval: inverseCascade.orphanRemoval,
          joinColumn: null,
          joinTable: null,
          dto: { name: `${inverseBase}Ids`, inRequest: false, required: false, idType: ownerPk.type.java },
          inherited: false,
        });
        if (!owner.end.isNavigable) {
          generatorNotes.push(
            note(
              'navigability_widened',
              [ctx.ref(inverse.build.entity.elementId)],
              `${label}: ${inverseBase}List se emite con la cascada de la agregación aunque su extremo no sea navegable`,
              relRefs,
            ),
          );
        }
        if (owner.end.upperBound !== null && owner.end.upperBound > 1) {
          generatorNotes.push(
            note(
              'upper_bound_not_enforced',
              [ctx.ref(inverse.build.entity.elementId)],
              `${inverseBase}List: la cota superior ${owner.end.upperBound} no se aplica`,
              relRefs,
            ),
          );
        }
        if (owner.end.lowerBound >= 1) {
          generatorNotes.push(
            note(
              'collection_lower_bound_not_enforced',
              [ctx.ref(inverse.build.entity.elementId)],
              `${inverseBase}List: 1..* no se valida`,
              relRefs,
            ),
          );
        }
      }
      continue;
    }

    if (simple0 && simple1) {
      // ── simple — simple: FK `UNIQUE` en el lado dependiente ───────────────
      if (aggregationConflict) {
        generatorBlockers.push(
          blocker('ambiguous_aggregation', elements, `${label}: agregación declarada en los dos extremos`, relRefs),
        );
        continue;
      }
      // Dependiente = la PARTE si hay agregación; si no, la clase cuyo extremo
      // OPUESTO es obligatorio (así el `NOT NULL` dice algo); empate → `source`.
      const todoEnd = end0.aggregation !== 'NONE' ? end0 : end1.aggregation !== 'NONE' ? end1 : null;
      const ownerIsSource =
        todoEnd !== null ? todoEnd.endIndex !== 0 : !(end0.lowerBound >= 1 && end1.lowerBound < 1);
      const owner = sideOf(ownerIsSource);
      const inverse = sideOf(!ownerIsSource);
      const ownerBase = fieldBase(owner);
      const inverseBase = fieldBase(inverse);
      if (ownerBase === null || inverseBase === null) {
        generatorBlockers.push(blocker('name_unrepresentable', elements, `${label}: nombre de rol vacío`));
        continue;
      }
      const targetPk = pkField(owner.otherBuild);
      const column = shortenSql(`${snakeCase(ownerBase)}_id`, elements, relRefs, 'columna FK');
      const nullable = owner.other.lowerBound < 1;
      // Con agregación, el TODO es el lado INVERSO (`mappedBy`): su campo
      // `@OneToOne` lleva la cascada y se emite siempre (D4).
      const todoIsOwner = todoEnd !== null && (todoEnd.endIndex === 0) === ownerIsSource;
      const ownerCascade =
        todoEnd !== null && todoIsOwner ? cascadeFor(todoEnd) : { cascade: 'NONE' as const, orphanRemoval: false };
      const inverseCascade =
        todoEnd !== null && !todoIsOwner ? cascadeFor(todoEnd) : { cascade: 'NONE' as const, orphanRemoval: false };
      const ownerRelation: IrRelationField = {
        name: ownerBase,
        target: owner.otherBuild.entity.name,
        kind: 'OneToOne',
        owning: true,
        mappedBy: null,
        cascade: ownerCascade.cascade,
        orphanRemoval: ownerCascade.orphanRemoval,
        joinColumn: { name: column, nullable, unique: true },
        joinTable: null,
        dto: { name: `${ownerBase}Id`, inRequest: true, required: !nullable, idType: targetPk.type.java },
        inherited: false,
      };
      addRelation(owner, ownerRelation);
      if (!owner.other.isNavigable) {
        generatorNotes.push(
          note(
            'navigability_widened',
            [ctx.ref(owner.build.entity.elementId)],
            `${label}: ${ownerBase} se emite con @OneToOne aunque su extremo no sea navegable`,
            relRefs,
          ),
        );
      }
      uniques.push({
        name: registerConstraint(
          `uk_${owner.build.entity.table}_${column}`,
          elements,
          relRefs,
          `${label}: UNIQUE de ${ownerBase}`,
        ),
        table: owner.build.entity.table,
        columns: [column],
      });
      foreignKeys.push({
        name: registerConstraint(
          `fk_${owner.build.entity.table}_${column}`,
          elements,
          relRefs,
          `${label}: FK de ${ownerBase}`,
        ),
        table: owner.build.entity.table,
        columns: [column],
        refTable: owner.otherBuild.entity.table,
        refColumns: [targetPk.column],
        onDeleteCascade: false,
      });

      if (!nullable) {
        mandatoryEdges.push({
          fromElementId: owner.build.entity.elementId,
          toElementId: owner.otherBuild.entity.elementId,
          relationship,
          elements,
          relationships: relRefs,
        });
      }

      if (owner.end.isNavigable || inverseCascade.cascade !== 'NONE') {
        const ownerPk = pkField(owner.build);
        addRelation(inverse, {
          name: `${inverseBase}`,
          target: owner.build.entity.name,
          kind: 'OneToOne',
          owning: false,
          mappedBy: ownerRelation.name,
          cascade: inverseCascade.cascade,
          orphanRemoval: inverseCascade.orphanRemoval,
          joinColumn: null,
          joinTable: null,
          dto: { name: `${inverseBase}Id`, inRequest: false, required: false, idType: ownerPk.type.java },
          inherited: false,
        });
        if (!owner.end.isNavigable) {
          generatorNotes.push(
            note(
              'navigability_widened',
              [ctx.ref(inverse.build.entity.elementId)],
              `${label}: ${inverseBase} se emite con la cascada de la agregación aunque su extremo no sea navegable`,
              relRefs,
            ),
          );
        }
        if (inverse.other.lowerBound >= 1) {
          generatorNotes.push(
            note(
              'inverse_lower_bound_not_enforced',
              [ctx.ref(inverse.build.entity.elementId)],
              `${inverseBase}: 1..1 en el lado inverso no se valida`,
              relRefs,
            ),
          );
        }
      }
      continue;
    }

    // ── múltiple — múltiple: tabla intermedia con PK compuesta ──────────────
    if (aggregationConflict) {
      generatorBlockers.push(
        blocker('ambiguous_aggregation', elements, `${label}: agregación declarada en los dos extremos`, relRefs),
      );
      continue;
    }
    // Dueño: el TODO si hay agregación; si no, el extremo navegable; empate o
    // ambos navegables → `source` (D3).
    const todoEnd = end0.aggregation !== 'NONE' ? end0 : end1.aggregation !== 'NONE' ? end1 : null;
    const ownerIsSource = todoEnd !== null ? todoEnd.endIndex === 0 : !(end0.isNavigable && !end1.isNavigable);
    const todoIsOwner = todoEnd !== null && (todoEnd.endIndex === 0) === ownerIsSource;
    const owner = sideOf(ownerIsSource);
    const inverse = sideOf(!ownerIsSource);
    const ownerBase = fieldBase(owner);
    const inverseBase = fieldBase(inverse);
    if (ownerBase === null || inverseBase === null) {
      generatorBlockers.push(blocker('name_unrepresentable', elements, `${label}: nombre de rol vacío`));
      continue;
    }
    const declaredName = (relationship.name ?? '').trim();
    const joinTableName = shortenSql(
      declaredName === ''
        ? `${owner.build.entity.table}_${inverse.build.entity.table}`
        : snakeCase(declaredName),
      elements,
      relRefs,
      'tabla intermedia',
    );
    const ownerColumn = shortenSql(`${owner.build.entity.table}_id`, elements, relRefs, 'columna de join table');
    const targetColumn = shortenSql(`${snakeCase(ownerBase)}_id`, elements, relRefs, 'columna de join table');
    registerNamespace(tableOwners, joinTableName, relationship.sourceElementId, `tabla intermedia de ${label}`);
    if (collisionKey(ownerColumn) === collisionKey(targetColumn)) {
      // Autoasociación `* — *` sin roles (D7): las dos columnas salen del mismo
      // nombre y la PK compuesta no se puede crear.
      generatorBlockers.push(
        blocker('name_collision', elements, `${label}: las dos columnas de ${joinTableName} se llaman ${ownerColumn}`),
      );
      continue;
    }

    const ownerPk = pkField(owner.build);
    const targetPk = pkField(owner.otherBuild);
    const ownerCascade =
      todoEnd !== null && todoIsOwner ? cascadeFor(todoEnd) : { cascade: 'NONE' as const, orphanRemoval: false };
    const ownerRelation: IrRelationField = {
      name: `${ownerBase}List`,
      target: owner.otherBuild.entity.name,
      kind: 'ManyToMany',
      owning: true,
      mappedBy: null,
      cascade: ownerCascade.cascade,
      orphanRemoval: ownerCascade.orphanRemoval,
      joinColumn: null,
      joinTable: { name: joinTableName, ownerColumn, targetColumn },
      dto: { name: `${ownerBase}Ids`, inRequest: true, required: false, idType: targetPk.type.java },
      inherited: false,
    };
    addRelation(owner, ownerRelation);
    joinTables.push(ownerRelation.joinTable as IrJoinTable);
    if (!owner.other.isNavigable) {
      generatorNotes.push(
        note(
          'navigability_widened',
          [ctx.ref(owner.build.entity.elementId)],
          `${label}: ${ownerBase}List se emite con @ManyToMany aunque su extremo no sea navegable`,
          relRefs,
        ),
      );
    }
    if (owner.other.upperBound !== null && owner.other.upperBound > 1) {
      generatorNotes.push(
        note(
          'upper_bound_not_enforced',
          [ctx.ref(owner.build.entity.elementId)],
          `${ownerBase}List: la cota superior ${owner.other.upperBound} no se aplica`,
          relRefs,
        ),
      );
    }
    if (owner.other.lowerBound >= 1) {
      generatorNotes.push(
        note(
          'collection_lower_bound_not_enforced',
          [ctx.ref(owner.build.entity.elementId)],
          `${ownerBase}List: 1..* no se valida`,
          relRefs,
        ),
      );
    }
    foreignKeys.push({
      name: registerConstraint(
        `fk_${joinTableName}_${ownerColumn}`,
        elements,
        relRefs,
        `${label}: FK de join table hacia ${owner.build.entity.name}`,
      ),
      table: joinTableName,
      columns: [ownerColumn],
      refTable: owner.build.entity.table,
      refColumns: [ownerPk.column],
      onDeleteCascade: true,
    });
    foreignKeys.push({
      name: registerConstraint(
        `fk_${joinTableName}_${targetColumn}`,
        elements,
        relRefs,
        `${label}: FK de join table hacia ${owner.otherBuild.entity.name}`,
      ),
      table: joinTableName,
      columns: [targetColumn],
      refTable: owner.otherBuild.entity.table,
      refColumns: [targetPk.column],
      onDeleteCascade: true,
    });

    if (owner.end.isNavigable) {
      addRelation(inverse, {
        name: `${inverseBase}List`,
        target: owner.build.entity.name,
        kind: 'ManyToMany',
        owning: false,
        mappedBy: ownerRelation.name,
        cascade: 'NONE',
        orphanRemoval: false,
        joinColumn: null,
        joinTable: null,
        dto: { name: `${inverseBase}Ids`, inRequest: false, required: false, idType: ownerPk.type.java },
        inherited: false,
      });
      if (inverse.other.upperBound !== null && inverse.other.upperBound > 1) {
        generatorNotes.push(
          note(
            'upper_bound_not_enforced',
            [ctx.ref(inverse.build.entity.elementId)],
            `${inverseBase}List: la cota superior ${inverse.other.upperBound} no se aplica`,
            relRefs,
          ),
        );
      }
      if (inverse.other.lowerBound >= 1) {
        generatorNotes.push(
          note(
            'collection_lower_bound_not_enforced',
            [ctx.ref(inverse.build.entity.elementId)],
            `${inverseBase}List: 1..* no se valida`,
            relRefs,
          ),
        );
      }
    }
  }

  // ── Fase D.2: FK hija→padre de `JOINED`, aplanado y grafo obligatorio (D2, D9) ──
  //
  // La tabla de una hija `JOINED` lleva su PK —que es la FK a la PK del
  // padre— como una restricción más del bloque 3 (D9). El aplanado copia los
  // campos y relaciones del ancestro al descendiente —marcados `inherited`—
  // para que el DTO y el mapper los vean sin que la clase vuelva a mapearlos.
  for (const entity of entities) {
    if (entity.mappedSuperclass || entity.superclass === null || entity.parentMappedSuperclass) continue;
    const parent = entities.find((candidate) => candidate.name === entity.superclass);
    if (parent === undefined) continue;
    const id = entity.fields.find((field) => field.isId);
    const parentId = parent.fields.find((field) => field.isId);
    if (id === undefined || parentId === undefined) continue;
    foreignKeys.push({
      name: registerConstraint(
        `fk_${entity.table}_${id.column}`,
        [ctx.ref(entity.elementId)],
        [],
        `${entity.name}: FK de herencia JOINED`,
      ),
      table: entity.table,
      columns: [id.column],
      refTable: parent.table,
      refColumns: [parentId.column],
      onDeleteCascade: false,
    });
  }
  flattenInheritedRelations(entities, classNodes);
  rebuildDtoFields(entities);
  detectInheritedMemberCollisions(entities, classNodes, ctx, generatorBlockers);
  const fixturePlan = buildFixturePlan(entities, classNodes, mandatoryEdges, generatorBlockers);

  // ── Fase E: colisiones de nombres (D3, D8) ────────────────────────────────
  // Corre DESPUÉS de las asociaciones porque los campos de relación, las
  // columnas FK y las join tables entran en los mismos espacios que los campos
  // y las tablas del modelo.
  for (const [, entry] of sortedEntries(tableOwners)) {
    if (entry.ids.length > 1) {
      generatorBlockers.push(
        blocker('name_collision', entry.ids.map(ctx.ref), `tablas con el mismo nombre (${entry.name}): ${entry.labels.join(', ')}`),
      );
    }
  }
  for (const [, entry] of sortedEntries(routeOwners)) {
    if (entry.ids.length > 1) {
      generatorBlockers.push(
        blocker('name_collision', entry.ids.map(ctx.ref), `rutas con el mismo nombre (/${entry.name}): ${entry.labels.join(', ')}`),
      );
    }
  }
  for (const [, entry] of sortedEntries(constraintOwners)) {
    if (entry.entries.length > 1) {
      generatorBlockers.push(
        blocker(
          'name_collision',
          entry.entries.flatMap((item) => item.elements),
          `restricciones con el mismo nombre (${entry.name}): ${entry.entries.map((item) => item.label).join(', ')}`,
          entry.entries.flatMap((item) => item.relationships),
        ),
      );
    }
  }
  for (const [, build] of sortedEntries(entityBuilds)) {
    build.entity.imports = sortedUnique([...build.entity.imports, ...build.extraImports]);
    for (const [, owners] of build.memberOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(build.entity.elementId)], `miembros de ${build.label}: ${owners.join(', ')}`),
        );
      }
    }
    for (const [, owners] of build.columnOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(build.entity.elementId)], `columnas de ${build.label}: ${owners.join(', ')}`),
        );
      }
    }
    for (const [, owners] of build.dtoOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(build.entity.elementId)], `componentes de DTO de ${build.label}: ${owners.join(', ')}`),
        );
      }
    }
  }
  foreignKeys.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (entities.length === 0) {
    generatorNotes.push(note('no_entities', [], 'el diagrama no tiene clasificadores emitibles'));
  }

  return {
    artifactId: artifactIdFor(content),
    // El id y el nombre del diagrama viajan en la IR para que la colección
    // Postman use el id como `_postman_id` y el README titule con el nombre
    // (D11). No son azar ni reloj: salen del mismo snapshot que el modelo.
    diagramId: content.diagram.id,
    diagramName: content.diagram.name,
    entities,
    enums,
    interfaces,
    joinTables,
    foreignKeys,
    uniques,
    fixturePlan,
    blockers: [...blocking, ...generatorBlockers],
    notes: [...warnings, ...generatorNotes],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

function capitalizeName(name: string): string {
  const chars = [...name];
  if (chars.length === 0) return name;
  chars[0] = (chars[0] as string).toUpperCase();
  return chars.join('');
}

function registerNamespace(
  registry: Map<string, { name: string; ids: string[]; labels: string[] }>,
  name: string,
  elementId: string,
  label: string,
): void {
  const key = collisionKey(name);
  const entry = registry.get(key);
  if (entry) {
    entry.ids.push(elementId);
    entry.labels.push(label);
    return;
  }
  registry.set(key, { name, ids: [elementId], labels: [label] });
}

function sortedEntries<T>(map: Map<string, T>): [string, T][] {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function describeType(feature: UmlFeatureView): string {
  return feature.typeName ?? feature.typeElementId ?? 'sin tipo';
}

function extractValidation(validationReport: ValidationReport): { blocking: CodegenFinding[]; warnings: CodegenNote[] } {
  const blocking: CodegenFinding[] = [];
  const warnings: CodegenNote[] = [];
  for (const finding of validationReport.findings) {
    if (isBlockingRule(finding.ruleId)) {
      blocking.push({
        source: 'validation',
        ruleId: finding.ruleId,
        elements: finding.elements,
        // Los hallazgos de validación solo conocen elementos (D10).
        relationships: [],
        detail: finding.detail,
      });
    } else {
      warnings.push({
        code: 'validation_warning',
        elements: finding.elements,
        relationships: [],
        detail: finding.detail === null ? finding.ruleId : `${finding.ruleId}: ${finding.detail}`,
      });
    }
  }
  return { blocking, warnings };
}

function attributeSkipReason(attribute: UmlFeatureView): string | null {
  if (attribute.isStatic) return 'estático';
  if (attribute.isDerived) return 'derivado';
  if (attribute.upperBound !== 1) return 'multivaluado';
  return null;
}

/**
 * Resuelve el tipo de un atributo o parámetro (D5). Tres resultados posibles:
 * `ok` (fila de la tabla, o enum modelado), `unknown` (`unknown_type`, nunca
 * `String`) y `skip` (el tipo existe pero no se emite en esta rebanada).
 */
function resolveType(typeElementId: string | null, typeNameRaw: string | null, ctx: BuildContext): ResolvedType {
  if (typeElementId !== null) {
    const element = ctx.elementById.get(typeElementId);
    if (!element) return { status: 'unknown' };
    if (element.kind === 'PRIMITIVE_TYPE') {
      const row = mapPrimitive(element.name ?? '');
      return row ? { status: 'ok', type: { ...row, imports: [...row.imports] }, enumerated: false } : { status: 'unknown' };
    }
    if (element.kind === 'ENUMERATION') {
      const irEnum = ctx.enumByElementId.get(element.id);
      if (!irEnum) return { status: 'skip', reason: 'enumeración sin literales' };
      return {
        status: 'ok',
        type: {
          java: irEnum.name,
          sql: 'varchar(255)',
          imports: [`${ENTITY_PACKAGE}.${irEnum.name}`],
          example: irEnum.literals[0]?.name ?? 'VALOR',
        },
        enumerated: true,
      };
    }
    if (element.kind === 'CLASS' || element.kind === 'INTERFACE') {
      return { status: 'skip', reason: 'tipo clasificador (asociación disfrazada, rebanada 4)' };
    }
    if (element.kind === 'DATATYPE') return { status: 'skip', reason: 'DATATYPE' };
    return { status: 'unknown' };
  }

  const typeNameValue = typeNameRaw ?? '';
  if (typeNameValue === '') return { status: 'unknown' };
  const row = mapPrimitive(typeNameValue);
  return row ? { status: 'ok', type: { ...row, imports: [...row.imports] }, enumerated: false } : { status: 'unknown' };
}

function injectedIdField(): IrField {
  return {
    elementId: '',
    name: 'id',
    getter: 'getId',
    setter: 'setId',
    column: 'id',
    type: { java: 'Long', sql: 'bigint', imports: [], example: 1 },
    enumerated: false,
    nullable: false,
    isId: true,
    generation: 'IDENTITY',
    inherited: false,
  };
}

/**
 * PK declarada (D5): un atributo llamado `id` sin distinguir cajas. `IDENTITY`
 * para `Integer`/`Long`, `GenerationType.UUID` para `UUID` (lo genera Hibernate,
 * sin `gen_random_uuid()`); cualquier otro tipo —o multivaluado, estático o
 * derivado— bloquea con `pk_type_invalid`.
 */
function resolveIdField(
  attribute: UmlFeatureView,
  ownerName: string,
  ctx: BuildContext,
  blockers: CodegenFinding[],
  notes: CodegenNote[],
): IrField | null {
  const reject = (reason: string): null => {
    blockers.push(
      blocker('pk_type_invalid', [ctx.ref(attribute.ownerId)], `${ownerName}.${attribute.name}: ${reason}`),
    );
    return null;
  };
  if (attribute.isStatic) return reject('estático');
  if (attribute.isDerived) return reject('derivado');
  if (attribute.upperBound !== 1) return reject('multivaluado');
  const resolved = resolveType(attribute.typeElementId, attribute.typeName, ctx);
  if (resolved.status !== 'ok') return reject(`tipo ${describeType(attribute)} no soportado como PK`);
  const type = resolved.type as IrTypeRef;
  if (type.java !== 'Integer' && type.java !== 'Long' && type.java !== 'UUID') {
    return reject(`tipo ${type.java} no soportado como PK`);
  }
  if (resolved.enumerated === true) return reject(`tipo ${type.java} no soportado como PK`);

  const member = memberName(attribute.name);
  const column = columnName(attribute.name);
  if (member.escaped) {
    notes.push(note('name_escaped', [ctx.ref(attribute.ownerId)], `${attribute.name} → ${member.name}`));
  }
  return {
    elementId: attribute.id,
    name: member.name,
    getter: `get${capitalizeName(member.name)}`,
    setter: `set${capitalizeName(member.name)}`,
    column: column.name,
    type,
    enumerated: false,
    nullable: false,
    isId: true,
    generation: type.java === 'UUID' ? 'UUID' : 'IDENTITY',
    inherited: false,
  };
}

/**
 * Tipos derivados que aporta una entidad (D3, D11). Viven en la IR porque la
 * detección de colisiones y los emisores deben leer EXACTAMENTE la misma lista:
 * si divergieran, un modelo podría compilar y aun así chocar al descomprimir.
 */
function buildDerivedTypeNames(entityName: string): string[] {
  return ['Repository', 'Service', 'ServiceImpl', 'Controller', 'Request', 'Response', 'Mapper'].map(
    (suffix) => `${entityName}${suffix}`,
  );
}

/** `artifactId` del proyecto emitido (D11): kebab del nombre del diagrama, o `umlive-app`. */
function artifactIdFor(content: DiagramContent): string {
  const kebab = routeSegment(content.diagram.name).name;
  return kebab === '' ? FALLBACK_ARTIFACT_ID : kebab;
}

// ─────────────────────────────────────────────────────────────────────────────
// Herencia: aplanado y colisiones (D2)
// ─────────────────────────────────────────────────────────────────────────────

const relationIsCollection = (relation: IrRelationField): boolean =>
  relation.kind === 'OneToMany' || relation.kind === 'ManyToMany';

/** Profundidad en la jerarquía, para aplanar de la raíz hacia abajo. */
function entityDepth(elementId: string, classNodes: Map<string, ClassNode>): number {
  let depth = 0;
  let cur = classNodes.get(elementId)?.parentElementId ?? null;
  const seen = new Set<string>();
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    depth += 1;
    cur = classNodes.get(cur)?.parentElementId ?? null;
  }
  return depth;
}

/**
 * Copia al descendiente los campos del ancestro, marcados `inherited` (D2).
 * La PK heredada de una hija `JOINED` pierde la identidad —su columna es FK a
 * la PK del padre—; la de un `@MappedSuperclass` la conserva, porque la tabla
 * de la hija es su propia raíz (golden 0.5 y 0.7).
 */
function flattenInheritedFields(entities: IrEntity[], classNodes: Map<string, ClassNode>): void {
  const byId = new Map(entities.map((entity) => [entity.elementId, entity]));
  const ordered = [...entities].sort(
    (a, b) => entityDepth(a.elementId, classNodes) - entityDepth(b.elementId, classNodes),
  );
  for (const entity of ordered) {
    const parentId = classNodes.get(entity.elementId)?.parentElementId ?? null;
    if (parentId === null) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    const inherited = parent.fields.map((field) => ({
      ...field,
      inherited: true,
      generation: field.isId && !parent.mappedSuperclass ? null : field.generation,
    }));
    entity.fields = [...inherited, ...entity.fields];
  }
}

/** Copia al descendiente los campos de relación del ancestro, marcados `inherited` (D2). */
function flattenInheritedRelations(entities: IrEntity[], classNodes: Map<string, ClassNode>): void {
  const byId = new Map(entities.map((entity) => [entity.elementId, entity]));
  const ordered = [...entities].sort(
    (a, b) => entityDepth(a.elementId, classNodes) - entityDepth(b.elementId, classNodes),
  );
  for (const entity of ordered) {
    const parentId = classNodes.get(entity.elementId)?.parentElementId ?? null;
    if (parentId === null) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    entity.relations = [...parent.relations.map((relation) => ({ ...relation, inherited: true })), ...entity.relations];
  }
}

/**
 * Rearma `dtoFields` con TODOS los campos y relaciones, ancestros primero
 * (D1): un `record` no hereda componentes, así que el DTO del descendiente
 * tiene que listarlos. El orden es el mismo que recorre `emitMapper`, para que
 * los argumentos del constructor coincidan con las componentes del `record`.
 */
function rebuildDtoFields(entities: IrEntity[]): void {
  for (const entity of entities) {
    entity.dtoFields = [
      ...entity.fields.map((field) => ({
        name: field.name,
        type: field.type.java,
        imports: field.type.imports,
        inRequest: !field.isId,
      })),
      ...entity.relations.map((relation) => {
        const collection = relationIsCollection(relation);
        return {
          name: relation.dto.name,
          type: collection ? `List<${relation.dto.idType}>` : relation.dto.idType,
          imports: [
            ...(collection ? ['java.util.List'] : []),
            ...(relation.dto.idType === 'UUID' ? ['java.util.UUID'] : []),
          ],
          inRequest: relation.dto.inRequest,
        };
      }),
    ];
  }
}

/**
 * `inherited_member_collision` (D2): un miembro propio que choca —en
 * minúsculas— con uno de un ancestro. Una operación con la misma firma y el
 * mismo retorno es `@Override`, no colisión; con retorno distinto, bloquea.
 */
function detectInheritedMemberCollisions(
  entities: IrEntity[],
  classNodes: Map<string, ClassNode>,
  ctx: BuildContext,
  blockers: CodegenFinding[],
): void {
  const byId = new Map(entities.map((entity) => [entity.elementId, entity]));
  for (const entity of entities) {
    let cur = classNodes.get(entity.elementId)?.parentElementId ?? null;
    if (cur === null) continue;
    const memberKeys = new Set<string>();
    const operationReturns = new Map<string, string>();
    const seen = new Set<string>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const ancestor = byId.get(cur);
      if (ancestor !== undefined) {
        for (const field of ancestor.fields) if (!field.inherited) memberKeys.add(collisionKey(field.name));
        for (const relation of ancestor.relations) if (!relation.inherited) memberKeys.add(collisionKey(relation.name));
        for (const operation of ancestor.operations) operationReturns.set(operation.signature, operation.returns);
      }
      cur = classNodes.get(cur)?.parentElementId ?? null;
    }
    for (const field of entity.fields) {
      if (!field.inherited && memberKeys.has(collisionKey(field.name))) {
        blockers.push(
          blocker('inherited_member_collision', [ctx.ref(entity.elementId)], `${entity.name}.${field.name}: choca con un miembro heredado`),
        );
      }
    }
    for (const relation of entity.relations) {
      if (!relation.inherited && memberKeys.has(collisionKey(relation.name))) {
        blockers.push(
          blocker('inherited_member_collision', [ctx.ref(entity.elementId)], `${entity.name}.${relation.name}: choca con un miembro heredado`),
        );
      }
    }
    for (const operation of entity.operations) {
      const ancestorReturn = operationReturns.get(operation.signature);
      if (ancestorReturn !== undefined && ancestorReturn !== operation.returns) {
        blockers.push(
          blocker(
            'inherited_member_collision',
            [ctx.ref(entity.elementId)],
            `${entity.name}.${operation.signature}: retorno distinto al del ancestro`,
          ),
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grafo de referencias obligatorias (D9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nodo por jerarquía colapsada a su raíz y arista por FK `NOT NULL` (D9).
 * Detecta el ciclo —incluido el lazo propio— y el destino abstracto sin
 * descendiente concreto; sin ninguno de los dos, arma `fixturePlan` como la
 * clausura topológica por entidad concreta, con los empates resueltos por `<`.
 */
function buildFixturePlan(
  entities: IrEntity[],
  classNodes: Map<string, ClassNode>,
  mandatoryEdges: MandatoryEdge[],
  blockers: CodegenFinding[],
): Record<string, string[]> {
  const byId = new Map(entities.map((entity) => [entity.elementId, entity]));
  const concrete = entities.filter((entity) => !entity.isAbstract && !entity.mappedSuperclass);
  const concreteByName = new Map(concrete.map((entity) => [entity.name, entity]));

  const rootOf = (elementId: string): string => {
    let cur = elementId;
    for (;;) {
      const parentId = classNodes.get(cur)?.parentElementId ?? null;
      if (parentId === null) return cur;
      const parent = byId.get(parentId);
      if (parent === undefined || parent.mappedSuperclass) return cur;
      cur = parentId;
    }
  };
  const nameOfRoot = (root: string): string => byId.get(root)?.name ?? root;
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  const adjacency = new Map<string, { node: string; edge: MandatoryEdge }[]>();
  for (const edge of mandatoryEdges) {
    const from = rootOf(edge.fromElementId);
    const to = rootOf(edge.toElementId);
    const bucket = adjacency.get(from);
    if (bucket) bucket.push({ node: to, edge });
    else adjacency.set(from, [{ node: to, edge }]);
  }
  const neighbors = (id: string): { node: string; edge: MandatoryEdge }[] =>
    [...(adjacency.get(id) ?? [])].sort((a, b) => byName(nameOfRoot(a.node), nameOfRoot(b.node)));

  // DFS de tres colores: cada arista hacia un nodo gris define un ciclo.
  const color = new Map<string, 0 | 1 | 2>();
  const nodeStack: string[] = [];
  const edgeStack: MandatoryEdge[] = [];
  const cycles: MandatoryEdge[][] = [];
  const roots = [...new Set(entities.map((entity) => rootOf(entity.elementId)))].sort((a, b) =>
    byName(nameOfRoot(a), nameOfRoot(b)),
  );
  for (const root of roots) {
    if ((color.get(root) ?? 0) !== 0) continue;
    color.set(root, 1);
    nodeStack.length = 0;
    edgeStack.length = 0;
    nodeStack.push(root);
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; next: number };
      const list = neighbors(top.id);
      if (top.next >= list.length) {
        color.set(top.id, 2);
        stack.pop();
        nodeStack.pop();
        if (edgeStack.length > 0 && edgeStack.length >= nodeStack.length) edgeStack.pop();
        continue;
      }
      const nb = list[top.next] as { node: string; edge: MandatoryEdge };
      top.next += 1;
      const state = color.get(nb.node) ?? 0;
      if (state === 1) {
        const startIndex = nodeStack.indexOf(nb.node);
        cycles.push(startIndex >= 0 ? [...edgeStack.slice(startIndex), nb.edge] : [nb.edge]);
      } else if (state === 0) {
        color.set(nb.node, 1);
        edgeStack.push(nb.edge);
        nodeStack.push(nb.node);
        stack.push({ id: nb.node, next: 0 });
      }
    }
  }

  const seenCycles = new Set<string>();
  for (const cycle of cycles) {
    const key = cycle.map((edge) => edge.relationship.id).sort().join('|');
    if (seenCycles.has(key)) continue;
    seenCycles.add(key);
    const elements = [...new Map(cycle.flatMap((edge) => edge.elements).map((ref) => [ref.id, ref])).values()];
    const relationships = [
      ...new Map(cycle.flatMap((edge) => edge.relationships).map((ref) => [ref.id, ref])).values(),
    ];
    blockers.push(
      blocker(
        'mandatory_reference_cycle',
        elements,
        `${relationships.map((ref) => ref.label).join(' → ')}: ciclo de referencias obligatorias`,
        relationships,
      ),
    );
  }

  const concreteDescendantsOf = (elementId: string): IrEntity[] => {
    const out: IrEntity[] = [];
    const walk = (id: string, seen: Set<string>): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const entity = byId.get(id);
      if (entity !== undefined && !entity.isAbstract && !entity.mappedSuperclass) out.push(entity);
      for (const child of classNodes.get(id)?.childrenElementIds ?? []) walk(child, seen);
    };
    walk(elementId, new Set());
    return out;
  };
  /** Destino concreto de una referencia: la clase misma, o su primer descendiente concreto con `<` (D9). */
  const resolveConcrete = (elementId: string): string | null => {
    const target = byId.get(elementId);
    if (target !== undefined && !target.isAbstract && !target.mappedSuperclass) return target.name;
    const descendants = concreteDescendantsOf(elementId).sort((a, b) => byName(a.name, b.name));
    return descendants[0]?.name ?? null;
  };

  let unsatisfiable = false;
  for (const edge of mandatoryEdges) {
    const target = byId.get(edge.toElementId);
    if (target !== undefined && target.isAbstract && !target.mappedSuperclass && resolveConcrete(edge.toElementId) === null) {
      unsatisfiable = true;
      blockers.push(
        blocker(
          'unsatisfiable_mandatory_reference',
          edge.elements,
          `${edge.relationships[0]?.label ?? ''}: destino abstracto sin descendiente concreto`,
          edge.relationships,
        ),
      );
    }
  }
  if (cycles.length > 0 || unsatisfiable) return {};

  const directDeps = (elementId: string): string[] => {
    const names = new Set<string>();
    const seen = new Set<string>();
    let cur: string | null = elementId;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      for (const edge of mandatoryEdges) {
        if (edge.fromElementId !== cur) continue;
        const resolved = resolveConcrete(edge.toElementId);
        if (resolved !== null && resolved !== (byId.get(elementId)?.name ?? elementId)) names.add(resolved);
      }
      cur = classNodes.get(cur)?.parentElementId ?? null;
    }
    return [...names].sort(byName);
  };

  const plan: Record<string, string[]> = {};
  for (const entity of concrete) {
    const out: string[] = [];
    const seen = new Set<string>();
    const depsOf = (name: string): string[] => {
      const target = concreteByName.get(name);
      return target === undefined ? [] : directDeps(target.elementId);
    };
    const visit = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const dep of depsOf(name)) visit(dep);
      out.push(name);
    };
    for (const dep of directDeps(entity.elementId)) visit(dep);
    plan[entity.name] = out;
  }
  return plan;
}

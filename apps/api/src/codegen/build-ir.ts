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
 * - **Relaciones** (D3, D10): cada `ASSOCIATION` se resuelve a campos JPA, columnas
 *   FK, join tables y restricciones según la multiplicidad (y, en la fase de
 *   agregación, la del TODO). `DEPENDENCY`/`USAGE` y los extremos sobre
 *   no-entidad quedan declarados con `relationship_not_emitted`; la herencia y
 *   las interfaces las cubre la Fase 4 de la misma rebanada y hasta entonces
 *   también se declaran con esa nota. `relationship_deferred` ya no existe (D1).
 * - **Orden de los hallazgos** (D6): primero los de validación en el orden del
 *   servicio, después los del generador en el orden de esta construcción.
 */

import {
  isBlockingRule,
  qualifiedName,
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
  code: 'name_collision' | 'name_unrepresentable' | 'pk_type_invalid' | 'operation_signature_collision',
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

    if (el.isAbstract) {
      generatorNotes.push(note('classifier_skipped', [ctx.ref(el.id)], `${rawName}: clase abstracta`));
      continue;
    }
    const stereotype = (el.stereotype ?? '').trim().toLowerCase();
    if (stereotype !== '' && stereotype !== 'entity') {
      generatorNotes.push(note('classifier_skipped', [ctx.ref(el.id)], `${rawName}: estereotipo «${el.stereotype}»`));
      continue;
    }

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

    // PK declarada o inyectada (D5).
    const idAttr = attributes.find((a) => a.name.toLowerCase() === 'id');
    let idInjected = false;
    if (idAttr) {
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

    for (const operation of operations) {
      const operationName = operation.name;
      const parameters = (ctx.parametersByOperation.get(operation.id) ?? []).filter((p) => p.direction !== 'RETURN');
      const returnParameter = (ctx.parametersByOperation.get(operation.id) ?? []).find((p) => p.direction === 'RETURN');

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
        generatorNotes.push(note('operation_skipped', [ctx.ref(el.id)], `${operationName}: parámetro de tipo no emitido`));
        continue;
      }

      let returns = 'void';
      let returnImports: string[] = [];
      if (returnParameter) {
        const resolvedReturn = resolveType(returnParameter.typeElementId, returnParameter.typeName, ctx);
        if (resolvedReturn.status !== 'ok') {
          generatorNotes.push(note('operation_skipped', [ctx.ref(el.id)], `${operationName}: retorno de tipo no emitido`));
          continue;
        }
        const returnType = resolvedReturn.type as IrTypeRef;
        returns = returnType.java;
        returnImports = returnType.imports;
      }

      const member = memberName(operationName);
      if (member.unrepresentable) {
        generatorBlockers.push(blocker('name_unrepresentable', [ctx.ref(el.id)], operationName));
        continue;
      }
      const signature = `${member.name}(${parameterResults.map((p) => p.type.java).join(',')})`;
      const operationImports = sortedUnique([...parameterResults.flatMap((p) => p.type.imports), ...returnImports]);
      imports.push(...operationImports);
      registerMethod(signature, `operación ${operationName}`, true);
      irOperations.push({
        elementId: operation.id,
        name: member.name,
        signature,
        parameters: parameterResults,
        returns,
        imports: operationImports,
      });
      if (member.escaped) {
        generatorNotes.push(note('name_escaped', [ctx.ref(el.id)], `${operationName} → ${member.name}`));
      }
    }
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

    // Tabla, entidad JPA y ruta.
    const table = tableName(rawName);
    const hql = hqlEntityName(rawName);
    const route = routeSegment(rawName);
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

    const derivedTypeNames = buildDerivedTypeNames(resolvedName.name);
    const jpaImports = [
      'jakarta.persistence.Column',
      'jakarta.persistence.Entity',
      'jakarta.persistence.GeneratedValue',
      'jakarta.persistence.GenerationType',
      'jakarta.persistence.Id',
      'jakarta.persistence.Table',
    ];
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
      // Campos de la IR que llena otra pasada: la herencia y las interfaces
      // son de la Fase 4 y las asociaciones de la Fase D de acá abajo (D1).
      superclass: null,
      inheritanceRoot: false,
      isAbstract: false,
      mappedSuperclass: false,
      implementsInterfaces: [],
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

    registerNamespace(tableOwners, table.name, el.id, `tabla de ${resolvedName.name}`);
    registerNamespace(routeOwners, route.name, el.id, `ruta de ${resolvedName.name}`);
  }

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
  // ── Fase D: asociaciones sin agregación (D3, D8, D9) ─────────────────────
  //
  // La agregación (D4) llega en la Fase 3 de esta misma rebanada: hasta
  // entonces `cascade` queda en `NONE` y la cascada del TODO no se emite. Todo
  // lo demás —forma, dueño, `mappedBy`, nulabilidad, columnas, join tables y
  // restricciones— ya se decide acá, así que la Fase 3 solo cambiará el valor
  // de `cascade`/`orphanRemoval`.
  const joinTables: IrJoinTable[] = [];
  const foreignKeys: IrForeignKey[] = [];
  const uniques: IrUnique[] = [];
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

    if (relationship.kind !== 'ASSOCIATION') {
      // GENERALIZATION e INTERFACE_REALIZATION los emite la Fase 4 de esta
      // rebanada (D2). Hasta que esa pasada exista, declararlos acá es lo que
      // evita una pérdida silenciosa: la nota `relationship_deferred` de core
      // ya no existe (D1) y la spec exige que toda relación quede emitida o
      // declarada como `relationship_not_emitted`.
      generatorNotes.push(
        note(
          'relationship_not_emitted',
          elements,
          `${label}: ${relationship.kind}, pendiente de la Fase 4 (herencia e interfaces)`,
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

    if (simple0 !== simple1) {
      // ── simple — múltiple: la FK vive en la tabla del extremo múltiple ────
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
      const ownerRelation: IrRelationField = {
        name: ownerBase,
        target: owner.otherBuild.entity.name,
        kind: 'ManyToOne',
        owning: true,
        mappedBy: null,
        cascade: 'NONE',
        orphanRemoval: false,
        joinColumn: { name: column, nullable, unique: false },
        joinTable: null,
        dto: { name: `${ownerBase}Id`, inRequest: true, required: !nullable, idType: targetPk.type.java },
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

      if (owner.end.isNavigable) {
        const ownerPk = pkField(owner.build);
        addRelation(inverse, {
          name: `${inverseBase}List`,
          target: owner.build.entity.name,
          kind: 'OneToMany',
          owning: false,
          mappedBy: ownerRelation.name,
          cascade: 'NONE',
          orphanRemoval: false,
          joinColumn: null,
          joinTable: null,
          dto: { name: `${inverseBase}Ids`, inRequest: false, required: false, idType: ownerPk.type.java },
        });
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
      // Dependiente = la clase cuyo extremo OPUESTO es obligatorio (así el
      // `NOT NULL` dice algo); empate → `source` (spec de la rebanada).
      const ownerIsSource = !(end0.lowerBound >= 1 && end1.lowerBound < 1);
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
      const ownerRelation: IrRelationField = {
        name: ownerBase,
        target: owner.otherBuild.entity.name,
        kind: 'OneToOne',
        owning: true,
        mappedBy: null,
        cascade: 'NONE',
        orphanRemoval: false,
        joinColumn: { name: column, nullable, unique: true },
        joinTable: null,
        dto: { name: `${ownerBase}Id`, inRequest: true, required: !nullable, idType: targetPk.type.java },
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

      if (owner.end.isNavigable) {
        const ownerPk = pkField(owner.build);
        addRelation(inverse, {
          name: `${inverseBase}`,
          target: owner.build.entity.name,
          kind: 'OneToOne',
          owning: false,
          mappedBy: ownerRelation.name,
          cascade: 'NONE',
          orphanRemoval: false,
          joinColumn: null,
          joinTable: null,
          dto: { name: `${inverseBase}Id`, inRequest: false, required: false, idType: ownerPk.type.java },
        });
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
    const ownerIsSource = !(end0.isNavigable && !end1.isNavigable);
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
    const ownerRelation: IrRelationField = {
      name: `${ownerBase}List`,
      target: owner.otherBuild.entity.name,
      kind: 'ManyToMany',
      owning: true,
      mappedBy: null,
      cascade: 'NONE',
      orphanRemoval: false,
      joinColumn: null,
      joinTable: { name: joinTableName, ownerColumn, targetColumn },
      dto: { name: `${ownerBase}Ids`, inRequest: true, required: false, idType: targetPk.type.java },
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
    interfaces: [],
    joinTables,
    foreignKeys,
    uniques,
    // La clausura de fixtures obligatorios es de la Fase 5 (D9).
    fixturePlan: {},
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

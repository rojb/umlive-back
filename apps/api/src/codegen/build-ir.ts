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
 * - **Relaciones** (D5/D6): todas quedan en el reporte como
 *   `relationship_deferred`, incluidas las `GENERALIZATION` (herencia diferida).
 * - **Orden de los hallazgos** (D6): primero los de validación en el orden del
 *   servicio, después los del generador en el orden de esta construcción.
 */

import {
  isBlockingRule,
  qualifiedName,
  type CodegenElementRef,
  type CodegenFinding,
  type CodegenNote,
  type DiagramContent,
  type UmlElementView,
  type UmlEnumLiteralView,
  type UmlFeatureView,
  type UmlParameterView,
  type ValidationReport,
} from '@umlive/contracts';
import {
  OBJECT_METHOD_SIGNATURES,
  collisionKey,
  columnName,
  enumLiteralName,
  hqlEntityName,
  memberName,
  routeSegment,
  tableName,
  typeName,
} from './java-names';
import { mapPrimitive } from './type-mapping';
import type { CodegenIr, IrEntity, IrEnum, IrField, IrOperation, IrParameter, IrTypeRef } from './codegen-ir';

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
): CodegenFinding {
  return { source: 'codegen', code, elements, detail };
}

function note(code: CodegenNote['code'], elements: CodegenElementRef[], detail: string | null): CodegenNote {
  return { code, elements, detail };
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

    for (const [, owners] of memberOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(el.id)], `miembros de ${resolvedName.name}: ${owners.join(', ')}`),
        );
      }
    }
    for (const [, owners] of columnOwners) {
      if (owners.length > 1) {
        generatorBlockers.push(
          blocker('name_collision', [ctx.ref(el.id)], `columnas de ${resolvedName.name}: ${owners.join(', ')}`),
        );
      }
    }

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

    entities.push({
      elementId: el.id,
      name: resolvedName.name,
      hqlName: hql.name,
      table: table.name,
      route: route.name,
      fields,
      operations: irOperations,
      derivedTypeNames,
      imports: sortedUnique([...jpaImports, ...imports]),
      idInjected,
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

  // ── Fase D: relaciones diferidas (D5, D6) ─────────────────────────────────
  for (const relationship of content.relationships) {
    const detail = relationship.kind === 'GENERALIZATION'
      ? `${relationship.kind}: herencia diferida a codegen-relationships`
      : `${relationship.kind}: diferida a codegen-relationships`;
    generatorNotes.push(
      note('relationship_deferred', [ctx.ref(relationship.sourceElementId), ctx.ref(relationship.targetElementId)], detail),
    );
  }

  if (entities.length === 0) {
    generatorNotes.push(note('no_entities', [], 'el diagrama no tiene clasificadores emitibles'));
  }

  return {
    artifactId: artifactIdFor(content),
    entities,
    enums,
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
      blocking.push({ source: 'validation', ruleId: finding.ruleId, elements: finding.elements, detail: finding.detail });
    } else {
      warnings.push({
        code: 'validation_warning',
        elements: finding.elements,
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

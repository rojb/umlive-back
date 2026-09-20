/**
 * Emisores de las ocho piezas por entidad (D2, D4, D11; tarea 2.3).
 *
 * Cada emisor es una **función pura `(irEntity) => string`**: no lee el reloj,
 * no usa azar, no consulta el locale y no abre archivos. Tampoco importa
 * `@umlive/contracts` ni el modelo: solo ve la IR, así que no puede ramificar
 * sobre `kind`, `typeName` ni `stereotype` —esos datos no llegan hasta acá— y
 * lo único que puede consultar del modelo son **flags ya resueltos**
 * (`field.enumerated`, `field.isId`, `entity.hqlName`). Es la regla de D2, y es
 * la que deja que `codegen-relationships` agregue campos a la IR sin reescribir
 * un solo emisor.
 *
 * Dos consecuencias de D4 que se ven en el texto emitido:
 *
 * - Cada `@Table(name = …)` y cada `@Column(name = …)` van **explícitos**, con
 *   el MISMO texto que usa `V1__init.sql`. Si se dejaran implícitos, los nombres
 *   los pondría `CamelCaseToUnderscoresNamingStrategy` de Spring, y bastaría una
 *   diferencia en un caso borde para que `ddl-auto=validate` falle al arrancar
 *   con un modelo que compiló bien.
 * - `@PathVariable("id")` lleva el nombre explícito y no depende de que el
 *   compilador use `-parameters`.
 *
 * Los identificadores conservan las letras acentuadas (D3, corrección FR-D20b):
 * la clase `Dirección` se emite como `Dirección.java` con el campo
 * `códigoPostal`. Por eso el `pom.xml` fija `project.build.sourceEncoding=UTF-8`
 * (D8, `project.ts`).
 */

import { BASE_PACKAGE } from '../build-ir';
import { DERIVED_TYPE_SUFFIXES } from '../java-names';
import type { IrEntity, IrField, IrRelationField } from '../codegen-ir';
import type { GeneratedFile } from '../zip';
import { emitOperationStub, renderRecord, requiredDtoImports } from './layers';

/** Raíz del código fuente emitido. Ancla del layout; la comparte `project.ts`. */
export const JAVA_SOURCE_ROOT = `src/main/java/${BASE_PACKAGE.replace(/\./g, '/')}`;

const ENTITY_PACKAGE = `${BASE_PACKAGE}.entity`;
const REPOSITORY_PACKAGE = `${BASE_PACKAGE}.repository`;
const SERVICE_PACKAGE = `${BASE_PACKAGE}.service`;
const CONTROLLER_PACKAGE = `${BASE_PACKAGE}.controller`;
const DTO_PACKAGE = `${BASE_PACKAGE}.dto`;
const MAPPER_PACKAGE = `${BASE_PACKAGE}.mapper`;

/** Sangría de Java: cuatro espacios, como el golden de la Fase 0. */
const INDENT = '    ';

type DerivedSuffix = (typeof DERIVED_TYPE_SUFFIXES)[number];

/**
 * Nombre del tipo derivado, leído de la IR y no reconstruido acá: la detección
 * de colisiones y la emisión tienen que leer EXACTAMENTE la misma lista (D3). Si
 * esta función armara `${entity.name}Service` por su cuenta, un modelo podría
 * pasar la compuerta y aun así chocar al descomprimir.
 */
function derivedName(entity: IrEntity, suffix: DerivedSuffix): string {
  const name = entity.derivedTypeNames[DERIVED_TYPE_SUFFIXES.indexOf(suffix)];
  if (name === undefined) {
    throw new Error(`la IR de ${entity.name} no trae el tipo derivado ${entity.name}${suffix}`);
  }
  return name;
}

/**
 * La PK. `buildIr` garantiza que toda entidad emitible tiene una —declarada
 * válida o inyectada—; una entidad con `pk_type_invalid` bloquea y nunca llega
 * a los emisores.
 */
function idField(entity: IrEntity): IrField {
  const id = entity.fields.find((field) => field.isId);
  if (id === undefined) {
    throw new Error(`la IR de ${entity.name} no tiene clave primaria y no está bloqueada`);
  }
  return id;
}

/** Tipo Java de la PK, para las firmas de `findById`/`update`/`delete` y el genérico del repositorio. */
function idType(entity: IrEntity): string {
  return idField(entity).type.java;
}

/** Orden estable e independiente del locale, nunca `localeCompare` (D7). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `cliente` → `Cliente`, para los nombres de accesor y de método que la IR no trae precomputados. */
function capitalizeFirst(name: string): string {
  const chars = [...name];
  if (chars.length === 0) return name;
  chars[0] = (chars[0] as string).toUpperCase();
  return chars.join('');
}

/** `true` si el campo de relación es una colección (`List<X>`) y no una referencia simple. */
function relationIsCollection(relation: IrRelationField): boolean {
  return relation.kind === 'OneToMany' || relation.kind === 'ManyToMany';
}

/** Nombre del repositorio de la entidad destino: `Cliente` → `clienteRepository` (D5: nunca otro servicio). */
function repositoryFieldName(target: string): string {
  return `${target.charAt(0).toLowerCase()}${target.slice(1)}Repository`;
}

/**
 * Ordena los ids de una colección (`cursoIds` ascendente, D5). Con PK numérica
 * `sorted()` alcanza; `UUID` no es `Comparable`, así que se ordena por su forma
 * textual para no romper la compilación.
 */
function sortedIdsClause(idType: string): string {
  return idType === 'UUID' ? '.sorted(Comparator.comparing(UUID::toString))' : '.sorted()';
}

/**
 * Bloque de `import`, sin duplicados, ordenado y **sin las clases del propio
 * paquete** (importarlas es legal pero ruidoso, y el golden no lo hace). Lo que
 * entra sale de la IR y de las piezas que este archivo declara por sí mismo; no
 * hay ninguna lista derivada del modelo.
 */
function renderImports(imports: readonly string[], ownPackage: string): string {
  const own = `${ownPackage}.`;
  const unique = [...new Set(imports.filter((name) => !name.startsWith(own)))];
  unique.sort(compareText);
  return unique.map((name) => `import ${name};`).join('\n');
}

/** `package` + `import` + cuerpo, con `\n` y una sola línea final. */
function renderFile(packageName: string, imports: readonly string[], body: string): string {
  const block = renderImports(imports, packageName);
  const head = [`package ${packageName};`, ''];
  if (block !== '') head.push(block, '');
  return `${[...head, body].join('\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// entity/X.java
// ─────────────────────────────────────────────────────────────────────────────

/** Anotación de entidad: `@Entity(name = "OrderEntity")` solo cuando la IR escapó el nombre HQL (D3). */
function entityAnnotation(entity: IrEntity): string {
  return entity.hqlName === entity.name ? '@Entity' : `@Entity(name = "${entity.hqlName}")`;
}

function renderField(field: IrField): string {
  const lines: string[] = [];
  if (field.isId) {
    lines.push('@Id');
    // `IDENTITY` para `Integer`/`Long`; `UUID` lo genera Hibernate, sin
    // `gen_random_uuid()` (D5, golden 0.6).
    lines.push(`@GeneratedValue(strategy = GenerationType.${field.generation ?? 'IDENTITY'})`);
  }
  if (field.enumerated) lines.push('@Enumerated(EnumType.STRING)');
  lines.push(`@Column(name = "${field.column}"${field.nullable ? '' : ', nullable = false'})`);
  lines.push(`private ${field.type.java} ${field.name};`);
  return lines.map((line) => `${INDENT}${line}`).join('\n');
}

/**
 * Campo de relación (tarea 2.3, D3; tarea 3.1, D4). El emisor NO decide acá
 * nada del modelo: `kind`, `owning`, `mappedBy`, nulabilidad, cascada y los
 * nombres de las columnas ya vienen resueltos en la IR. Lo único que hace es
 * traducirlos a anotaciones.
 *
 * La cascada y `orphanRemoval` son del lado TODO (D4): `SHARED` →
 * `{PERSIST, MERGE}`; `COMPOSITE` → `ALL` más `orphanRemoval`, siempre sobre el
 * `mappedBy` de la colección del TODO.
 */
function renderRelationField(relation: IrRelationField): string {
  const lines: string[] = [];
  const attributes: string[] = [];
  const optional = relation.joinColumn !== null && !relation.joinColumn.nullable ? 'optional = false' : null;
  if (relation.cascade === 'PERSIST_MERGE') attributes.push('cascade = {CascadeType.PERSIST, CascadeType.MERGE}');
  else if (relation.cascade === 'ALL') attributes.push('cascade = CascadeType.ALL');
  if (relation.orphanRemoval) attributes.push('orphanRemoval = true');

  if (relation.kind === 'ManyToOne') {
    lines.push(`@ManyToOne(fetch = FetchType.LAZY${optional === null ? '' : `, ${optional}`}${attributes.length === 0 ? '' : `, ${attributes.join(', ')}`})`);
  } else if (relation.kind === 'OneToOne') {
    const head = relation.owning ? `fetch = FetchType.LAZY${optional === null ? '' : `, ${optional}`}` : `fetch = FetchType.LAZY, mappedBy = "${relation.mappedBy}"`;
    lines.push(`@OneToOne(${head}${attributes.length === 0 ? '' : `, ${attributes.join(', ')}`})`);
  } else if (relation.kind === 'OneToMany') {
    lines.push(`@OneToMany(mappedBy = "${relation.mappedBy}"${attributes.length === 0 ? '' : `, ${attributes.join(', ')}`})`);
  } else {
    const head = relation.owning ? '' : `mappedBy = "${relation.mappedBy}"`;
    const all = [head, ...attributes].filter((part) => part !== '');
    lines.push(all.length === 0 ? '@ManyToMany' : `@ManyToMany(${all.join(', ')})`);
  }
  if (relation.joinColumn !== null) {
    const unique = relation.joinColumn.unique ? ', unique = true' : '';
    const nullable = relation.joinColumn.nullable ? '' : ', nullable = false';
    lines.push(`@JoinColumn(name = "${relation.joinColumn.name}"${unique}${nullable})`);
  }
  if (relation.joinTable !== null) {
    lines.push(
      `@JoinTable(name = "${relation.joinTable.name}", joinColumns = @JoinColumn(name = "${relation.joinTable.ownerColumn}"), inverseJoinColumns = @JoinColumn(name = "${relation.joinTable.targetColumn}"))`,
    );
  }
  const type = relationIsCollection(relation) ? `List<${relation.target}>` : relation.target;
  const initializer = relationIsCollection(relation) ? ' = new ArrayList<>()' : '';
  lines.push(`private ${type} ${relation.name}${initializer};`);
  return lines.map((line) => `${INDENT}${line}`).join('\n');
}

/**
 * Accesores del campo de relación. El lado **inverso** (`mappedBy`) sale SIN
 * setter: el compilador garantiza que nadie lo reemplace, que es lo que cierra
 * el riesgo de `orphanRemoval` + `PUT` (D4, D5).
 */
function renderRelationAccessors(relation: IrRelationField): string {
  const type = relationIsCollection(relation) ? `List<${relation.target}>` : relation.target;
  const capitalized = capitalizeFirst(relation.name);
  const getter = `${INDENT}public ${type} get${capitalized}() { return ${relation.name}; }`;
  if (!relation.owning) return getter;
  return [
    getter,
    `${INDENT}public void set${capitalized}(${type} ${relation.name}) { this.${relation.name} = ${relation.name}; }`,
  ].join('\n');
}

/**
 * Accesores que acompañan al campo, en la forma compacta del golden. Existen
 * como campo de la IR (`field.getter`/`field.setter`) porque la clave de firma
 * de las operaciones los necesita: un `getNombre()` de la entidad y una
 * operación `getNombre()` del modelo chocan (D5).
 */
function renderAccessors(field: IrField): string {
  return [
    `${INDENT}public ${field.type.java} ${field.getter}() { return ${field.name}; }`,
    `${INDENT}public void ${field.setter}(${field.type.java} ${field.name}) { this.${field.name} = ${field.name}; }`,
  ].join('\n');
}

/** Declaración `extends`, o cadena vacía si la clase es raíz (D2). */
function extendsClause(entity: IrEntity): string {
  return entity.superclass === null ? '' : ` extends ${entity.superclass}`;
}

/** Declaración `implements`, o cadena vacía si no realiza interfaces (D2). */
function implementsClause(entity: IrEntity): string {
  return entity.implementsInterfaces.length === 0 ? '' : ` implements ${entity.implementsInterfaces.join(', ')}`;
}

/**
 * Entidad JPA: campos con `@Column` explícito, campos de relación, accesores y
 * los stubs de las operaciones UML.
 *
 * D2: un `@MappedSuperclass` no lleva `@Entity` ni `@Table`; la raíz `JOINED`
 * lleva `@Inheritance(strategy = InheritanceType.JOINED)`; una hija de entidad,
 * `extends` más `@PrimaryKeyJoinColumn(name = "id")`. Los campos y relaciones
 * heredados NO se vuelven a declarar: el descendiente los hereda (por eso el
 * emisor los salta y solo el DTO los lista).
 */
export function emitEntity(entity: IrEntity): string {
  const blocks: string[] = [];
  for (const field of entity.fields) {
    if (!field.inherited) blocks.push(renderField(field));
  }
  for (const relation of entity.relations) {
    if (!relation.inherited) blocks.push(renderRelationField(relation));
  }
  for (const field of entity.fields) {
    if (!field.inherited) blocks.push(renderAccessors(field));
  }
  for (const relation of entity.relations) {
    if (!relation.inherited) blocks.push(renderRelationAccessors(relation));
  }
  for (const operation of entity.operations) blocks.push(emitOperationStub(operation));

  const annotations: string[] = [entity.mappedSuperclass ? '@MappedSuperclass' : entityAnnotation(entity)];
  if (!entity.mappedSuperclass) annotations.push(`@Table(name = "${entity.table}")`);
  if (entity.inheritanceRoot) annotations.push('@Inheritance(strategy = InheritanceType.JOINED)');
  if (entity.superclass !== null && !entity.parentMappedSuperclass) {
    annotations.push('@PrimaryKeyJoinColumn(name = "id")');
  }
  const declaration = `public ${entity.isAbstract ? 'abstract ' : ''}class ${entity.name}${extendsClause(entity)}${implementsClause(entity)} {`;

  const body = [...annotations, declaration, '', blocks.join('\n\n'), '}'].join('\n');

  return renderFile(ENTITY_PACKAGE, entity.imports, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// repository/XRepository.java
// ─────────────────────────────────────────────────────────────────────────────

/** `JpaRepository` con la PK como segundo genérico: `UUID` necesita su import. */
export function emitRepository(entity: IrEntity): string {
  const name = derivedName(entity, 'Repository');
  const imports = [`${ENTITY_PACKAGE}.${entity.name}`, 'org.springframework.data.jpa.repository.JpaRepository', ...idField(entity).type.imports];
  const body = [
    `public interface ${name} extends JpaRepository<${entity.name}, ${idType(entity)}> {`,
    '}',
  ].join('\n');
  return renderFile(REPOSITORY_PACKAGE, imports, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// service/XService.java y service/XServiceImpl.java
// ─────────────────────────────────────────────────────────────────────────────

/** Contrato de las cinco operaciones CRUD. Los tipos de PK y de campos viven en los DTO. */
export function emitServiceInterface(entity: IrEntity): string {
  const name = derivedName(entity, 'Service');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const imports = [`${DTO_PACKAGE}.${request}`, `${DTO_PACKAGE}.${response}`, 'java.util.List', ...idField(entity).type.imports];
  const body = [
    `public interface ${name} {`,
    '',
    `${INDENT}List<${response}> findAll();`,
    '',
    `${INDENT}${response} findById(${idType(entity)} id);`,
    '',
    `${INDENT}${response} create(${request} request);`,
    '',
    `${INDENT}${response} update(${idType(entity)} id, ${request} request);`,
    '',
    `${INDENT}void delete(${idType(entity)} id);`,
    '}',
  ].join('\n');
  return renderFile(SERVICE_PACKAGE, imports, body);
}

/**
 * Implementación del CRUD. `404` con `ResponseStatusException` y no
 * `ResponseEntity` en el service (D11); `findAll` mapea con la referencia de
 * método del mapper para no depender de ningún bean de mapeo.
 *
 * ── Lo que agrega la rebanada 4 (D5, D6, tarea 2.5) ─────────────────────────
 *
 * - **Todo el método va `@Transactional`** (`readOnly = true` en las lecturas):
 *   `open-in-view: false` corta la sesión al salir del controlador, así que el
 *   mapeo a DTO —que toca asociaciones `LAZY`— tiene que pasar adentro.
 * - **Los ids se resuelven dentro de la transacción**: `findById` → `400` si no
 *   existe; `findAllById` + comparación de tamaño para las colecciones; una FK
 *   obligatoria que llega `null` → `400` **antes** de tocar la base.
 * - **`repository.flush()` tras cada escritura**: la violación de integridad
 *   salta adentro del proxy del repositorio, donde Spring la traduce a
 *   `DataIntegrityViolationException`, y no en el commit (D6).
 * - **La colección dueña de un `PUT` muta en sitio** (`clear()` + `addAll()`),
 *   nunca `setX(nuevaLista)`: si no, Hibernate lanza «collection … no longer
 *   referenced» (D4, riesgo de la propuesta).
 *
 * Los repositorios de las entidades referenciadas se inyectan acá. **Nunca otro
 * servicio**: así no hay ciclos de beans aunque el modelo tenga ciclos de
 * referencias (D5).
 */
export function emitServiceImpl(entity: IrEntity): string {
  const name = derivedName(entity, 'ServiceImpl');
  const service = derivedName(entity, 'Service');
  const repository = derivedName(entity, 'Repository');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const mapper = derivedName(entity, 'Mapper');
  const id = idType(entity);

  // Solo las referencias que el Request trae (las dueñas) se resuelven (D5).
  const requestRelations = entity.relations.filter((relation) => relation.dto.inRequest);
  // Un repositorio por entidad destino, sin repetir: dos relaciones al mismo
  // destino comparten el repositorio.
  const repositories = new Map<string, string>();
  for (const relation of requestRelations) {
    if (!repositories.has(relation.target)) {
      repositories.set(relation.target, repositoryFieldName(relation.target));
    }
  }

  const plainSetters = entity.fields
    .filter((field) => !field.isId)
    .map((field) => `${INDENT}${INDENT}entity.${field.setter}(request.${field.name}());`);
  const relationSetters = requestRelations.map((relation) => {
    const capitalized = capitalizeFirst(relation.name);
    if (relationIsCollection(relation)) {
      return [
        `${INDENT}${INDENT}entity.get${capitalized}().clear();`,
        `${INDENT}${INDENT}entity.get${capitalized}().addAll(resolve${capitalized}(request.${relation.dto.name}()));`,
      ].join('\n');
    }
    return `${INDENT}${INDENT}entity.set${capitalized}(resolve${capitalized}(request.${relation.dto.name}()));`;
  });

  const constructorParams = [
    `${repository} repository`,
    ...[...repositories.entries()].map(([target, field]) => `${target}Repository ${field}`),
  ];
  const constructorBody = [
    `${INDENT}${INDENT}this.repository = repository;`,
    ...[...repositories.values()].map((field) => `${INDENT}${INDENT}this.${field} = ${field};`),
  ];

  const createArgs = requestRelations.map(
    (relation) => `resolve${capitalizeFirst(relation.name)}(request.${relation.dto.name}())`,
  );
  const createCall =
    createArgs.length === 0 ? `${mapper}.toEntity(request)` : `${mapper}.toEntity(request, ${createArgs.join(', ')})`;

  const resolvers: string[] = [];
  for (const relation of requestRelations) {
    const capitalized = capitalizeFirst(relation.name);
    const repo = repositories.get(relation.target) as string;
    if (relationIsCollection(relation)) {
      resolvers.push(
        [
          `${INDENT}private List<${relation.target}> resolve${capitalized}(List<${relation.dto.idType}> ${relation.dto.name}) {`,
          `${INDENT}${INDENT}if (${relation.dto.name} == null || ${relation.dto.name}.isEmpty()) {`,
          `${INDENT}${INDENT}${INDENT}return new ArrayList<>();`,
          `${INDENT}${INDENT}}`,
          `${INDENT}${INDENT}List<${relation.dto.idType}> distinct = ${relation.dto.name}.stream().distinct().toList();`,
          `${INDENT}${INDENT}List<${relation.target}> found = ${repo}.findAllById(distinct);`,
          `${INDENT}${INDENT}if (found.size() != distinct.size()) {`,
          `${INDENT}${INDENT}${INDENT}throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "${relation.dto.name} contiene un id inexistente");`,
          `${INDENT}${INDENT}}`,
          `${INDENT}${INDENT}return found;`,
          `${INDENT}}`,
        ].join('\n'),
      );
      continue;
    }
    const whenNull = relation.dto.required
      ? `${INDENT}${INDENT}${INDENT}throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "${relation.dto.name} es obligatorio");`
      : `${INDENT}${INDENT}${INDENT}return null;`;
    resolvers.push(
      [
        `${INDENT}private ${relation.target} resolve${capitalized}(${relation.dto.idType} ${relation.dto.name}) {`,
        `${INDENT}${INDENT}if (${relation.dto.name} == null) {`,
        whenNull,
        `${INDENT}${INDENT}}`,
        `${INDENT}${INDENT}return ${repo}.findById(${relation.dto.name})`,
        `${INDENT}${INDENT}${INDENT}${INDENT}.orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "${relation.dto.name} no existe"));`,
        `${INDENT}}`,
      ].join('\n'),
    );
  }

  const imports = [
    `${DTO_PACKAGE}.${request}`,
    `${DTO_PACKAGE}.${response}`,
    `${ENTITY_PACKAGE}.${entity.name}`,
    `${MAPPER_PACKAGE}.${mapper}`,
    `${REPOSITORY_PACKAGE}.${repository}`,
    ...[...repositories.keys()].map((target) => `${REPOSITORY_PACKAGE}.${target}Repository`),
    ...[...repositories.keys()].map((target) => `${ENTITY_PACKAGE}.${target}`),
    ...idField(entity).type.imports,
    ...(requestRelations.some((relation) => relation.dto.idType === 'UUID') ? ['java.util.UUID'] : []),
    'java.util.List',
    ...(requestRelations.some(relationIsCollection) ? ['java.util.ArrayList'] : []),
    'org.springframework.http.HttpStatus',
    'org.springframework.stereotype.Service',
    'org.springframework.transaction.annotation.Transactional',
    'org.springframework.web.server.ResponseStatusException',
  ];

  const updateBody = [
    `${INDENT}${INDENT}${entity.name} entity = load(id);`,
    ...plainSetters,
    ...relationSetters,
  ];

  const propertyLines = [
    `${INDENT}private final ${repository} repository;`,
    ...[...repositories.entries()].map(
      ([target, field]) => `${INDENT}private final ${target}Repository ${field};`,
    ),
  ];

  const rendered = [
    '@Service',
    `public class ${name} implements ${service} {`,
    '',
    propertyLines.join('\n'),
    '',
    `${INDENT}public ${name}(${constructorParams.join(', ')}) {`,
    constructorBody.join('\n'),
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}@Transactional(readOnly = true)`,
    `${INDENT}public List<${response}> findAll() {`,
    `${INDENT}${INDENT}return repository.findAll().stream().map(${mapper}::toResponse).toList();`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}@Transactional(readOnly = true)`,
    `${INDENT}public ${response} findById(${id} id) {`,
    `${INDENT}${INDENT}return ${mapper}.toResponse(load(id));`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}@Transactional`,
    `${INDENT}public ${response} create(${request} request) {`,
    `${INDENT}${INDENT}${entity.name} entity = ${createCall};`,
    `${INDENT}${INDENT}${entity.name} saved = repository.save(entity);`,
    `${INDENT}${INDENT}repository.flush();`,
    `${INDENT}${INDENT}return ${mapper}.toResponse(saved);`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}@Transactional`,
    `${INDENT}public ${response} update(${id} id, ${request} request) {`,
    ...updateBody,
    `${INDENT}${INDENT}${entity.name} saved = repository.save(entity);`,
    `${INDENT}${INDENT}repository.flush();`,
    `${INDENT}${INDENT}return ${mapper}.toResponse(saved);`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}@Transactional`,
    `${INDENT}public void delete(${id} id) {`,
    `${INDENT}${INDENT}repository.delete(load(id));`,
    `${INDENT}${INDENT}repository.flush();`,
    `${INDENT}}`,
    '',
    `${INDENT}private ${entity.name} load(${id} id) {`,
    `${INDENT}${INDENT}return repository.findById(id)`,
    `${INDENT}${INDENT}${INDENT}${INDENT}.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));`,
    `${INDENT}}`,
    ...resolvers.flatMap((resolver) => ['', resolver]),
    '}',
  ].join('\n');
  return renderFile(SERVICE_PACKAGE, imports, rendered);
}

// ─────────────────────────────────────────────────────────────────────────────
// controller/XController.java
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los cinco verbos CRUD. La ruta cuelga de `/api/<ruta de la IR>` —`kebab-case`
 * y sin pluralizar (D3, D11)— y el segmento ya viene plegado a ASCII para
 * `Dirección` → `/api/direccion`, con su nota `route_ascii_folded` en el
 * reporte. Los códigos son los de D11: lista `200`, `GET /{id}` `200|404`,
 * `POST` `201`, `PUT` `200|404`, `DELETE` `204|404`.
 *
 * `create`/`update` llevan `@Valid` en el `@RequestBody` (D5, FR-F11): el
 * rechazo por Bean Validation pasa por `ApiExceptionHandler` antes de que el
 * `request` llegue al servicio, así que nunca toca el repositorio.
 */
export function emitController(entity: IrEntity): string {
  const name = derivedName(entity, 'Controller');
  const service = derivedName(entity, 'Service');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const id = idType(entity);

  const imports = [
    `${DTO_PACKAGE}.${request}`,
    `${DTO_PACKAGE}.${response}`,
    `${SERVICE_PACKAGE}.${service}`,
    ...idField(entity).type.imports,
    'jakarta.validation.Valid',
    'java.util.List',
    'org.springframework.http.HttpStatus',
    'org.springframework.web.bind.annotation.DeleteMapping',
    'org.springframework.web.bind.annotation.GetMapping',
    'org.springframework.web.bind.annotation.PathVariable',
    'org.springframework.web.bind.annotation.PostMapping',
    'org.springframework.web.bind.annotation.PutMapping',
    'org.springframework.web.bind.annotation.RequestBody',
    'org.springframework.web.bind.annotation.RequestMapping',
    'org.springframework.web.bind.annotation.ResponseStatus',
    'org.springframework.web.bind.annotation.RestController',
  ];

  const body = [
    '@RestController',
    `@RequestMapping("/api/${entity.route}")`,
    `public class ${name} {`,
    '',
    `${INDENT}private final ${service} service;`,
    '',
    `${INDENT}public ${name}(${service} service) {`,
    `${INDENT}${INDENT}this.service = service;`,
    `${INDENT}}`,
    '',
    `${INDENT}@GetMapping`,
    `${INDENT}public List<${response}> findAll() {`,
    `${INDENT}${INDENT}return service.findAll();`,
    `${INDENT}}`,
    '',
    `${INDENT}@GetMapping("/{id}")`,
    `${INDENT}public ${response} findById(@PathVariable("id") ${id} id) {`,
    `${INDENT}${INDENT}return service.findById(id);`,
    `${INDENT}}`,
    '',
    `${INDENT}@PostMapping`,
    `${INDENT}@ResponseStatus(HttpStatus.CREATED)`,
    `${INDENT}public ${response} create(@Valid @RequestBody ${request} request) {`,
    `${INDENT}${INDENT}return service.create(request);`,
    `${INDENT}}`,
    '',
    `${INDENT}@PutMapping("/{id}")`,
    `${INDENT}public ${response} update(@PathVariable("id") ${id} id, @Valid @RequestBody ${request} request) {`,
    `${INDENT}${INDENT}return service.update(id, request);`,
    `${INDENT}}`,
    '',
    `${INDENT}@DeleteMapping("/{id}")`,
    `${INDENT}@ResponseStatus(HttpStatus.NO_CONTENT)`,
    `${INDENT}public void delete(@PathVariable("id") ${id} id) {`,
    `${INDENT}${INDENT}service.delete(id);`,
    `${INDENT}}`,
    '}',
  ].join('\n');
  return renderFile(CONTROLLER_PACKAGE, imports, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// dto/XRequest.java y dto/XResponse.java
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `record` de petición (D5): **sin la PK**, que la asigna la base, y **solo con
 * las referencias dueñas**. Los lados inversos (`mappedBy`) son de solo lectura:
 * un `PUT` no puede reemplazar la colección que Hibernate administra (D4).
 *
 * Los componentes salen de `dtoFields` (D1) y no de los campos: así la Fase 4
 * puede aplanar los ancestros sin tocar este emisor.
 *
 * Cada componente obligatorio (`field.required`, D5, FR-F11) lleva su anotación
 * de Bean Validation: así un `POST`/`PUT` que le falte un campo mandatorio
 * rechaza con `400` antes de tocar el repositorio, no en el `flush`.
 */
export function emitRequestDto(entity: IrEntity): string {
  const name = derivedName(entity, 'Request');
  const fields = entity.dtoFields.filter((field) => field.inRequest);
  const imports = [...fields.flatMap((field) => field.imports), ...requiredDtoImports(fields)];
  return renderFile(DTO_PACKAGE, imports, renderRecord(name, fields, { validate: true }));
}

/** `record` de respuesta: **con la PK** y con todas las referencias, dueñas o inversas (D5). */
export function emitResponseDto(entity: IrEntity): string {
  const name = derivedName(entity, 'Response');
  return renderFile(DTO_PACKAGE, entity.dtoFields.flatMap((field) => field.imports), renderRecord(name, entity.dtoFields));
}

// ─────────────────────────────────────────────────────────────────────────────
// mapper/XMapper.java
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeo entidad ↔ DTO. Clase final con constructor privado y métodos estáticos:
 * sin `@Mapper`, sin MapStruct y sin ningún bean que inyectar (D11).
 *
 * La rebanada 4 (D5) cambia la forma: `toEntity` recibe las **referencias ya
 * resueltas** por el servicio dentro del `@Transactional` (el mapper no tiene
 * repositorios, y no debe tenerlos), y `toResponse` proyecta cada referencia a
 * su id —`clienteId`, `cursoIds` ascendente— para que ningún DTO contenga una
 * entidad y el JSON no pueda tener ciclos.
 */
export function emitMapper(entity: IrEntity): string {
  const name = derivedName(entity, 'Mapper');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const requestRelations = entity.relations.filter((relation) => relation.dto.inRequest);

  const relationParameters = requestRelations.map((relation) =>
    relationIsCollection(relation) ? `List<${relation.target}> ${relation.name}` : `${relation.target} ${relation.name}`,
  );
  const toEntitySignature =
    relationParameters.length === 0
      ? `${request} request`
      : `${request} request, ${relationParameters.join(', ')}`;

  const assignments = [
    ...entity.fields
      .filter((field) => !field.isId)
      .map((field) => `${INDENT}${INDENT}entity.${field.setter}(request.${field.name}());`),
    ...requestRelations.map((relation) => {
      const capitalized = capitalizeFirst(relation.name);
      return relationIsCollection(relation)
        ? `${INDENT}${INDENT}entity.get${capitalized}().addAll(${relation.name});`
        : `${INDENT}${INDENT}entity.${`set${capitalized}`}(${relation.name});`;
    }),
  ];

  const components: string[] = [
    ...entity.fields.map((field) => `${INDENT}${INDENT}${INDENT}${INDENT}entity.${field.getter}()`),
    ...entity.relations.map((relation) => {
      const capitalized = capitalizeFirst(relation.name);
      if (relationIsCollection(relation)) {
        return `${INDENT}${INDENT}${INDENT}${INDENT}entity.get${capitalized}().stream().map(${relation.target}::getId)${sortedIdsClause(relation.dto.idType)}.toList()`;
      }
      return `${INDENT}${INDENT}${INDENT}${INDENT}entity.get${capitalized}() == null ? null : entity.get${capitalized}().getId()`;
    }),
  ];

  const imports = [
    `${DTO_PACKAGE}.${request}`,
    `${DTO_PACKAGE}.${response}`,
    `${ENTITY_PACKAGE}.${entity.name}`,
    ...[...new Set(entity.relations.map((relation) => relation.target))].map(
      (target) => `${ENTITY_PACKAGE}.${target}`,
    ),
    ...(entity.relations.some(relationIsCollection) ? ['java.util.List'] : []),
    ...(entity.relations.some(
      (relation) => relationIsCollection(relation) && relation.dto.idType === 'UUID',
    )
      ? ['java.util.Comparator', 'java.util.UUID']
      : []),
  ];

  const toEntityBody = [
    `${INDENT}${INDENT}${entity.name} entity = new ${entity.name}();`,
    ...assignments,
    `${INDENT}${INDENT}return entity;`,
  ];

  const body = [
    `public final class ${name} {`,
    '',
    `${INDENT}private ${name}() {`,
    `${INDENT}}`,
    '',
    `${INDENT}public static ${entity.name} toEntity(${toEntitySignature}) {`,
    ...toEntityBody,
    `${INDENT}}`,
    '',
    `${INDENT}public static ${response} toResponse(${entity.name} entity) {`,
    `${INDENT}${INDENT}return new ${response}(`,
    `${components.join(',\n')});`,
    `${INDENT}}`,
    '}',
  ].join('\n');
  return renderFile(MAPPER_PACKAGE, imports, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Los ocho archivos, con su ruta en el ZIP
// ─────────────────────────────────────────────────────────────────────────────

/** Los archivos de cada entidad, ya ordenados por ruta para el ZIP (D11).
 *
 * D2: un `@MappedSuperclass` solo emite su clase; una clase abstracta con hijas
 * emite clase y repositorio —lo usan las referencias—, sin controller, servicio,
 * DTO ni carpeta Postman. La entidad concreta emite las ocho piezas.
 */
export function emitEntityFiles(entity: IrEntity): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: `${JAVA_SOURCE_ROOT}/entity/${entity.name}.java`, content: emitEntity(entity) },
  ];
  if (entity.mappedSuperclass) return files;
  files.push({
    path: `${JAVA_SOURCE_ROOT}/repository/${derivedName(entity, 'Repository')}.java`,
    content: emitRepository(entity),
  });
  if (entity.isAbstract) return files;
  files.push(
    { path: `${JAVA_SOURCE_ROOT}/service/${derivedName(entity, 'Service')}.java`, content: emitServiceInterface(entity) },
    { path: `${JAVA_SOURCE_ROOT}/service/${derivedName(entity, 'ServiceImpl')}.java`, content: emitServiceImpl(entity) },
    { path: `${JAVA_SOURCE_ROOT}/controller/${derivedName(entity, 'Controller')}.java`, content: emitController(entity) },
    { path: `${JAVA_SOURCE_ROOT}/dto/${derivedName(entity, 'Request')}.java`, content: emitRequestDto(entity) },
    { path: `${JAVA_SOURCE_ROOT}/dto/${derivedName(entity, 'Response')}.java`, content: emitResponseDto(entity) },
    { path: `${JAVA_SOURCE_ROOT}/mapper/${derivedName(entity, 'Mapper')}.java`, content: emitMapper(entity) },
  );
  return files;
}

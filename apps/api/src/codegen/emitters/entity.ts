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
import type { IrEntity, IrField } from '../codegen-ir';
import type { GeneratedFile } from '../zip';
import { emitOperationStub } from './layers';

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

/** Entidad JPA: campos con `@Column` explícito, accesores y los stubs de las operaciones UML. */
export function emitEntity(entity: IrEntity): string {
  const blocks: string[] = [];
  for (const field of entity.fields) blocks.push(renderField(field));
  for (const field of entity.fields) blocks.push(renderAccessors(field));
  for (const operation of entity.operations) blocks.push(emitOperationStub(operation));

  const body = [
    entityAnnotation(entity),
    `@Table(name = "${entity.table}")`,
    `public class ${entity.name} {`,
    '',
    blocks.join('\n\n'),
    '}',
  ].join('\n');

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
 */
export function emitServiceImpl(entity: IrEntity): string {
  const name = derivedName(entity, 'ServiceImpl');
  const service = derivedName(entity, 'Service');
  const repository = derivedName(entity, 'Repository');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const mapper = derivedName(entity, 'Mapper');
  const id = idType(entity);
  const setters = entity.fields
    .filter((field) => !field.isId)
    .map((field) => `${INDENT}${INDENT}entity.${field.setter}(request.${field.name}());`)
    .join('\n');

  const imports = [
    `${DTO_PACKAGE}.${request}`,
    `${DTO_PACKAGE}.${response}`,
    `${ENTITY_PACKAGE}.${entity.name}`,
    `${MAPPER_PACKAGE}.${mapper}`,
    `${REPOSITORY_PACKAGE}.${repository}`,
    ...idField(entity).type.imports,
    'java.util.List',
    'org.springframework.http.HttpStatus',
    'org.springframework.stereotype.Service',
    'org.springframework.web.server.ResponseStatusException',
  ];

  const updateBody = setters === ''
    ? [`${INDENT}${INDENT}${entity.name} entity = load(id);`]
    : [`${INDENT}${INDENT}${entity.name} entity = load(id);`, setters];

  const body = [
    '@Service',
    `public class ${name} implements ${service} {`,
    '',
    `${INDENT}private final ${repository} repository;`,
    '',
    `${INDENT}public ${name}(${repository} repository) {`,
    `${INDENT}${INDENT}this.repository = repository;`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}public List<${response}> findAll() {`,
    `${INDENT}${INDENT}return repository.findAll().stream().map(${mapper}::toResponse).toList();`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}public ${response} findById(${id} id) {`,
    `${INDENT}${INDENT}return ${mapper}.toResponse(load(id));`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}public ${response} create(${request} request) {`,
    `${INDENT}${INDENT}return ${mapper}.toResponse(repository.save(${mapper}.toEntity(request)));`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}public ${response} update(${id} id, ${request} request) {`,
    ...updateBody,
    `${INDENT}${INDENT}return ${mapper}.toResponse(repository.save(entity));`,
    `${INDENT}}`,
    '',
    `${INDENT}@Override`,
    `${INDENT}public void delete(${id} id) {`,
    `${INDENT}${INDENT}repository.delete(load(id));`,
    `${INDENT}}`,
    '',
    `${INDENT}private ${entity.name} load(${id} id) {`,
    `${INDENT}${INDENT}return repository.findById(id)`,
    `${INDENT}${INDENT}${INDENT}${INDENT}.orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));`,
    `${INDENT}}`,
    '}',
  ].join('\n');
  return renderFile(SERVICE_PACKAGE, imports, body);
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
    `${INDENT}public ${response} create(@RequestBody ${request} request) {`,
    `${INDENT}${INDENT}return service.create(request);`,
    `${INDENT}}`,
    '',
    `${INDENT}@PutMapping("/{id}")`,
    `${INDENT}public ${response} update(@PathVariable("id") ${id} id, @RequestBody ${request} request) {`,
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

/** Componentes del `record` en el orden de la entidad, con la sangría del golden. */
function renderRecord(recordName: string, fields: readonly IrField[]): string {
  const components = fields.map((field) => `${INDENT}${INDENT}${field.type.java} ${field.name}`).join(',\n');
  return `public record ${recordName}(\n${components}) {\n}`;
}

/** `record` de petición: **sin la PK**, que la asigna la base (D11). */
export function emitRequestDto(entity: IrEntity): string {
  const name = derivedName(entity, 'Request');
  const fields = entity.fields.filter((field) => !field.isId);
  const imports = fields.flatMap((field) => field.type.imports);
  return renderFile(DTO_PACKAGE, imports, renderRecord(name, fields));
}

/** `record` de respuesta: **con la PK** (D11). */
export function emitResponseDto(entity: IrEntity): string {
  const name = derivedName(entity, 'Response');
  const imports = entity.fields.flatMap((field) => field.type.imports);
  return renderFile(DTO_PACKAGE, imports, renderRecord(name, entity.fields));
}

// ─────────────────────────────────────────────────────────────────────────────
// mapper/XMapper.java
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapeo entidad ↔ DTO. Clase final con constructor privado y métodos estáticos:
 * sin `@Mapper`, sin MapStruct y sin ningún bean que inyectar (D11).
 */
export function emitMapper(entity: IrEntity): string {
  const name = derivedName(entity, 'Mapper');
  const request = derivedName(entity, 'Request');
  const response = derivedName(entity, 'Response');
  const setters = entity.fields
    .filter((field) => !field.isId)
    .map((field) => `${INDENT}${INDENT}entity.${field.setter}(request.${field.name}());`)
    .join('\n');
  const getters = entity.fields
    .map((field) => `${INDENT}${INDENT}${INDENT}${INDENT}entity.${field.getter}()`)
    .join(',\n');

  const imports = [
    `${DTO_PACKAGE}.${request}`,
    `${DTO_PACKAGE}.${response}`,
    `${ENTITY_PACKAGE}.${entity.name}`,
  ];

  const toEntityBody = setters === ''
    ? [`${INDENT}${INDENT}${entity.name} entity = new ${entity.name}();`]
    : [`${INDENT}${INDENT}${entity.name} entity = new ${entity.name}();`, setters];

  const body = [
    `public final class ${name} {`,
    '',
    `${INDENT}private ${name}() {`,
    `${INDENT}}`,
    '',
    `${INDENT}public static ${entity.name} toEntity(${request} request) {`,
    ...toEntityBody,
    `${INDENT}${INDENT}return entity;`,
    `${INDENT}}`,
    '',
    `${INDENT}public static ${response} toResponse(${entity.name} entity) {`,
    `${INDENT}${INDENT}return new ${response}(`,
    `${getters});`,
    `${INDENT}}`,
    '}',
  ].join('\n');
  return renderFile(MAPPER_PACKAGE, imports, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Los ocho archivos, con su ruta en el ZIP
// ─────────────────────────────────────────────────────────────────────────────

/** Los ocho archivos de una entidad, ya ordenados por ruta para el ZIP (D11). */
export function emitEntityFiles(entity: IrEntity): GeneratedFile[] {
  return [
    { path: `${JAVA_SOURCE_ROOT}/entity/${entity.name}.java`, content: emitEntity(entity) },
    { path: `${JAVA_SOURCE_ROOT}/repository/${derivedName(entity, 'Repository')}.java`, content: emitRepository(entity) },
    { path: `${JAVA_SOURCE_ROOT}/service/${derivedName(entity, 'Service')}.java`, content: emitServiceInterface(entity) },
    { path: `${JAVA_SOURCE_ROOT}/service/${derivedName(entity, 'ServiceImpl')}.java`, content: emitServiceImpl(entity) },
    { path: `${JAVA_SOURCE_ROOT}/controller/${derivedName(entity, 'Controller')}.java`, content: emitController(entity) },
    { path: `${JAVA_SOURCE_ROOT}/dto/${derivedName(entity, 'Request')}.java`, content: emitRequestDto(entity) },
    { path: `${JAVA_SOURCE_ROOT}/dto/${derivedName(entity, 'Response')}.java`, content: emitResponseDto(entity) },
    { path: `${JAVA_SOURCE_ROOT}/mapper/${derivedName(entity, 'Mapper')}.java`, content: emitMapper(entity) },
  ];
}

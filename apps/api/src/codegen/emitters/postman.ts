/**
 * Emisor de la colección Postman v2.1 y su environment local (tarea 3.2,
 * FR-F07, SC-F03, D11).
 *
 * La colección es la **suite ejecutable** del proyecto generado: el ZIP no
 * trae tests (requisito «El proyecto generado no incluye pruebas
 * automatizadas»), así que lo que prueba que el CRUD responde es esto, corrido
 * con `npx newman`. Por eso cada request lleva su aserción de código y los
 * cinco van encadenados.
 *
 * La forma es la de D11, punto por punto:
 *
 * - `info._postman_id` sale del **id del diagrama**, no de un UUID al azar: un
 *   `_postman_id` aleatorio haría que dos generaciones del mismo modelo dieran
 *   bytes distintos y rompería SC-F11.
 * - Una carpeta por entidad; dentro, `POST → GET lista → GET id → PUT →
 *   DELETE`, en ese orden, con `{{baseUrl}}` como variable de colección.
 * - El `POST` guarda el id devuelto en una variable de colección
 *   (`pm.collectionVariables.set`) y los tres requests que lo necesitan lo
 *   referencian con `{{…}}`: es lo que hace que la secuencia funcione sin
 *   intervención.
 * - Un cuerpo de ejemplo por tipo, tomado de la tabla de tipos (FR-F04): el
 *   valor sale de `field.type.example`, que es el mismo que resolvió la IR.
 * - Una aserción de código por request: `201`, `200`, `200`, `200`, `204`.
 *
 * Función pura: `JSON.stringify` con sangría fija sobre un objeto cuyas claves
 * se insertan siempre en el mismo orden. Sin reloj, sin azar, sin locale.
 */

import type { CodegenIr, IrEntity, IrRelationField } from '../codegen-ir';
import type { GeneratedFile } from '../zip';

/** Puerto HTTP del proyecto emitido; tiene que coincidir con `application.yml` (D8). */
const SERVER_PORT = 8080;

/** Prefijo de las rutas CRUD: `@RequestMapping("/api/<ruta>")` en el controlador (D11). */
const API_PREFIX = '/api';

/** Variable de colección con la raíz de la API (FR-F07). */
const BASE_URL = `http://localhost:${SERVER_PORT}${API_PREFIX}`;

/** Nombre del environment local. Es un archivo más del ZIP (D11). */
const ENVIRONMENT_PATH = 'postman/local.postman_environment.json';

/**
 * Variable de colección donde el `POST` guarda la PK devuelta. Se deriva de la
 * **ruta** de la entidad y no de su nombre Java: la ruta ya viene plegada a
 * ASCII (D3), así que la variable es un identificador simple incluso para
 * `Dirección` → `direccionId`.
 */
function createdIdVariable(entity: IrEntity): string {
  return `${entity.route.replace(/-/g, '_')}Id`;
}

/** Script de aserción del código de estado; una por request (FR-F07). */
function statusAssertion(expected: number): string[] {
  return [
    `pm.test("responde ${expected}", function () {`,
    `    pm.response.to.have.status(${expected});`,
    '});',
  ];
}

/** Cuerpo de una petición JSON: los valores salen de la tabla de tipos (FR-F04). */
type PostmanBody = Record<string, string | number | boolean | null>;

/** `true` si el campo de relación es una colección (`cursoIds`). */
function relationIsCollection(relation: IrRelationField): boolean {
  return relation.kind === 'OneToMany' || relation.kind === 'ManyToMany';
}

/** Un fixture obligatorio ya creado en la carpeta y su variable de colección (D9). */
interface FixtureState {
  /** Entidades de fixture, en orden de creación. */
  created: string[];
  /** Variable de colección por entidad creada. */
  variableByName: Map<string, string>;
}

/** Variable de colección del fixture `<Entidad>` dentro de la carpeta `<Carpeta>` (D9). */
function fixtureVariable(folder: string, entity: string): string {
  return `fx_${folder}_${entity}Id`;
}

/**
 * Cuerpo de ejemplo del `POST`/`PUT` (D9): los campos de la petición, sin la PK,
 * más cada referencia dueña. Una referencia obligatoria viaja con el id del
 * fixture creado antes en la misma carpeta; las opcionales —y las colecciones—
 * viajan `null`.
 */
function requestBody(entity: IrEntity, resolveReference: (relation: IrRelationField) => string | null): PostmanBody {
  const body: PostmanBody = {};
  for (const field of entity.fields) {
    if (field.isId) continue;
    body[field.name] = field.type.example;
  }
  for (const relation of entity.relations) {
    if (!relation.dto.inRequest) continue;
    body[relation.dto.name] =
      relation.dto.required && !relationIsCollection(relation) ? resolveReference(relation) : null;
  }
  return body;
}

interface PostmanUrl {
  raw: string;
  host: string[];
  path: string[];
}

function urlFor(entity: IrEntity, withId: string | null): PostmanUrl {
  const path = withId === null ? [entity.route] : [entity.route, withId];
  return {
    raw: `{{baseUrl}}/${path.join('/')}`,
    host: ['{{baseUrl}}'],
    path,
  };
}

interface PostmanRequest {
  name: string;
  event: { listen: 'test'; script: { type: 'text/javascript'; exec: string[] } }[];
  request: {
    method: string;
    header?: { key: string; value: string }[];
    body?: { mode: 'raw'; raw: string; options: { raw: { language: 'json' } } };
    url: PostmanUrl;
    description?: string;
  };
  response: never[];
}

function jsonRequest(
  name: string,
  method: string,
  url: PostmanUrl,
  exec: string[],
  body: PostmanBody | null,
  description: string,
): PostmanRequest {
  const request: PostmanRequest['request'] = { method, url, description };
  if (body !== null) {
    request.header = [{ key: 'Content-Type', value: 'application/json' }];
    request.body = { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } };
  }
  return {
    name,
    event: [{ listen: 'test', script: { type: 'text/javascript', exec } }],
    request,
    response: [],
  };
}

/**
 * Resuelve la variable del fixture que satisface una referencia obligatoria.
 * Si el destino es una clase abstracta, el fixture creado es su primer
 * descendiente concreto con `<` (D9), así que se acepta tanto el nombre exacto
 * como cualquier ancestro del fixture ya creado.
 */
function referenceResolver(
  entityByName: Map<string, IrEntity>,
  fixtures: FixtureState,
): (relation: IrRelationField) => string | null {
  const ancestorNames = (name: string): Set<string> => {
    const names = new Set<string>();
    let current: string | null = name;
    while (current !== null) {
      names.add(current);
      current = entityByName.get(current)?.superclass ?? null;
    }
    return names;
  };
  return (relation) => {
    for (const created of fixtures.created) {
      if (created !== relation.target && !ancestorNames(created).has(relation.target)) continue;
      const variable = fixtures.variableByName.get(created);
      if (variable !== undefined) return `{{${variable}}}`;
    }
    return null;
  };
}

/**
 * Una carpeta Postman (D9): primero los fixtures de la clausura obligatoria
 * —`POST` de cada uno, asserta `201` y guarda `fx_<Carpeta>_<Entidad>Id`—,
 * después las cinco operaciones CRUD con las referencias en el cuerpo, y al
 * final el `DELETE` de los fixtures en orden inverso, que asserta `204`.
 */
function entityFolder(
  ir: CodegenIr,
  entity: IrEntity,
  entityByName: Map<string, IrEntity>,
): { name: string; item: PostmanRequest[] } {
  const idVar = `{{${createdIdVariable(entity)}}}`;
  const fixtures: FixtureState = { created: [], variableByName: new Map() };
  const items: PostmanRequest[] = [];

  for (const fixtureName of ir.fixturePlan[entity.name] ?? []) {
    const fixture = entityByName.get(fixtureName);
    if (fixture === undefined) continue;
    const variable = fixtureVariable(entity.name, fixtureName);
    items.push(
      jsonRequest(
        `Crear fixture ${fixture.name} de ${entity.name}`,
        'POST',
        urlFor(fixture, null),
        [
          ...statusAssertion(201),
          `pm.collectionVariables.set("${variable}", pm.response.json().id);`,
        ],
        requestBody(fixture, referenceResolver(entityByName, fixtures)),
        `Crea el ${fixture.name} que la carpeta ${entity.name} necesita como referencia obligatoria.`,
      ),
    );
    fixtures.created.push(fixtureName);
    fixtures.variableByName.set(fixtureName, variable);
  }

  const createExec = [
    ...statusAssertion(201),
    // El id lo devuelve el servidor: el cliente nunca lo inventa. Se guarda
    // como variable de colección para los tres requests siguientes.
    `pm.collectionVariables.set("${createdIdVariable(entity)}", pm.response.json().id);`,
  ];
  const subjectBody = requestBody(entity, referenceResolver(entityByName, fixtures));
  items.push(
    jsonRequest(
      `Crear ${entity.name}`,
      'POST',
      urlFor(entity, null),
      createExec,
      subjectBody,
      `Crea un ${entity.name} y guarda su id en ${createdIdVariable(entity)}.`,
    ),
    jsonRequest(`Listar ${entity.name}`, 'GET', urlFor(entity, null), statusAssertion(200), null, `Lista todos los ${entity.name}.`),
    jsonRequest(
      `Obtener ${entity.name}`,
      'GET',
      urlFor(entity, idVar),
      statusAssertion(200),
      null,
      `Obtiene el ${entity.name} creado por el request anterior.`,
    ),
    jsonRequest(
      `Actualizar ${entity.name}`,
      'PUT',
      urlFor(entity, idVar),
      statusAssertion(200),
      subjectBody,
      `Actualiza el ${entity.name} creado por el primer request de la carpeta.`,
    ),
    jsonRequest(
      `Eliminar ${entity.name}`,
      'DELETE',
      urlFor(entity, idVar),
      statusAssertion(204),
      null,
      `Elimina el ${entity.name} creado por el primer request de la carpeta.`,
    ),
  );

  for (const fixtureName of [...fixtures.created].reverse()) {
    const fixture = entityByName.get(fixtureName);
    const variable = fixtures.variableByName.get(fixtureName);
    if (fixture === undefined || variable === undefined) continue;
    items.push(
      jsonRequest(
        `Eliminar fixture ${fixture.name} de ${entity.name}`,
        'DELETE',
        urlFor(fixture, `{{${variable}}}`),
        statusAssertion(204),
        null,
        `Borra el fixture ${fixture.name} en orden inverso al de creación.`,
      ),
    );
  }

  return { name: entity.name, item: items };
}

/** La colección v2.1 completa (D11, D9). */
function buildCollection(ir: CodegenIr): Record<string, unknown> {
  const entityByName = new Map(ir.entities.map((entity) => [entity.name, entity]));
  return {
    info: {
      _postman_id: ir.diagramId,
      name: ir.artifactId,
      description: `CRUD generado por UMLive para el diagrama del proyecto ${ir.artifactId}. Se corre con npx newman contra el proyecto levantado.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    // Las clases abstractas y los `@MappedSuperclass` no tienen controller: no
    // hay carpeta Postman para ellas (D2).
    item: ir.entities
      .filter((entity) => !entity.isAbstract && !entity.mappedSuperclass)
      .map((entity) => entityFolder(ir, entity, entityByName)),
    variable: [{ key: 'baseUrl', value: BASE_URL, type: 'string' }],
  };
}

/** El environment local que la colección espera (D11). */
function buildEnvironment(ir: CodegenIr): Record<string, unknown> {
  return {
    id: ir.diagramId,
    name: `${ir.artifactId} local`,
    values: [{ key: 'baseUrl', value: BASE_URL, type: 'default', enabled: true }],
    _postman_variable_scope: 'environment',
  };
}

/**
 * Los dos archivos de Postman para el ZIP. Se serializan acá y no en dos
 * exportaciones separadas porque la colección y su environment comparten
 * `baseUrl` y tienen que salir del mismo cálculo.
 */
export function emitPostmanFiles(ir: CodegenIr): GeneratedFile[] {
  return [
    {
      path: `postman/${ir.artifactId}.postman_collection.json`,
      content: `${JSON.stringify(buildCollection(ir), null, 2)}\n`,
    },
    {
      path: ENVIRONMENT_PATH,
      content: `${JSON.stringify(buildEnvironment(ir), null, 2)}\n`,
    },
  ];
}

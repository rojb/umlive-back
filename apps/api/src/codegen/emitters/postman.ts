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

import type { CodegenIr, IrEntity } from '../codegen-ir';
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

/** Cuerpo de ejemplo del `POST`/`PUT`: los campos de la petición, sin la PK (D11). */
function exampleBody(entity: IrEntity): Record<string, string | number | boolean> {
  const body: Record<string, string | number | boolean> = {};
  for (const field of entity.fields) {
    if (field.isId) continue;
    body[field.name] = field.type.example;
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
  body: Record<string, string | number | boolean> | null,
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
 * Las cinco operaciones encadenadas de una entidad (FR-F07). El `POST` guarda
 * la PK en la variable de colección que los otros tres requests referencian;
 * `DELETE` es el último, así la secuencia deja el estado limpio.
 */
function entityFolder(entity: IrEntity): { name: string; item: PostmanRequest[] } {
  const idVar = `{{${createdIdVariable(entity)}}}`;
  const createExec = [
    ...statusAssertion(201),
    // El id lo devuelve el servidor: el cliente nunca lo inventa. Se guarda
    // como variable de colección para los tres requests siguientes.
    `pm.collectionVariables.set("${createdIdVariable(entity)}", pm.response.json().id);`,
  ];
  return {
    name: entity.name,
    item: [
      jsonRequest(
        `Crear ${entity.name}`,
        'POST',
        urlFor(entity, null),
        createExec,
        exampleBody(entity),
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
        exampleBody(entity),
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
    ],
  };
}

/** La colección v2.1 completa (D11). */
function buildCollection(ir: CodegenIr): Record<string, unknown> {
  return {
    info: {
      _postman_id: ir.diagramId,
      name: ir.artifactId,
      description: `CRUD generado por UMLive para el diagrama del proyecto ${ir.artifactId}. Se corre con npx newman contra el proyecto levantado.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: ir.entities.map(entityFolder),
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

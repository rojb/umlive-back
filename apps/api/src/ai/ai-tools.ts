import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  PRIMITIVE_TYPES,
  type AggregationKind,
  type EditableParameterDirection,
  type ElementKind,
  type RelationshipKind,
  type Visibility,
} from '@umlive/contracts';
import type { AiInputMode } from '../generated/prisma/enums';
import type { ToolDefinition } from './providers/llm-provider.interface';

/**
 * Catálogo cerrado de herramientas del turno de texto/voz (M6, rebanada 2/4).
 *
 * Siete herramientas (FR-D09, FR-D17). Es `ToolDefinition` y no un tipo de
 * vendor: el subconjunto de JSON Schema que los modelos manejan bien es parte
 * del contrato, no un detalle del SDK.
 *
 * ── El subconjunto conservador (D6) ────────────────────────────────────────
 *
 * Permitido: `type` (un solo string), `properties`, `required`, `items`,
 * `enum` (solo strings) y `description`.
 *
 * Prohibido, y **verificado al arrancar** por `assertConservativeSchemas`:
 * `additionalProperties`, `oneOf`/`anyOf`/`allOf`, `$ref`/`$defs`, `const`,
 * `default`, `pattern`, `format`, `min*`/`max*`, `nullable` y `type: [...]`.
 * Gemini —como cualquier proveedor— los rechaza o los interpreta distinto.
 *
 * La nulabilidad se expresa como propiedad OPCIONAL (fuera de `required`). La
 * autoridad de verdad es la validación propia de `ai-turn-plan.ts` (FR-D05,
 * SC-D03); estos esquemas solo describen la forma para el modelo.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/**
 * Tope de operaciones del plan de un turno (D2, PO-A).
 *
 * La transacción de aplicación corre con `{ timeout: 5000, maxWait: 2000 }`
 * iguales a las del pipeline humano, así que lo que limita no es el timeout del
 * turno sino el de las operaciones humanas que esperan detrás del `FOR UPDATE`.
 * 40 cubre el turno grande realista (5 clases, 20 atributos y 4 relaciones son
 * 29 operaciones) y deja más de 3× de margen contra los 5 s de quien espera.
 *
 * Una llamada que empuja el plan más allá del tope recibe `op_limit_reached`
 * como resultado de herramienta; **no** termina el turno ni rompe la atomicidad
 * del lote (D2, PO-A).
 */
export const MAX_OPS_PER_TURN = 40;

/**
 * Tope de operaciones del plan de un turno de IMAGEN (D5, PO-5).
 *
 * Es más alto que el de texto porque una foto de un pizarrón real produce
 * muchas más llamadas de las que una instrucción escrita produce: 80 cubre la
 * foto de referencia de 10 clases (KR7) con sus atributos y relaciones, y sigue
 * por debajo de lo que tolera la transacción de 5 s (el tope se mide contra ese
 * timeout, nunca se sube el timeout).
 */
export const MAX_IMAGE_OPS_PER_TURN = 80;

/** Iteraciones del bucle de imagen (D5, PO-C): 6, no 25. */
export const MAX_IMAGE_ITERATIONS = 6;

/**
 * Topes por modo de entrada (D5). El texto conserva los suyos —40 operaciones y
 * 25 iteraciones— y la imagen tiene los propios, porque reenvía la foto entera
 * en cada vuelta: 25 iteraciones con una imagen `10 MB` no son un turno, son una
 * factura. La clave sale de `AiInputMode`, la misma que usa una palabra clave al
 * arrancar.
 */
export const TURN_LIMITS: Record<AiInputMode, { readonly ops: number; readonly iterations: number }> = {
  TEXT: { ops: MAX_OPS_PER_TURN, iterations: 25 },
  VOICE: { ops: MAX_OPS_PER_TURN, iterations: 25 },
  IMAGE: { ops: MAX_IMAGE_OPS_PER_TURN, iterations: MAX_IMAGE_ITERATIONS },
};

const CLASSIFIER_KINDS: ElementKind[] = [
  'CLASS',
  'INTERFACE',
  'ENUMERATION',
  'DATATYPE',
  'PRIMITIVE_TYPE',
  'PACKAGE',
];

const VISIBILITIES: Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE'];

const RELATIONSHIP_KINDS: RelationshipKind[] = [
  'ASSOCIATION',
  'GENERALIZATION',
  'INTERFACE_REALIZATION',
  'DEPENDENCY',
  'USAGE',
];

const AGGREGATIONS: AggregationKind[] = ['NONE', 'SHARED', 'COMPOSITE'];

const PARAMETER_DIRECTIONS: EditableParameterDirection[] = ['IN', 'OUT', 'INOUT'];

/**
 * Descripción uniforme del alias, para no repetirla en cada esquema.
 *
 * Decía «de la foto del diagrama». Igual que en `ai-turn-prompt.ts`, esa
 * palabra empujaba al modelo a esperar una imagen en un turno de texto: acá
 * pesa más todavía, porque esta línea se repite en el esquema de CADA
 * herramienta. «Estado del diagrama» es lo que realmente recibe.
 */
const ALIAS_HELP =
  'Alias del estado del diagrama (e:3 elemento, f:7 atributo u operación, r:2 relación) o new:1 para algo que este turno creó.';

/**
 * Las siete herramientas del turno de texto. El orden es el de la tabla de D6
 * (creación, completado, edición, borrado, ubicación).
 */
export const AI_TURN_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_class',
    description:
      'Crea un clasificador nuevo (clase, interfaz, enumeración, tipo de dato, primitivo o paquete). Devuelve un alias new:N con el que las llamadas siguientes se refieren a él.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Nombre exacto del clasificador, con sus tildes y en el idioma del usuario. Nunca se traduce ni se translitera. Máximo 120 caracteres.',
        },
        kind: {
          type: 'string',
          enum: CLASSIFIER_KINDS,
          description: 'Tipo de clasificador. Si se omite, es una clase.',
        },
        parent: { type: 'string', description: `Paquete contenedor. ${ALIAS_HELP}` },
        isAbstract: { type: 'boolean', description: 'Si el clasificador es abstracto.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_attribute',
    description: 'Agrega un atributo a un elemento que ya existe o que este turno creó.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Elemento dueño del atributo. ${ALIAS_HELP}` },
        name: {
          type: 'string',
          description: 'Nombre exacto del atributo, con tildes. Máximo 120 caracteres.',
        },
        type: {
          type: 'string',
          description: `Tipo del atributo: un primitivo (${PRIMITIVE_TYPES.slice(0, 6).join(', ')}…) o el alias de un elemento modelado.`,
        },
        visibility: { type: 'string', enum: VISIBILITIES, description: 'Visibilidad UML.' },
        multiplicity: {
          type: 'string',
          description: 'Multiplicidad textual: "1", "0..1", "1..*" o "*". Si se omite, es "1".',
        },
        defaultValue: { type: 'string', description: 'Valor por defecto, si tiene.' },
        isStatic: { type: 'boolean', description: 'Atributo estático.' },
        isReadonly: { type: 'boolean', description: 'Atributo de solo lectura.' },
        isDerived: { type: 'boolean', description: 'Atributo derivado.' },
      },
      required: ['target', 'name'],
    },
  },
  {
    name: 'add_operation',
    description:
      'Agrega una operación (método) a un elemento, con sus parámetros. Devuelve el alias new:N de la operación.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Elemento dueño de la operación. ${ALIAS_HELP}` },
        name: {
          type: 'string',
          description: 'Nombre exacto de la operación, con tildes. Máximo 120 caracteres.',
        },
        returnType: {
          type: 'string',
          description: 'Tipo de retorno: un primitivo o el alias de un elemento modelado.',
        },
        visibility: { type: 'string', enum: VISIBILITIES, description: 'Visibilidad UML.' },
        isAbstract: { type: 'boolean', description: 'Operación abstracta.' },
        isQuery: { type: 'boolean', description: 'Operación de consulta.' },
        isStatic: { type: 'boolean', description: 'Operación estática.' },
        parameters: {
          type: 'array',
          description: 'Parámetros de la operación, en orden.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nombre exacto del parámetro.' },
              type: { type: 'string', description: 'Tipo del parámetro.' },
              direction: {
                type: 'string',
                enum: PARAMETER_DIRECTIONS,
                description: 'Dirección del parámetro. Si se omite, es IN.',
              },
            },
            required: ['name'],
          },
        },
      },
      required: ['target', 'name'],
    },
  },
  {
    name: 'create_relationship',
    description:
      'Crea una relación entre dos elementos. Una composición es una asociación con aggregation COMPOSITE sobre el extremo destino.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: RELATIONSHIP_KINDS, description: 'Tipo de relación.' },
        source: { type: 'string', description: `Elemento de origen. ${ALIAS_HELP}` },
        target: { type: 'string', description: `Elemento de destino. ${ALIAS_HELP}` },
        name: { type: 'string', description: 'Nombre de la relación, si tiene.' },
        sourceMultiplicity: {
          type: 'string',
          description: 'Multiplicidad del extremo origen (solo asociaciones).',
        },
        targetMultiplicity: {
          type: 'string',
          description: 'Multiplicidad del extremo destino (solo asociaciones).',
        },
        aggregation: {
          type: 'string',
          enum: AGGREGATIONS,
          description: 'Agregación del extremo destino (solo asociaciones).',
        },
      },
      required: ['kind', 'source', 'target'],
    },
  },
  {
    name: 'update_element',
    description:
      'Cambia algo que ya existe: renombra, marca abstracto, cambia el tipo o la multiplicidad, etc. El alias decide si es un elemento, un atributo, una operación o una relación.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Qué se cambia. ${ALIAS_HELP}` },
        name: { type: 'string', description: 'Nombre nuevo, exactamente como lo dijo el usuario.' },
        isAbstract: { type: 'boolean', description: 'Marca o desmarca abstracto (elementos).' },
        type: { type: 'string', description: 'Tipo nuevo (atributos y operaciones).' },
        visibility: { type: 'string', enum: VISIBILITIES, description: 'Visibilidad nueva.' },
        multiplicity: { type: 'string', description: 'Multiplicidad nueva (atributos).' },
        defaultValue: { type: 'string', description: 'Valor por defecto nuevo (atributos).' },
        isStatic: { type: 'boolean', description: 'Marca o desmarca estático.' },
        isReadonly: { type: 'boolean', description: 'Marca o desmarca de solo lectura.' },
        isDerived: { type: 'boolean', description: 'Marca o desmarca derivado.' },
        isQuery: { type: 'boolean', description: 'Marca o desmarca de consulta (operaciones).' },
        sourceMultiplicity: {
          type: 'string',
          description: 'Multiplicidad nueva del extremo origen (relaciones).',
        },
        targetMultiplicity: {
          type: 'string',
          description: 'Multiplicidad nueva del extremo destino (relaciones).',
        },
        aggregation: {
          type: 'string',
          enum: AGGREGATIONS,
          description: 'Agregación nueva del extremo destino (relaciones).',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'delete_element',
    description:
      'Borra un elemento, un atributo, una operación o una relación. El alias decide qué se borra.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Qué se borra. ${ALIAS_HELP}` },
      },
      required: ['target'],
    },
  },
  {
    name: 'apply_layout',
    description:
      'Ubica una clase nueva en el lienzo. Sobre un elemento que ya existe lo mueve; sobre algo que este turno creó, se pliega en la creación (no genera un movimiento).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: `Qué se ubica. ${ALIAS_HELP}` },
        x: { type: 'number', description: 'Coordenada X dentro del lienzo.' },
        y: { type: 'number', description: 'Coordenada Y dentro del lienzo.' },
      },
      required: ['target', 'x', 'y'],
    },
  },
];

/**
 * Metadatos de corrida del turno de imagen (D5): `confidence` y `note`, los dos
 * OPCIONALES. `confidence: 'low'` es la única forma en que el modelo declara su
 * propia duda; el resto de la marca de baja confianza la pone el servidor.
 *
 * Son propiedades opcionales —fuera de `required`— porque el subconjunto
 * conservador expresa nulabilidad así (D6 de `ai-text-instructions`).
 */
const RUN_META_PROPERTIES = {
  confidence: {
    type: 'string',
    enum: ['high', 'low'],
    description:
      'Tu confianza en esta llamada. Poné "low" ante cualquier duda (una multiplicidad que no se lee, un nombre que no se distingue): la persona la revisa y decide.',
  },
  note: {
    type: 'string',
    description: 'Una frase corta que explique la duda o la decisión, para la vista previa.',
  },
} as const;

/**
 * Las herramientas del turno de IMAGEN (D5, PO-3): solo creación, sin
 * `update_element` ni `delete_element`. Modificar un diagrama tampoco las
 * habilita: el turno de imagen agrega un delta, nunca borra ni mueve lo que ya
 * existe.
 */
const IMAGE_TOOL_NAMES = ['create_class', 'add_attribute', 'add_operation', 'create_relationship'] as const;

/**
 * `apply_layout` en modo imagen: la posición que el modelo ve es la de la FOTO,
 * no la del lienzo, así que pide el CENTRO normalizado (0..1) y el servidor lo
 * convierte (D7). Sobre un elemento que ya existe es un error de herramienta.
 */
const IMAGE_APPLY_LAYOUT: ToolDefinition = {
  name: 'apply_layout',
  description:
    'Ubica una clase que este turno creó. Solo acepta alias new:N: el turno de imagen nunca mueve algo que ya existe.',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Alias new:N de una clase que este turno creó.',
      },
      nx: {
        type: 'number',
        description:
          'Posición horizontal del CENTRO de la clase en la foto, normalizada de 0 (borde izquierdo) a 1 (borde derecho).',
      },
      ny: {
        type: 'number',
        description:
          'Posición vertical del CENTRO de la clase en la foto, normalizada de 0 (borde superior) a 1 (borde inferior).',
      },
    },
    required: ['target', 'nx', 'ny'],
  },
};

/** Agrega `confidence`/`note` sin mutar el esquema original. */
function withRunMeta(tool: ToolDefinition): ToolDefinition {
  const properties = (tool.parameters['properties'] ?? {}) as Record<string, unknown>;
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...properties, ...RUN_META_PROPERTIES },
    },
  };
}

/** Las cinco herramientas del turno de imagen, con sus metadatos de corrida. */
export const IMAGE_TURN_TOOLS: readonly ToolDefinition[] = [
  ...AI_TURN_TOOLS.filter((tool) => (IMAGE_TOOL_NAMES as readonly string[]).includes(tool.name)).map(withRunMeta),
  withRunMeta(IMAGE_APPLY_LAYOUT),
];

/**
 * El catálogo de herramientas que ve el modelo para `inputMode` (D5). El turno
 * de texto/voz mantiene sus siete; el de imagen solo las cinco de creación.
 */
export function buildTools(inputMode: AiInputMode): readonly ToolDefinition[] {
  return inputMode === 'IMAGE' ? IMAGE_TURN_TOOLS : AI_TURN_TOOLS;
}

/**
 * Palabras clave que el subconjunto conservador prohíbe (D6). Se listan
 * explícitamente y además se cortan por prefijo `min`/`max`/`exclusiveMin`/
 * `exclusiveMax`, porque las restricciones numéricas de JSON Schema crecen en
 * esa familia (`minimum`, `maxItems`, `minLength`, …) y una lista cerrada se
 * queda corta en la próxima revisión del estándar.
 */
const FORBIDDEN_KEYWORDS = new Set([
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
  '$defs',
  'definitions',
  'const',
  'default',
  'pattern',
  'format',
  'nullable',
  'multipleOf',
]);

const FORBIDDEN_PREFIXES = ['min', 'max', 'exclusiveMin', 'exclusiveMax'];

/** Lo que se lanza si un esquema se sale del subconjunto. Falla ruidosamente. */
export class ToolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSchemaError';
  }
}

/**
 * Recorre los esquemas y LANZA si aparece una palabra clave prohibida (D6).
 *
 * Existe porque el esquema lo escribe una persona y lo consume un proveedor: sin
 * la guarda, un `pattern` que hoy devuelve `400` en el primer turno real entraría
 * en silencio y se descubriría en producción. Falla al arrancar, no en el turno.
 */
export function assertConservativeSchemas(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) {
    walk(tool.name, '', tool.parameters);
  }
}

function walk(toolName: string, path: string, node: unknown): void {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      walk(toolName, `${path}[${index}]`, item);
    }
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = path === '' ? key : `${path}.${key}`;
    const forbidden =
      FORBIDDEN_KEYWORDS.has(key) ||
      FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix));

    if (forbidden) {
      throw new ToolSchemaError(
        `la herramienta ${toolName} usa la palabra clave prohibida "${key}" en ${here}: ` +
          'el subconjunto conservador de D6 no la admite',
      );
    }
    // `type: [...]` era la forma de decir "uno de estos tipos": un array acá es
    // una unión disfrazada y se prohíbe igual que `oneOf` (D6).
    if (key === 'type' && Array.isArray(value)) {
      throw new ToolSchemaError(
        `la herramienta ${toolName} declara "type" como array en ${here}: ` +
          'el subconjunto conservador admite un solo tipo string',
      );
    }
    walk(toolName, here, value);
  }
}

/**
 * Proveedor Nest que corre la guarda en `onModuleInit` (D6): el catálogo se
 * audita una vez al arrancar, antes de que exista un solo turno.
 *
 * Es `@Injectable()` y no una llamada suelta porque el momento importa: si
 * `AiModule` no lo registra, la guarda no corre, y registrarlo es parte de la
 * tarea. Exporta `AI_TURN_TOOLS` para el bucle de la rebanada 3.
 */
@Injectable()
export class AiToolsService implements OnModuleInit {
  private readonly log = new Logger(AiToolsService.name);

  onModuleInit(): void {
    // La guarda recorre las DOS variantes: un `pattern` colado en el esquema de
    // imagen fallaría igual que uno en el de texto, y descubrirlo en el primer
    // turno real es demasiado tarde (D6).
    assertConservativeSchemas(AI_TURN_TOOLS);
    assertConservativeSchemas(IMAGE_TURN_TOOLS);
    this.log.log(
      `catálogo verificado (subconjunto conservador de JSON Schema): ` +
        `${AI_TURN_TOOLS.length} herramientas de texto (tope ${TURN_LIMITS.TEXT.ops} operaciones, ` +
        `${TURN_LIMITS.TEXT.iterations} iteraciones) y ${IMAGE_TURN_TOOLS.length} de imagen ` +
        `(tope ${TURN_LIMITS.IMAGE.ops} operaciones, ${TURN_LIMITS.IMAGE.iterations} iteraciones)`,
    );
  }
}

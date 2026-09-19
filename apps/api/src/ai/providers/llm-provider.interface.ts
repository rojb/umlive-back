import type { AiCapabilities } from '@umlive/contracts';

/**
 * El único contrato de acceso a modelos del backend (`PRD.md:689`, FR-D01).
 *
 * Nada por encima de esta costura sabe qué proveedor está configurado: ni la
 * forma del pedido, ni la forma de la respuesta, ni ninguna capacidad de un
 * vendor cruza el límite (design D2). Por eso acá no aparece ningún tipo de
 * `ai` ni de los paquetes `@ai-sdk/*`: el adaptador traduce y devuelve estos
 * tipos neutrales.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "`LlmProvider` es
 * el único contrato de acceso a modelos". Diseño: `design.md` D1/D2, y
 * `ai-text-instructions/design.md` D8 (variantes `assistant`/`tool` y eco
 * opaco).
 *
 * `apps/api` es CommonJS: los imports relativos van sin `.js`.
 */

/**
 * Una llamada a herramienta que devolvió el modelo, en el dialecto neutral.
 *
 * `opaque` es el eco que el proveedor exige reenviar en la iteración
 * siguiente (la *thought signature* de los modelos Gemini, que el SDK expone
 * como `providerMetadata`). Nada por encima de este puerto lo interpreta: el
 * adaptador lo escribe, el bucle lo reenvía tal como llegó, y si es `undefined`
 * simplemente se omite. No cuesta nada tenerlo y sin él el bucle de dos o más
 * iteraciones puede fallar con `400` (D8, riesgo 2).
 */
export interface LlmToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly opaque?: unknown;
}

/**
 * Un mensaje del chat, en el dialecto neutral del backend.
 *
 * Cuatro variantes, discriminadas por `role` (D8):
 *
 * - `system`/`user`: texto plano.
 * - `assistant`: el texto de la respuesta más las llamadas a herramienta de esa
 *   iteración, cada una con su eco `opaque`.
 * - `tool`: el resultado de una llamada, de vuelta al modelo.
 *
 * ── Por qué TODAS las variantes llevan `content: string` ────────────────────
 *
 * El estimador de gasto (`ai-spend.service.ts`, `estimateCost`) pliega sobre
 * `content.length` para acotar el costo por arriba. Ese archivo NO está entre
 * las superficies de esta rebanada, así que el campo común se conserva en todas
 * las variantes: para `assistant` es el mismo texto que `text`, y para `tool`
 * es la salida ya serializada que recibe el modelo. La estimación es una cota
 * superior, contar el texto una vez alcanza, y el tipo obliga a proveerlo en
 * vez de dejar que el estimador lea `undefined` en runtime.
 */
export type LlmMessage = { readonly content: string } & (
  | { readonly role: 'system' | 'user' }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly LlmToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      /** Resultado estructurado tal como lo produjo el servidor. */
      readonly output: unknown;
    }
);

/**
 * Una imagen de entrada. `data` acepta bytes crudos o base64; el adaptador la
 * traduce a `FilePart` (design D2). `ImagePart` del SDK está deprecado.
 *
 * ── Por qué `width`/`height` son OBLIGATORIOS (D9.3 de `ai-image-input`) ────
 *
 * La cadena descarta los eslabones cuyo límite declarado no entra con la imagen
 * («`maxImageDimension` = 1024» y una foto de 2048 de ancho), y la reserva de
 * gasto cuenta los tokens de la imagen con sus dimensiones (`imageTokenBound`).
 * Ninguna de las dos cosas se puede decidir DESPUÉS de codificar el archivo: el
 * que construye la imagen ya leyó sus dimensiones del encabezado con
 * `readImageDimensions`, así que las pasa y el tipo obliga a que las pase en vez
 * de dejar que el filtro lea `undefined` en runtime.
 */
export interface LlmImage {
  readonly mediaType: string;
  readonly data: string | Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Una herramienta declarada en JSON Schema plano (FR-D09): sin dialecto de
 * vendor. La traducción al SDK la hace `ai-sdk.provider.ts` y la validación
 * server-side de argumentos (FR-D05) es de la rebanada 2 — acá solo viaja.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema del input. Sin `additionalProperties` implícito de ningún vendor. */
  readonly parameters: Record<string, unknown>;
}

/**
 * El resultado de un `complete`/`completeWithImages`.
 *
 * `toolCalls` son llamadas devueltas por el modelo — nunca ejecutadas acá.
 *
 * `inputTokens`/`outputTokens` son `number | null`: el SDK los expone como
 * `number | undefined`, y `undefined` significa "el proveedor no reportó uso".
 * El libro de gasto (D3) distingue ese caso de un cero, porque `undefined`
 * deja la reserva en pie en vez de cobrar cero.
 */
export interface LlmCompletion {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
  };
  /** Motivo de fin del proveedor, ya normalizado a `string` por el adaptador. */
  readonly finishReason: string;
}

/**
 * Opciones de un llamado. `maxOutputTokens` es el tope que hace que la reserva
 * sea una cota superior (design D2/D3); `abortSignal` es del llamador y, a
 * diferencia de un error de proveedor, corta la cadena entera (FR-D08).
 */
export interface LlmCallOptions {
  /** Si falta, el adaptador usa `MAX_OUTPUT_TOKENS`. */
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * FR-D01: exactamente tres operaciones. `complete` y `completeWithImages` no
 * ejecutan herramientas — devuelven las llamadas y el bucle queda para la
 * rebanada 2 (`design.md` D2, `operations-pipeline/design.md:274`).
 *
 * Se agrega un tercer parámetro OPCIONAL `options` en ambas: la lista de tipos
 * de la tarea 3.1 incluye `LlmCallOptions`, así que el contrato tiene que
 * aceptarlo en algún lado. Es opcional, de modo que una llamada de dos
 * argumentos sigue compilando.
 */
export interface LlmProvider {
  complete(
    messages: readonly LlmMessage[],
    tools: readonly ToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmCompletion>;

  completeWithImages(
    messages: readonly LlmMessage[],
    images: readonly LlmImage[],
    tools: readonly ToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmCompletion>;

  /** FR-D03: declaración estática, nunca asumida por el llamador. */
  describeCapabilities(): AiCapabilities;
}

import type { AiCapabilities } from '@umlive/contracts';
import {
  generateText,
  jsonSchema,
  tool,
  type AssistantModelMessage,
  type FilePart,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type {
  LlmCallOptions,
  LlmCompletion,
  LlmImage,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  ToolDefinition,
} from './llm-provider.interface';

/**
 * La única clase adaptadora (design D1/D2): seis entradas de catálogo, una
 * clase. Traduce el dialecto neutral de `llm-provider.interface.ts` al del AI
 * SDK v7 y devuelve la respuesta ya normalizada.
 *
 * Tres decisiones que hacen a la corrección del gasto:
 *
 * - `maxOutputTokens` explícito: la estimación de la reserva (D3) depende de
 *   este valor, así que no puede quedar en el default del modelo.
 * - `maxRetries: 0`: el SDK reintenta 2 veces por defecto (`ai/dist/index.d.ts`
 *   `:646-650`). Tres llamados cobrados con una sola reserva romperían el techo.
 * - `timeout`: un llamado colgado bloquearía el turno sin liquidar la reserva.
 *
 * Las herramientas se pasan SIN `execute`: este adaptador devuelve las
 * llamadas, nunca las ejecuta. El bucle, la validación (FR-D05) y la
 * aplicación en una transacción (FR-D24) son de la rebanada 2.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/**
 * Tope de tokens de salida del turno. La reserva del libro de gasto (D3) usa
 * este mismo valor multiplicado por el precio de salida, así que cambiarlo
 * mueve la cota superior de cada turno.
 */
export const MAX_OUTPUT_TOKENS = 4096;

/** Corte por llamado. Un cuelgue no puede dejar una reserva sin liquidar. */
export const CALL_TIMEOUT_MS = 60_000;

export class AiSdkLlmProvider implements LlmProvider {
  constructor(
    private readonly model: LanguageModel,
    private readonly capabilities: AiCapabilities,
  ) {}

  describeCapabilities(): AiCapabilities {
    return this.capabilities;
  }

  complete(
    messages: readonly LlmMessage[],
    tools: readonly ToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmCompletion> {
    return this.call(messages, [], tools, options);
  }

  completeWithImages(
    messages: readonly LlmMessage[],
    images: readonly LlmImage[],
    tools: readonly ToolDefinition[],
    options?: LlmCallOptions,
  ): Promise<LlmCompletion> {
    return this.call(messages, images, tools, options);
  }

  private async call(
    messages: readonly LlmMessage[],
    images: readonly LlmImage[],
    tools: readonly ToolDefinition[],
    options: LlmCallOptions | undefined,
  ): Promise<LlmCompletion> {
    const instructions: SystemModelMessage[] = [];
    const modelMessages: ModelMessage[] = [];

    for (const message of messages) {
      switch (message.role) {
        case 'system':
          instructions.push({ role: 'system', content: message.content });
          break;
        case 'user':
          modelMessages.push({ role: 'user', content: message.content });
          break;
        case 'assistant':
          modelMessages.push(toAssistantMessage(message));
          break;
        case 'tool':
          modelMessages.push(toToolMessage(message));
          break;
      }
    }

    // Las imágenes viajan como `FilePart` (design D2; `ImagePart` está
    // deprecado) y se adjuntan al último mensaje de usuario.
    if (images.length > 0) {
      const parts: FilePart[] = images.map((image) => ({
        type: 'file',
        mediaType: image.mediaType,
        data: image.data,
      }));
      let index = -1;
      for (let i = modelMessages.length - 1; i >= 0; i -= 1) {
        if (modelMessages[i]?.role === 'user') {
          index = i;
          break;
        }
      }
      const text =
        index >= 0 && typeof modelMessages[index]?.content === 'string'
          ? (modelMessages[index]!.content as string)
          : '';
      const userMessage: ModelMessage = {
        role: 'user',
        content: [{ type: 'text', text }, ...parts],
      };
      if (index >= 0) modelMessages.splice(index, 1, userMessage);
      else modelMessages.push(userMessage);
    }

    const result = await generateText({
      model: this.model,
      // `system` está deprecado (`ai/dist/index.d.ts:686-690`): las
      // instrucciones van por `instructions`.
      instructions: instructions.length > 0 ? instructions : undefined,
      messages: modelMessages,
      tools: toToolSet(tools),
      maxOutputTokens: options?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      timeout: CALL_TIMEOUT_MS,
      abortSignal: options?.abortSignal,
    });

    return {
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        // Lectura del eco opaco (D8): el SDK lo expone en `providerMetadata`.
        // Se copia TAL CUAL, sin mirarlo; `undefined` significa "este proveedor
        // no exige eco" y la propiedad no viaja.
        ...(call.providerMetadata === undefined ? {} : { opaque: call.providerMetadata }),
      })),
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      finishReason: result.finishReason,
    };
  }
}

type LlmAssistantMessage = Extract<LlmMessage, { role: 'assistant' }>;
type LlmToolMessage = Extract<LlmMessage, { role: 'tool' }>;

/**
 * El mensaje del asistente: su texto más sus llamadas, cada una con el eco
 * `opaque` reenviado. Un mensaje sin texto y sin llamadas no existe, así que el
 * caso vacío se normaliza a una parte de texto vacía en vez de un arreglo de
 * contenido vacío (que el SDK rechaza).
 */
function toAssistantMessage(message: LlmAssistantMessage): AssistantModelMessage {
  const parts: (TextPart | ToolCallPart)[] = [];
  if (message.text.length > 0) parts.push({ type: 'text', text: message.text });
  for (const call of message.toolCalls) parts.push(toToolCallPart(call));
  return {
    role: 'assistant',
    content: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
  };
}

/**
 * El eco opaco se escribe en la parte de la llamada. El SDK lo devuelve como
 * `providerMetadata` en la respuesta y lo reenvía al proveedor desde
 * `providerOptions` de la parte: es el mismo objeto, sin interpretarlo, que es
 * exactamente lo que D8 pide.
 */
function toToolCallPart(call: LlmToolCall): ToolCallPart {
  const part: ToolCallPart = {
    type: 'tool-call',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  };
  if (call.opaque !== undefined) {
    return { ...part, providerOptions: call.opaque as NonNullable<ToolCallPart['providerOptions']> };
  }
  return part;
}

/**
 * El resultado de una herramienta tal como lo ve el modelo: el texto ya
 * serializado que el servidor decidió devolver (incluido el error de
 * validación, FR-D05/SC-D03).
 */
function toToolMessage(message: LlmToolMessage): ToolModelMessage {
  const part: ToolResultPart = {
    type: 'tool-result',
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    output: { type: 'text', value: message.content },
  };
  return { role: 'tool', content: [part] };
}

/**
 * Traduce `ToolDefinition` a `ToolSet` del SDK, SIN `execute`.
 *
 * Declaración pura: la herramienta se le ofrece al modelo para que la llame,
 * pero nada la corre acá.
 */
function toToolSet(tools: readonly ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as Parameters<typeof jsonSchema>[0]),
    });
  }
  return set;
}

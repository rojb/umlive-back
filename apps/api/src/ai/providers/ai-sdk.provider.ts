import type { AiCapabilities } from '@umlive/contracts';
import {
  generateText,
  jsonSchema,
  tool,
  type FilePart,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai';
import type {
  LlmCallOptions,
  LlmCompletion,
  LlmImage,
  LlmMessage,
  LlmProvider,
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
      if (message.role === 'system') {
        instructions.push({ role: 'system', content: message.content });
        continue;
      }
      modelMessages.push({ role: message.role, content: message.content });
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
      })),
      usage: {
        inputTokens: result.usage.inputTokens ?? null,
        outputTokens: result.usage.outputTokens ?? null,
      },
      finishReason: result.finishReason,
    };
  }
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

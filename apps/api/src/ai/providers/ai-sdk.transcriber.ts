import {
  APICallError,
  NoTranscriptGeneratedError,
  transcribe,
  type TranscriptionModel,
} from 'ai';
import type { AiTranscriptionLanguage } from '@umlive/contracts';

/**
 * El único punto del backend que importa `transcribe` del AI SDK v7 (D1).
 *
 * ── Por qué una clase y no una función suelta ──────────────────────────────
 *
 * El modelo se construye UNA vez, al arrancar (`llm-provider.factory.ts`), y se
 * reutiliza en cada pedido. La clase es dueña de esa instancia y de la
 * traducción del idioma al dialecto del proveedor (`providerOptions`), que vive
 * en el catálogo. Nada de esto sale de `providers/`: el servicio solo ve
 * `TranscriptionOutcome`.
 *
 * ── Las tres decisiones que hacen a la corrección del gasto ────────────────
 *
 * 1. **`transcribe` y no `experimental_transcribe`** (`ai/dist/index.d.ts:9593`):
 *    el segundo es solo un alias del primero, y el estable es el que se fija.
 * 2. **`maxRetries: 0`** (`:9439-9444`): el default del SDK son 2 reintentos, y
 *    tres llamados cobrados con una sola reserva romperían el techo.
 * 3. **`abortSignal`**: el llamador corta por cancelación del cliente o por el
 *    plazo de 30 s. Un `abort` NO es un fallo del proveedor y la reserva queda
 *    igual, pero el estado de la fila es `CANCELLED` y no `FAILED`.
 *
 * ── La clasificación de errores va acá adentro ─────────────────────────────
 *
 * `NoTranscriptGeneratedError` y `APICallError` son tipos del SDK y no cruzan
 * el límite de `providers/`: se traducen a `TranscriptionOutcome` para que el
 * servicio mapee `empty` a `422` y `failed` a `502` sin conocer el vendor.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/**
 * Las opciones de proveedor que acepta `transcribe`, derivadas del propio SDK.
 *
 * `ai` no re-exporta `ProviderOptions` (lo importa de `@ai-sdk/provider-utils`
 * y no lo publica), así que el tipo se toma de la firma de `transcribe` en vez
 * de importar un paquete transitivo que el `package.json` no declara.
 */
export type TranscriptionProviderOptions = NonNullable<
  Parameters<typeof transcribe>[0]['providerOptions']
>;

/** Traduce el idioma elegido al dialecto del proveedor; se define en el catálogo. */
export type ProviderOptionsFor = (lang: AiTranscriptionLanguage) => TranscriptionProviderOptions;

/**
 * Lo que devuelve un intento de transcripción.
 *
 * `durationSeconds` es `number | null`: el SDK expone `durationInSeconds`
 * como `number | undefined`, y `undefined` significa "el proveedor no lo
 * informó". Esa diferencia es la que decide la liquidación (D4): con duración
 * se ajusta el costo, sin ella la reserva queda tal cual (fail-closed).
 */
export type TranscriptionOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      readonly durationSeconds: number | null;
    }
  | {
      readonly ok: false;
      /** `empty`: sin texto reconocible. `failed`: el proveedor falló. `aborted`: se canceló. */
      readonly kind: 'empty' | 'failed' | 'aborted';
      readonly message: string;
    };

export class AiSdkTranscriber {
  constructor(
    private readonly model: TranscriptionModel,
    private readonly providerOptionsFor: ProviderOptionsFor,
  ) {}

  /**
   * Transcribe el audio EN MEMORIA. `audio` es un `Uint8Array` —nunca una ruta
   * ni una URL—, así que este camino no puede tocar el disco: el archivo existe
   * solo en el buffer de multer y muere con el pedido.
   */
  async transcribe(
    audio: Uint8Array,
    lang: AiTranscriptionLanguage,
    abortSignal?: AbortSignal,
  ): Promise<TranscriptionOutcome> {
    try {
      const result = await transcribe({
        model: this.model,
        audio,
        providerOptions: this.providerOptionsFor(lang),
        maxRetries: 0,
        abortSignal,
      });
      return { ok: true, text: result.text, durationSeconds: result.durationInSeconds ?? null };
    } catch (error) {
      // La cancelación (del cliente o del plazo) NO es un fallo del proveedor:
      // se clasifica primero y por la señal, no por la forma del error.
      if (abortSignal?.aborted === true) {
        return { ok: false, kind: 'aborted', message: describeError(error) };
      }
      if (NoTranscriptGeneratedError.isInstance(error)) {
        return { ok: false, kind: 'empty', message: 'el proveedor no devolvió ningún texto' };
      }
      if (APICallError.isInstance(error)) {
        return { ok: false, kind: 'failed', message: describeError(error) };
      }
      return { ok: false, kind: 'failed', message: describeError(error) };
    }
  }
}

/** Error legible para la fila y el log: nunca se guarda un objeto crudo. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

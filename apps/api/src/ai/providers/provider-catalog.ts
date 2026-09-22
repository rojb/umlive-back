import { Logger } from '@nestjs/common';
import type {
  AiAudioMediaType,
  AiCapabilities,
  AiModelPrice,
  AiModelView,
  AiProviderId,
  AiProviderUnavailableReason,
  AiTranscriptionLanguage,
} from '@umlive/contracts';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogle } from '@ai-sdk/google';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, TranscriptionModel } from 'ai';
import type { ChatProviderOptions } from './ai-sdk.provider';
import type { TranscriptionProviderOptions } from './ai-sdk.transcriber';

/**
 * El catálogo ES la tabla de precios (design D1).
 *
 * `price` es obligatorio en cada `CatalogModel`: un modelo sin precio no
 * compila, y por lo tanto no existe. Eso hace cumplir la tarea 3.8 —
 * "un modelo sin precio verificado no se agrega al catálogo ni es
 * seleccionable"— por construcción, no por disciplina.
 *
 * Cada `CatalogProvider` es una entrada de catálogo, no una clase: `buildModel`
 * delega en la fábrica del vendor del AI SDK v7. "Un adaptador por vendor"
 * (`PRD.md:683`) se cumple acá por entrada; la clase adaptadora es una sola
 * (`AiSdkLlmProvider`, design D1/D2).
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "`LlmProvider` es el
 * único contrato". Diseño: `design.md` D1. Capacidades: matriz de `PRD.md`
 * Apéndice D ("LLM Provider Capability Matrix", verificada 2026-09-12).
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Credenciales y endpoint con los que se construye un modelo del SDK. */
export type ProviderSettings = {
  readonly apiKey?: string;
  readonly baseURL?: string;
};

export type CatalogModel = {
  readonly id: string;
  readonly label: string;
  readonly capabilities: AiCapabilities;
  readonly price: AiModelPrice;
};

/**
 * Un modelo de transcripción del catálogo (D1).
 *
 * `pricePerMinuteUsd: null` NO es "gratis": es un precio NO verificado, y por
 * la regla de esta rebanada un modelo sin precio verificado no es seleccionable.
 * `acceptedMediaTypes` solo lleva los formatos DOCUMENTADOS del modelo.
 */
export type CatalogTranscriptionModel = {
  readonly id: string;
  readonly pricePerMinuteUsd: string | null;
  readonly acceptedMediaTypes: readonly AiAudioMediaType[];
};

/**
 * La capacidad de transcripción de un proveedor (D1). Es un bloque OPcional:
 * solo `gemini` y `openai` lo declaran.
 *
 * La diferencia entre vendors vive acá y no en un `if` del servicio: `model()`
 * construye el modelo del AI SDK v7 y `providerOptions()` traduce el idioma al
 * dialecto del proveedor. Ningún tipo del SDK sale de `providers/`.
 */
export type CatalogTranscription = {
  readonly models: readonly CatalogTranscriptionModel[];
  model(settings: ProviderSettings, modelId: string): TranscriptionModel;
  providerOptions(lang: AiTranscriptionLanguage): TranscriptionProviderOptions;
};

export type CatalogProvider = {
  readonly id: AiProviderId;
  readonly label: string;
  /** Variable de entorno de la clave. `null` para `openai-compatible`. */
  readonly envKey: string | null;
  /**
   * Motivo ESTÁTICO por el que el proveedor nunca es seleccionable, sin
   * importar el entorno. Hoy sólo `moonshot` (sin precio verificado).
   */
  readonly unavailableReason: AiProviderUnavailableReason | null;
  readonly models: readonly CatalogModel[];
  /** Capacidad hermana de transcripción de voz (FR-D20, D1). Opcional. */
  readonly transcription?: CatalogTranscription;
  buildModel(settings: ProviderSettings, modelId: string): LanguageModel;
  /**
   * Opciones específicas del proveedor para los llamados de CHAT, tal como el
   * AI SDK las espera en `providerOptions` (`{ <proveedor>: { … } }`).
   *
   * Viven acá y no en el adaptador porque el adaptador es agnóstico a propósito
   * (traduce un dialecto neutral y nada más): solo las reenvía sin mirarlas,
   * igual que ya hace `providerOptions(lang)` con la transcripción.
   */
  readonly chatProviderOptions?: ChatProviderOptions;
};

/**
 * Las capacidades de visión de los modelos ESTÁTICOS llevan
 * `maxImageBytes`/`maxImageDimension` en `null`: los fija `ai-image-input`
 * (design D1). Hasta entonces `null` significa "límite no fijado", y los
 * llamadores deben tratarlo como "sin visión" (contrato `AiCapabilities`,
 * `packages/contracts/src/ai.ts`).
 *
 * `openai-compatible` es el único que no pasa por acá: su modelo es dinámico y
 * su visión se declara desde el entorno (D9.1, `toModelView`). Los demás siguen
 * con los límites sin fijar porque su tabla vive en `llm-provider.factory.ts`.
 */
const VISION_LIMITS_UNSET = { maxImageBytes: null, maxImageDimension: null } as const;

// ── Fuentes de precio, con fecha ────────────────────────────────────────────
// Ningún número de este archivo es inventado: sale de una de estas fuentes.

/** Gemini 3.8 Flash y GPT-5.6 Luna: PRD Apéndice D.2, verificado 2026-09-12. */
const REPO_PRICE_SOURCE = 'PRD.md Apéndice D.2 (precios verificados 2026-09-12)';
const REPO_PRICE_VERIFIED_AT = '2026-09-12';

/** Anthropic: página oficial de precios, verificada 2026-09-18 por el coordinador. */
const ANTHROPIC_PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const ANTHROPIC_PRICE_VERIFIED_AT = '2026-09-18';

/** DeepSeek: documentación oficial de precios. */
const DEEPSEEK_PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEEPSEEK_PRICE_VERIFIED_AT = '2026-09-18';

/**
 * ── Constantes de la transcripción de voz (D1/D3) ──────────────────────────
 *
 * `WORST_CASE_AUDIO_BPS` es el piso de bitrate de Opus documentado y la base de
 * la reserva por bytes: se asume el PEOR bitrate para que la reserva no quede
 * corta aunque el cliente esté adulterado. `AUDIO_MAX_BYTES` es el tope de la
 * subida (PO-A baja los 2 MB de la propuesta a 1 MiB) y `MAX_AUDIO_SECONDS` el
 * corte de la captura del cliente.
 */
export const WORST_CASE_AUDIO_BPS = 6000;
export const AUDIO_MAX_BYTES = 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;

export const PROVIDER_CATALOG: readonly CatalogProvider[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    unavailableReason: null,
    models: [
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        capabilities: {
          text: true,
          vision: true,
          toolCalling: true,
          structuredOutput: true,
          ...VISION_LIMITS_UNSET,
        },
        // PRD Apéndice D.2: la tarifa rige hasta 2026-12-31 y después se duplica.
        price: {
          inputPerMtokUsd: '0.75',
          outputPerMtokUsd: '3.75',
          source: REPO_PRICE_SOURCE,
          verifiedAt: REPO_PRICE_VERIFIED_AT,
        },
      },
    ],
    buildModel: (settings, modelId) =>
      createGoogle({ apiKey: settings.apiKey, baseURL: settings.baseURL })(modelId),
    //
    // ── Transcripción (D1, V0) ───────────────────────────────────────────
    //
    // `gemini-3.5-transcribe` con el precio BLENDED documentado:
    // `https://ai.google.dev/gemini-api/docs/pricing` — entrada $2.00/1M o
    // $0.003/min de audio, salida $12.00/1M o $0.002/min de texto, y el precio
    // efectivo combinado ≈$0.005/min. Se toma la SUMA de los dos por-minuto
    // ($0.003 + $0.002 = $0.005), que es la opción conservadora y coincide con
    // el blended: una reserva que sobreestima nunca deja el libro corto.
    //
    // Formatos: Gemini documenta OGG Vorbis entre sus audios y NO documenta
    // WebM. Solo entra `audio/ogg`; el resto queda sin fuente y por lo tanto
    // fuera. La verificación empírica por formato (V0) NO pudo correr: no hay
    // clave configurada y `apps/api/.env*` está fuera de alcance.
    transcription: {
      models: [
        {
          id: 'gemini-3.5-transcribe',
          pricePerMinuteUsd: '0.005',
          acceptedMediaTypes: ['audio/ogg'],
        },
      ],
      model: (settings, modelId) =>
        createGoogle({ apiKey: settings.apiKey, baseURL: settings.baseURL }).transcription(modelId),
      // `languageCodes` (plural) es la opción de Google; se manda el idioma
      // elegido tal cual. Que la API lo acepte en `gemini-3.5-transcribe` (y no
      // solo en la Live API) es exactamente lo que V0 no pudo verificar: queda
      // anotado como incógnita, y el diseño eligió mandarlo igual.
      providerOptions: (lang) => ({ google: { languageCodes: [lang] } }),
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    unavailableReason: null,
    models: [
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        capabilities: {
          text: true,
          vision: true,
          toolCalling: true,
          structuredOutput: true,
          ...VISION_LIMITS_UNSET,
        },
        // PRD Apéndice D.2: el tier más barato de OpenAI de la generación actual.
        price: {
          inputPerMtokUsd: '0.20',
          outputPerMtokUsd: '1.20',
          source: REPO_PRICE_SOURCE,
          verifiedAt: REPO_PRICE_VERIFIED_AT,
        },
      },
    ],
    buildModel: (settings, modelId) =>
      createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseURL })(modelId),
    //
    // ── Transcripción (D1, V0) ───────────────────────────────────────────
    //
    // `gpt-transcribe` es el modelo recomendado
    // (`https://platform.openai.com/docs/guides/speech-to-text`), con archivos
    // de hasta 25 MB y formatos aceptados mp3, mp4, mpeg, mpga, m4a, wav y
    // webm — WebM SÍ, ogg NO. De la lista de esta rebanada (webm/ogg/mp4)
    // quedan `audio/webm` y `audio/mp4`.
    //
    // Precio por minuto: NULO a propósito. La página oficial no publica una
    // tarifa por minuto de transcripción y `PRD.md` Apéndice D.2 tampoco trae
    // una fila de STT. Rige la misma regla del catálogo: un precio sin fuente
    // es un precio inventado, así que la entrada queda NO seleccionable con
    // `price_unverified` en vez de adivinar un número.
    transcription: {
      models: [
        {
          id: 'gpt-transcribe',
          pricePerMinuteUsd: null,
          acceptedMediaTypes: ['audio/webm', 'audio/mp4'],
        },
      ],
      model: (settings, modelId) =>
        createOpenAI({ apiKey: settings.apiKey, baseURL: settings.baseURL }).transcription(modelId),
      // `@ai-sdk/openai@7.0.99` solo serializa `language` (singular) y lo fija
      // en `'es'`: OpenAI documenta `languages` (plural) y no acepta `es-ES`.
      // El catálogo resuelve la diferencia acá, no en el servicio, y manda el
      // código base documentado sin importar la variante regional elegida.
      providerOptions: () => ({ openai: { language: 'es' } }),
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    envKey: 'ANTHROPIC_API_KEY',
    unavailableReason: null,
    models: [
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        capabilities: {
          text: true,
          vision: true,
          toolCalling: true,
          structuredOutput: true,
          ...VISION_LIMITS_UNSET,
        },
        price: {
          inputPerMtokUsd: '2',
          outputPerMtokUsd: '10',
          source: ANTHROPIC_PRICE_SOURCE,
          verifiedAt: ANTHROPIC_PRICE_VERIFIED_AT,
        },
      },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        capabilities: {
          text: true,
          vision: true,
          toolCalling: true,
          structuredOutput: true,
          ...VISION_LIMITS_UNSET,
        },
        price: {
          inputPerMtokUsd: '1',
          outputPerMtokUsd: '5',
          source: ANTHROPIC_PRICE_SOURCE,
          verifiedAt: ANTHROPIC_PRICE_VERIFIED_AT,
        },
      },
    ],
    buildModel: (settings, modelId) =>
      createAnthropic({ apiKey: settings.apiKey, baseURL: settings.baseURL })(modelId),
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    unavailableReason: null,
    models: [
      {
        id: 'deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        // Visión NATIVA desde DeepSeek V4.1 Flash (2026-09-10): se llama con
        // `deepseek-flash` y no con el endpoint experimental
        // `deepseek-v4-flash-vision-exp`, que quedó superado. Acepta JPEG, PNG,
        // GIF y WebP, hasta 8192 px por lado y 32 MiB, y reescala a ~1300x1300
        // (no a los 800x800 del experimental). Verificado 2026-09-19 en
        // https://api-docs.deepseek.com/guides/vision/ y contra el proveedor
        // instalado, @ai-sdk/deepseek 3.0.44, que soporta esos cuatro formatos.
        // Los límites siguen en null como en todo el catálogo estático: los fija
        // `ai-image-input` (D1), no este cambio.
        capabilities: {
          text: true,
          vision: true,
          toolCalling: true,
          structuredOutput: true,
          ...VISION_LIMITS_UNSET,
        },
        // DeepSeek cobra por franja: hora pico / hora valle. Se elige la
        // tarifa de PICO ($0.30/$1.20 cache-miss) a propósito: la reserva es
        // una cota superior y un techo que subestima es peor que uno que
        // sobreestima (nota fechada 2026-09-18 en tasks.md, tarea 3.2).
        price: {
          inputPerMtokUsd: '0.30',
          outputPerMtokUsd: '1.20',
          source: DEEPSEEK_PRICE_SOURCE,
          verifiedAt: DEEPSEEK_PRICE_VERIFIED_AT,
        },
      },
    ],
    buildModel: (settings, modelId) =>
      createDeepSeek({ apiKey: settings.apiKey, baseURL: settings.baseURL })(modelId),
    /**
     * Modo de razonamiento APAGADO.
     *
     * `@ai-sdk/deepseek` lo documenta así: «Controls whether thinking mode is
     * enabled. **Defaults to `enabled`**». Nadie lo había apagado, y en el
     * turno de imagen eso rompía el turno entero: el modelo producía 15.563
     * caracteres de razonamiento, agotaba el presupuesto de salida completo y
     * cerraba con `finishReason=length`, texto vacío y CERO llamadas a
     * herramienta. La vista previa llegaba con «Ítems · 0» ya cobrada. Medido:
     * pasó igual con el tope en 4096 y en 8192, así que no era falta de
     * presupuesto sino que razonaba hasta agotarlo.
     *
     * Acá el modelo no tiene que deliberar: tiene que EMITIR LLAMADAS A
     * HERRAMIENTA. El razonamiento se factura como salida y no vuelve en
     * `text`, así que en este uso es presupuesto que se paga y se tira.
     *
     * `reasoningEffort: 'low'` era la otra opción; se descartó porque sigue
     * gastando salida sin techo conocido, y el problema acá no es cuánto
     * razona sino que razone en vez de llamar.
     */
    chatProviderOptions: { deepseek: { thinking: { type: 'disabled' } } },
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    envKey: 'MOONSHOT_API_KEY',
    // Tarea 3.8: tres páginas oficiales devolvieron links sin cifras. Sin
    // precio verificado, `kimi-k2.6` NO entra al catálogo (models vacío) y el
    // proveedor queda no seleccionable con este motivo. Nunca se adivina.
    unavailableReason: 'price_unverified',
    models: [],
    buildModel: (settings, modelId) =>
      createMoonshotAI({ apiKey: settings.apiKey, baseURL: settings.baseURL })(modelId),
  },
  {
    id: 'openai-compatible',
    label: 'Endpoint OpenAI-compatible',
    // La clave es OPCIONAL (design D5): el endpoint puede no exigirla.
    envKey: null,
    unavailableReason: null,
    // Modelos dinámicos: salen de `AI_OPENAI_COMPATIBLE_*` en la fábrica. El
    // precio también, así que no hay ninguna cifra estática que inventar.
    models: [],
    buildModel: (settings, modelId) =>
      createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: settings.baseURL ?? '',
        apiKey: settings.apiKey,
      })(modelId),
  },
];

/** Vista `AiModelView` de un modelo del catálogo, para la fábrica y el panel. */
export function toModelView(provider: AiProviderId, model: CatalogModel): AiModelView {
  return {
    provider,
    model: model.id,
    label: model.label,
    capabilities: capabilitiesOf(provider, model),
    price: model.price,
  };
}

/**
 * ── D9.1: la visión de `openai-compatible` se declara ACÁ ────────────────────
 *
 * El proveedor `openai-compatible` no tiene modelos estáticos: su modelo se
 * construye en `llm-provider.factory.ts` a partir de `AI_OPENAI_COMPATIBLE_*`.
 * Esta función es la proyección por la que pasa TODO consumidor del catálogo
 * (el panel y `AiConfigView` desde la fábrica, y la cadena de reserva desde
 * `AiCallService`), así que es el único punto donde la declaración puede vivir y
 * valer para los tres a la vez.
 *
 * Regla: las DOS variables tienen que ser enteros positivos para que el eslabón
 * declare visión. Falta una, o cualquiera de las dos viene mal formada, y el
 * eslabón queda como hasta ahora: **sin visión**. Un `Logger.error` deja el
 * rastro de la variable mal cargada. Media configuración NO puede convertirse
 * ni en un límite de cero (rechazaría todo) ni en un límite sin tope (aceptaría
 * cualquier cosa): se trata como ausente, que es la dirección segura.
 *
 * Nota [2026-09-18]: el objeto de capacidades del adaptador de
 * `openai-compatible` se arma en `llm-provider.factory.ts`, fuera de las
 * superficies de esta corrida; por eso la declaración se aplica en la vista y
 * no en ese archivo. `LlmProvider.describeCapabilities()` del adaptador sigue
 * diciendo `vision: false` y nadie lo consulta para decidir visión.
 */
const log = new Logger('ProviderCatalog');

/** Variable que declara el tope de bytes por imagen de `openai-compatible`. */
export const COMPATIBLE_MAX_IMAGE_BYTES_ENV = 'AI_OPENAI_COMPATIBLE_MAX_IMAGE_BYTES';

/** Variable que declara el tope de dimensión (el lado más largo) de `openai-compatible`. */
export const COMPATIBLE_MAX_IMAGE_DIMENSION_ENV = 'AI_OPENAI_COMPATIBLE_MAX_IMAGE_DIMENSION';

type VisionDeclaration = Pick<AiCapabilities, 'vision' | 'maxImageBytes' | 'maxImageDimension'>;

/** Sin visión: es lo que devuelve cualquier configuración incompleta o mal formada. */
const NO_VISION: VisionDeclaration = { vision: false, maxImageBytes: null, maxImageDimension: null };

/**
 * Los límites de imagen declarados por el entorno para `openai-compatible`.
 *
 * El entorno entra por PARÁMETRO (con `process.env` por defecto) para que la
 * regla sea verificable sin tocar el proceso: es la misma razón por la que la
 * fábrica lee con `ConfigService` en vez de con `process.env` directo.
 */
export function openAiCompatibleVision(
  env: NodeJS.ProcessEnv = process.env,
): VisionDeclaration {
  const maxImageBytes = positiveInteger(env[COMPATIBLE_MAX_IMAGE_BYTES_ENV], COMPATIBLE_MAX_IMAGE_BYTES_ENV);
  const maxImageDimension = positiveInteger(env[COMPATIBLE_MAX_IMAGE_DIMENSION_ENV], COMPATIBLE_MAX_IMAGE_DIMENSION_ENV);

  if (maxImageBytes === null || maxImageDimension === null) return NO_VISION;
  return { vision: true, maxImageBytes, maxImageDimension };
}

/**
 * Entero positivo, o `null` si la variable está ausente o mal formada.
 *
 * Ausente no es un error (es el estado normal de un entorno sin el falso de
 * `ai-image-input`); mal formada SÍ, y se reporta con `Logger.error`. Un
 * `parseInt` suelto aceptaría `1024px` como 1024, así que la forma se valida
 * antes de convertir.
 */
function positiveInteger(raw: string | undefined, key: string): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    log.error(`${key} inválida: "${raw}"; se trata como ausente y el eslabón queda sin visión`);
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log.error(`${key} inválida: "${raw}"; se trata como ausente y el eslabón queda sin visión`);
    return null;
  }
  return parsed;
}

/** Las capacidades del modelo: para `openai-compatible`, las de la vista con su visión declarada. */
function capabilitiesOf(provider: AiProviderId, model: CatalogModel): AiCapabilities {
  if (provider !== 'openai-compatible') return model.capabilities;
  return { ...model.capabilities, ...openAiCompatibleVision() };
}

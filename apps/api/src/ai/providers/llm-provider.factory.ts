import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AiModelRef,
  AiModelView,
  AiProviderId,
  AiProviderView,
  AiTranscriptionUnavailableReason,
  AiTranscriptionView,
} from '@umlive/contracts';
import { AiSdkLlmProvider } from './ai-sdk.provider';
import { AiSdkTranscriber } from './ai-sdk.transcriber';
import type { LlmProvider } from './llm-provider.interface';
import {
  AUDIO_MAX_BYTES,
  MAX_AUDIO_SECONDS,
  PROVIDER_CATALOG,
  toModelView,
  type CatalogModel,
  type CatalogProvider,
  type ProviderSettings,
} from './provider-catalog';

/**
 * La configuración del entorno se lee UNA vez al arrancar y se resuelve acá
 * (design D5): un custom provider de NestJS (`useFactory` + `ConfigService`),
 * el idioma que nombra `PRD.md:689`.
 *
 * Regla dura: se lee con `ConfigService.get`, NUNCA con `getOrThrow`. Un
 * proveedor sin su variable de clave debe quedar `available: false` con
 * motivo, no tumbar el arranque. Un valor mal formado se reporta con
 * `Logger.error` y se trata como ausente — jamás revienta.
 *
 * El catálogo es la fuente de los modelos y sus precios (`provider-catalog.ts`);
 * acá solo se calcula disponibilidad y se construyen adaptadores.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Proveedor sin clave
 * queda no disponible sin tumbar el arranque"; y "Resolución de proveedor y
 * modelo". Diseño: `design.md` D5.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Token del custom provider. Lo consumen los servicios de las fases 4/5. */
export const AI_ENV = 'AI_ENV';

/**
 * Credencial con la que se construye un adaptador. Es un parámetro EXPLÍCITO
 * del llamado, nunca una mutación de `process.env` (FR-D11, tarea 7.10).
 *
 * - `environment`: la clave del entorno, leída una vez al arrancar (D5). Es la
 *   que sirve a un proyecto sin clave propia.
 * - `project`: la clave BYO del proyecto, ya descifrada por `AiConfigService`.
 *   Viaja a los settings de la fábrica del vendor (`create({ apiKey })`), así
 *   el SDK no llega a leer `ANTHROPIC_API_KEY` —ni ninguna otra— por su cuenta
 *   (`@ai-sdk/anthropic/dist/index.js`: `loadApiKey` cae a `process.env` si no
 *   recibe `apiKey`).
 * - `unreadable`: el proyecto TIENE clave propia y no se pudo descifrar. Es
 *   una parada dura: `createProvider` devuelve `null` acá adentro, de modo que
 *   no exista ningún camino que gaste la clave del entorno en un proyecto
 *   cuya clave está rota.
 */
export type ProviderCredential =
  | { readonly kind: 'environment' }
  | { readonly kind: 'project'; readonly apiKey: string }
  | { readonly kind: 'unreadable' };

/** La credencial de un proyecto sin clave propia, y de todo proveedor que no sea el del proyecto. */
export const ENVIRONMENT_CREDENTIAL: ProviderCredential = { kind: 'environment' };

/** El entorno de IA ya resuelto: vistas, defaults y construcción de adaptadores. */
export type AiEnvironment = {
  /** Una vista por entrada de catálogo, para el panel y para la cadena. */
  readonly providers: readonly AiProviderView[];
  readonly primary: AiModelRef;
  readonly fallbackChain: readonly AiModelRef[];
  /**
   * La capacidad hermana de transcripción de voz (FR-D20, D1): su vista para
   * el panel, su precio por minuto y el transcriptor ya construido.
   */
  readonly transcription: AiTranscriptionEnvironment;
  /**
   * Construye el adaptador de un modelo del catálogo. La credencial es
   * OBLIGATORIA: quien llama tiene que declarar de dónde sale la clave —la del
   * entorno o la del proyecto— y `unreadable` no construye nada.
   *
   * Devuelve `null` si el proveedor no está disponible (sin clave de entorno,
   * sin precio verificado), si el modelo no está en el catálogo, si la
   * configuración del endpoint falta, o si la credencial es `unreadable`.
   */
  createProvider(ref: AiModelRef, credential: ProviderCredential): LlmProvider | null;
};

/**
 * La transcripción de servidor resuelta al arrancar (D1).
 *
 * `view` es lo que ve el cliente; `pricePerMinuteUsd` y `transcriber` son
 * SERVIDOR: el precio calcula la reserva por bytes y el transcriptor es la
 * única instancia construida. Cuando la capacidad no está disponible, los tres
 * van en `null`/vacío y `view.reason` dice por qué.
 */
export type AiTranscriptionEnvironment = {
  readonly view: AiTranscriptionView;
  readonly pricePerMinuteUsd: string | null;
  readonly transcriber: AiSdkTranscriber | null;
  /** Límite de ritmo propio de la transcripción, distinto del de turnos (D4). */
  readonly transcriptionsPerHour: number;
};

const DEFAULT_PROVIDER: AiProviderId = 'gemini';
const DEFAULT_MODEL = 'gemini-3.8-flash';

/** Proveedor de transcripción por defecto si `AI_STT_PROVIDER` no está puesto (D1). */
const DEFAULT_STT_PROVIDER: AiProviderId = 'gemini';

/** Default de `AI_RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR` (D4, tarea 1.3). */
const DEFAULT_TRANSCRIPTIONS_PER_HOUR = 20;

const log = new Logger('AiProviderFactory');

/** `get` + normalización. `''` y `'   '` cuentan como ausente. */
function readSetting(config: ConfigService, key: string): string | undefined {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isProviderId(value: string): value is AiProviderId {
  return PROVIDER_CATALOG.some((entry) => entry.id === value);
}

/**
 * `openai-compatible` no tiene modelos estáticos: su modelo y sus precios
 * salen de variables de entorno. Por eso su precio es verificable como
 * "configuración del operador", y no contra una página pública.
 */
function compatibleModel(config: ConfigService): CatalogModel | null {
  const baseURL = readSetting(config, 'AI_OPENAI_COMPATIBLE_BASE_URL');
  const model = readSetting(config, 'AI_OPENAI_COMPATIBLE_MODEL');
  const input = readSetting(config, 'AI_OPENAI_COMPATIBLE_PRICE_INPUT_PER_MTOK_USD');
  const output = readSetting(config, 'AI_OPENAI_COMPATIBLE_PRICE_OUTPUT_PER_MTOK_USD');

  if (baseURL === undefined || model === undefined || input === undefined || output === undefined) {
    if (
      baseURL !== undefined ||
      model !== undefined ||
      input !== undefined ||
      output !== undefined
    ) {
      log.error(
        'openai-compatible: configuración incompleta (faltan base URL, modelo o precios); ' +
          'el proveedor queda no disponible',
      );
    }
    return null;
  }

  return {
    id: model,
    label: model,
    // design D1: `openai-compatible` declara solo `text` y `toolCalling`.
    capabilities: {
      text: true,
      vision: false,
      toolCalling: true,
      structuredOutput: false,
      maxImageBytes: null,
      maxImageDimension: null,
    },
    price: {
      inputPerMtokUsd: input,
      outputPerMtokUsd: output,
      source: 'AI_OPENAI_COMPATIBLE_PRICE_* (configuración del entorno)',
      // No hay página pública que verificar: la "fuente" es el operador.
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
  };
}

function modelsOf(entry: CatalogProvider, config: ConfigService): readonly CatalogModel[] {
  if (entry.id === 'openai-compatible') {
    const model = compatibleModel(config);
    return model === null ? [] : [model];
  }
  return entry.models;
}

/** FR-D07: disponibilidad por variable de clave presente, nunca por crash. */
function buildView(entry: CatalogProvider, config: ConfigService): AiProviderView {
  const models: AiModelView[] = modelsOf(entry, config).map((model) =>
    toModelView(entry.id, model),
  );
  const base = { id: entry.id, label: entry.label, models };

  if (entry.unavailableReason !== null) {
    return { ...base, available: false, unavailableReason: entry.unavailableReason };
  }

  if (models.length === 0) {
    return {
      ...base,
      available: false,
      unavailableReason: entry.id === 'openai-compatible' ? 'missing_configuration' : 'price_unverified',
    };
  }

  if (entry.envKey !== null && readSetting(config, entry.envKey) === undefined) {
    return { ...base, available: false, unavailableReason: 'missing_api_key' };
  }

  return { ...base, available: true, unavailableReason: null };
}

/** FR-D06: default de entorno. Mal formado → `Logger.error` y se usa el default. */
function resolvePrimary(config: ConfigService): AiModelRef {
  const rawProvider = readSetting(config, 'AI_DEFAULT_PROVIDER');
  const rawModel = readSetting(config, 'AI_DEFAULT_MODEL');

  let provider: AiProviderId = DEFAULT_PROVIDER;
  if (rawProvider !== undefined) {
    if (isProviderId(rawProvider)) provider = rawProvider;
    else
      log.error(
        `AI_DEFAULT_PROVIDER inválido: "${rawProvider}"; se usa ${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      );
  }

  if (rawModel !== undefined) {
    return { provider, model: rawModel };
  }

  const catalogModel = PROVIDER_CATALOG.find((entry) => entry.id === provider)?.models[0]?.id;
  if (catalogModel !== undefined) {
    return { provider, model: catalogModel };
  }

  if (provider === 'openai-compatible') {
    const envModel = readSetting(config, 'AI_OPENAI_COMPATIBLE_MODEL');
    if (envModel !== undefined) return { provider, model: envModel };
  }

  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

/** `AI_FALLBACK_CHAIN` = `provider:model,provider:model`. Ausente → cadena vacía. */
function resolveFallbackChain(config: ConfigService): readonly AiModelRef[] {
  const raw = readSetting(config, 'AI_FALLBACK_CHAIN');
  if (raw === undefined) return [];

  const chain: AiModelRef[] = [];
  for (const link of raw.split(',')) {
    const trimmed = link.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(':');
    const provider = parts[0]?.trim();
    const model = parts[1]?.trim();
    if (parts.length !== 2 || provider === undefined || model === undefined) {
      log.error(`AI_FALLBACK_CHAIN: eslabón inválido "${trimmed}"; se omite`);
      continue;
    }
    if (!isProviderId(provider)) {
      log.error(`AI_FALLBACK_CHAIN: proveedor desconocido "${provider}"; se omite`);
      continue;
    }
    chain.push({ provider, model });
  }
  return chain;
}

/** FR-D07/D5: la clave se pasa EXPLÍCITA al SDK; el SDK nunca lee `process.env` solo. */
function buildProviderFactory(
  config: ConfigService,
): (ref: AiModelRef, credential: ProviderCredential) => LlmProvider | null {
  return (ref: AiModelRef, credential: ProviderCredential): LlmProvider | null => {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === ref.provider);
    if (entry === undefined || entry.unavailableReason !== null) return null;

    const model = modelsOf(entry, config).find((candidate) => candidate.id === ref.model);
    if (model === undefined) return null;

    // Parada dura de FR-D11: si el proyecto tiene clave propia y no se pudo
    // descifrar, este proveedor queda no disponible. Se corta acá ADENTRO y no
    // en el llamador, para que ningún camino pueda construir el adaptador con
    // la clave del entorno en lugar de la clave rota del proyecto.
    if (credential.kind === 'unreadable') return null;

    const settings: { apiKey?: string; baseURL?: string } = {};

    if (entry.envKey !== null) {
      // La disponibilidad sigue siendo la del entorno (nota [7.4]): sin su
      // variable el proveedor no es seleccionable. La clave BYO cambia la
      // CREDENCIAL del llamado, no la disponibilidad.
      const envApiKey = readSetting(config, entry.envKey);
      if (envApiKey === undefined) return null;
      // La clave del proyecto se PREFIERE sobre la del entorno (FR-D11) y va
      // como parámetro explícito de `create({ apiKey })`, nunca por `process.env`.
      settings.apiKey = credential.kind === 'project' ? credential.apiKey : envApiKey;
    }

    if (entry.id === 'openai-compatible') {
      const baseURL = readSetting(config, 'AI_OPENAI_COMPATIBLE_BASE_URL');
      if (baseURL === undefined) return null;
      settings.baseURL = baseURL;
      // Misma preferencia: la clave del proyecto gana sobre `_API_KEY`, que acá
      // es opcional (design D5).
      settings.apiKey =
        credential.kind === 'project'
          ? credential.apiKey
          : readSetting(config, 'AI_OPENAI_COMPATIBLE_API_KEY');
    }

    return new AiSdkLlmProvider(entry.buildModel(settings, ref.model), model.capabilities);
  };
}

/** Se llama una sola vez, al construir el provider `AI_ENV`. */
export function createAiEnvironment(config: ConfigService): AiEnvironment {
  return {
    providers: PROVIDER_CATALOG.map((entry) => buildView(entry, config)),
    primary: resolvePrimary(config),
    fallbackChain: resolveFallbackChain(config),
    transcription: resolveTranscription(config),
    createProvider: buildProviderFactory(config),
  };
}

/**
 * La transcripción de servidor, resuelta UNA vez al arrancar (tarea 1.3, D1).
 *
 * Reglas:
 *
 * - `AI_STT_PROVIDER` elige la entrada del catálogo (default `gemini`).
 * - `AI_STT_MODEL` elige el modelo dentro de su bloque (default el primero).
 * - `AI_STT_BASE_URL` re-apunta el transcriptor a otro host — el falso de la
 *   verificación. Es una decisión que alguien debería ver, así que se deja un
 *   `Logger.warn` al arrancar.
 * - `AI_RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR` (default 20) es la única fuente del
 *   límite propio de transcripción; lo consume `AiSpendService`.
 *
 * Un proveedor o modelo sin bloque `transcription`, con precio nulo, sin
 * formatos verificados o sin clave queda NO disponible con su motivo — jamás
 * revienta el arranque, y nunca adivina un precio.
 */
function resolveTranscription(config: ConfigService): AiTranscriptionEnvironment {
  const transcriptionsPerHour = readPositiveInt(
    config,
    'AI_RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR',
    DEFAULT_TRANSCRIPTIONS_PER_HOUR,
  );
  const baseURL = readSetting(config, 'AI_STT_BASE_URL');
  if (baseURL !== undefined) {
    log.warn(
      `AI_STT_BASE_URL configurado: el transcriptor se construye contra "${baseURL}", no contra el host oficial del proveedor`,
    );
  }

  const requestedProvider = readSetting(config, 'AI_STT_PROVIDER');
  let providerId: AiProviderId = DEFAULT_STT_PROVIDER;
  if (requestedProvider !== undefined) {
    if (isProviderId(requestedProvider)) providerId = requestedProvider;
    else log.error(`AI_STT_PROVIDER inválido: "${requestedProvider}"; se usa ${DEFAULT_STT_PROVIDER}`);
  }

  const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === providerId);
  const block = entry?.transcription;
  if (entry === undefined || block === undefined) {
    log.warn(`transcripción: el proveedor ${providerId} no declara bloque de transcripción`);
    return unavailableTranscription('not_in_catalog', transcriptionsPerHour);
  }

  const requestedModel = readSetting(config, 'AI_STT_MODEL');
  const modelId = requestedModel ?? block.models[0]?.id;
  const model = modelId === undefined ? undefined : block.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) {
    log.error(
      `AI_STT_MODEL fuera del catálogo de ${providerId}: "${requestedModel ?? '(sin default)'}"; la transcripción queda no disponible`,
    );
    return unavailableTranscription('not_in_catalog', transcriptionsPerHour);
  }

  // El orden importa: primero el precio, después el formato y por último la
  // clave, para que el motivo reportado sea el más fundamental que falta.
  if (model.pricePerMinuteUsd === null) {
    log.warn(
      `${providerId}:${model.id} no tiene precio por minuto verificado; la transcripción queda no disponible (nunca se adivina un precio)`,
    );
    return unavailableTranscription('price_unverified', transcriptionsPerHour);
  }
  if (model.acceptedMediaTypes.length === 0) {
    return unavailableTranscription('no_verified_format', transcriptionsPerHour);
  }

  const envApiKey = entry.envKey === null ? undefined : readSetting(config, entry.envKey);
  if (entry.envKey !== null && envApiKey === undefined) {
    return unavailableTranscription('missing_api_key', transcriptionsPerHour);
  }

  const settings: ProviderSettings = {
    ...(envApiKey === undefined ? {} : { apiKey: envApiKey }),
    ...(baseURL === undefined ? {} : { baseURL }),
  };

  return {
    view: {
      available: true,
      reason: null,
      provider: entry.id,
      model: model.id,
      acceptedMediaTypes: [...model.acceptedMediaTypes],
      maxBytes: AUDIO_MAX_BYTES,
      maxSeconds: MAX_AUDIO_SECONDS,
    },
    pricePerMinuteUsd: model.pricePerMinuteUsd,
    transcriber: new AiSdkTranscriber(block.model(settings, model.id), block.providerOptions),
    transcriptionsPerHour,
  };
}

/** La transcripción no disponible con su motivo, el mismo tope y el límite ya leído. */
function unavailableTranscription(
  reason: AiTranscriptionUnavailableReason,
  transcriptionsPerHour: number,
): AiTranscriptionEnvironment {
  return {
    view: {
      available: false,
      reason,
      provider: null,
      model: null,
      acceptedMediaTypes: [],
      maxBytes: AUDIO_MAX_BYTES,
      maxSeconds: MAX_AUDIO_SECONDS,
    },
    pricePerMinuteUsd: null,
    transcriber: null,
    transcriptionsPerHour,
  };
}

/** Entero positivo. Ausente → default; mal formado → `Logger.error` y default (mismo criterio que D5). */
function readPositiveInt(config: ConfigService, key: string, fallback: number): number {
  const raw = readSetting(config, key);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    log.error(`${key} inválida: "${raw}"; se usa el default ${fallback}`);
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log.error(`${key} inválida: "${raw}"; se usa el default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** El custom provider de NestJS que lee el entorno una vez. */
export const aiEnvProvider: Provider = {
  provide: AI_ENV,
  useFactory: (config: ConfigService) => createAiEnvironment(config),
  inject: [ConfigService],
};

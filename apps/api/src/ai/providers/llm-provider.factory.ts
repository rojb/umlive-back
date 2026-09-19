import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiModelRef, AiModelView, AiProviderId, AiProviderView } from '@umlive/contracts';
import { AiSdkLlmProvider } from './ai-sdk.provider';
import type { LlmProvider } from './llm-provider.interface';
import {
  PROVIDER_CATALOG,
  toModelView,
  type CatalogModel,
  type CatalogProvider,
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

/** El entorno de IA ya resuelto: vistas, defaults y construcción de adaptadores. */
export type AiEnvironment = {
  /** Una vista por entrada de catálogo, para el panel y para la cadena. */
  readonly providers: readonly AiProviderView[];
  readonly primary: AiModelRef;
  readonly fallbackChain: readonly AiModelRef[];
  /**
   * Construye el adaptador de un modelo del catálogo. Devuelve `null` si el
   * proveedor no está disponible (sin clave, sin precio verificado), si el
   * modelo no está en el catálogo, o si la configuración del endpoint falta.
   */
  createProvider(ref: AiModelRef): LlmProvider | null;
};

const DEFAULT_PROVIDER: AiProviderId = 'gemini';
const DEFAULT_MODEL = 'gemini-3.8-flash';

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
function buildProviderFactory(config: ConfigService): (ref: AiModelRef) => LlmProvider | null {
  return (ref: AiModelRef): LlmProvider | null => {
    const entry = PROVIDER_CATALOG.find((candidate) => candidate.id === ref.provider);
    if (entry === undefined || entry.unavailableReason !== null) return null;

    const model = modelsOf(entry, config).find((candidate) => candidate.id === ref.model);
    if (model === undefined) return null;

    const settings: { apiKey?: string; baseURL?: string } = {};

    if (entry.envKey !== null) {
      const apiKey = readSetting(config, entry.envKey);
      if (apiKey === undefined) return null;
      settings.apiKey = apiKey;
    }

    if (entry.id === 'openai-compatible') {
      const baseURL = readSetting(config, 'AI_OPENAI_COMPATIBLE_BASE_URL');
      if (baseURL === undefined) return null;
      settings.baseURL = baseURL;
      const apiKey = readSetting(config, 'AI_OPENAI_COMPATIBLE_API_KEY');
      if (apiKey !== undefined) settings.apiKey = apiKey;
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
    createProvider: buildProviderFactory(config),
  };
}

/** El custom provider de NestJS que lee el entorno una vez. */
export const aiEnvProvider: Provider = {
  provide: AI_ENV,
  useFactory: (config: ConfigService) => createAiEnvironment(config),
  inject: [ConfigService],
};

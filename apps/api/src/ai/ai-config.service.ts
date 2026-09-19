import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { AI_ERROR, type AiConfigView, type AiModelRef, type AiModelView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AI_ENV, type AiEnvironment } from './providers/llm-provider.factory';
import type { UpdateAiConfigRequest } from '@umlive/contracts';

/**
 * Resolución de proveedor y modelo (design D4, FR-D06/SC-D01).
 *
 * `resolve(projectId)` lee `project_ai_configs` en CADA llamado, sin caché:
 * cambiar el modelo del proyecto rige desde el turno siguiente, sin reiniciar
 * ni redesplegar (SC-D01). Si no hay fila, usa `AI_DEFAULT_*` /
 * `AI_FALLBACK_CHAIN` del entorno.
 *
 * **Falla cerrado**: una fila cuyo `provider`/`model` no está en el catálogo
 * (o un default de entorno que tampoco lo está) se rechaza con
 * `ai_model_not_in_catalog` en vez de caer a otro modelo. Un modelo sin precio
 * no existe en el catálogo por construcción (`provider-catalog.ts`), así que
 * "fuera de catálogo" cubre también "sin precio".
 *
 * El catálogo y la disponibilidad salen de `AI_ENV`: la fábrica ya resolvió las
 * credenciales una vez, al arrancar (design D5). Acá no se lee ninguna clave.
 *
 * La clave BYO del proyecto (FR-D11) es la Fase 7: en esta corrida solo se
 * reporta `hasProjectKey`, sin leer ni descifrar `api_key_cipher`.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Resolución de
 * proveedor y modelo" y "Gasto y configuración visibles…".
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** El nombre del proveedor tal como lo guarda `project_ai_configs.provider`. */
type StoredConfig = {
  readonly provider: string;
  readonly model: string;
  readonly fallbackChain: Prisma.JsonValue;
  readonly apiKeyCipher: Uint8Array | null;
};

@Injectable()
export class AiConfigService {
  private readonly log = new Logger(AiConfigService.name);

  constructor(
    @Inject(AI_ENV) private readonly env: AiEnvironment,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Configuración efectiva del proyecto, leída fresca de la base. Es la MISMA
   * vista que devuelve `GET .../ai/config` y la que consume `AiCallService`
   * para armar la cadena.
   */
  async resolve(projectId: string): Promise<AiConfigView> {
    const row = (await this.prisma.projectAiConfig.findUnique({
      where: { projectId },
      select: { provider: true, model: true, fallbackChain: true, apiKeyCipher: true },
    })) as StoredConfig | null;

    if (row === null) {
      return {
        source: 'environment',
        primary: this.resolveEnvironmentPrimary(),
        fallbackChain: this.toChain(this.env.fallbackChain),
        hasProjectKey: false,
        providers: this.env.providers,
      };
    }

    const primaryRef: AiModelRef = { provider: row.provider as AiModelRef['provider'], model: row.model };
    const primary = this.modelInCatalog(primaryRef) ?? this.rejectOutOfCatalog(primaryRef);

    return {
      source: 'project',
      primary,
      fallbackChain: this.toChain(this.readStoredChain(row.fallbackChain)),
      hasProjectKey: row.apiKeyCipher !== null,
      providers: this.env.providers,
    };
  }

  /**
   * `PUT .../ai/config` (design D6). Valida el catálogo y la disponibilidad del
   * primario y escribe SIEMPRE proveedor y modelo explícitos — nunca los
   * defaults de columna del esquema (`'gemini-flash'` no es un id real).
   */
  async update(projectId: string, request: UpdateAiConfigRequest): Promise<AiConfigView> {
    const primary = this.assertSelectable(request.primary, true);
    const chain = (request.fallbackChain ?? []).map((ref) => this.assertSelectable(ref, false));

    const fallbackChain = chain.map((model) => ({
      provider: model.provider,
      model: model.model,
    })) as unknown as Prisma.InputJsonValue;

    await this.prisma.projectAiConfig.upsert({
      where: { projectId },
      create: {
        projectId,
        provider: primary.provider,
        model: primary.model,
        fallbackChain,
      },
      update: {
        provider: primary.provider,
        model: primary.model,
        fallbackChain,
      },
    });

    return this.resolve(projectId);
  }

  /** `DELETE .../ai/config`: el proyecto vuelve al default del entorno (design D6). */
  async clear(projectId: string): Promise<void> {
    await this.prisma.projectAiConfig.deleteMany({ where: { projectId } });
  }

  /** Vista `AiModelView` de un ref del catálogo, o `null` si no está. */
  modelInCatalog(ref: AiModelRef): AiModelView | null {
    const provider = this.env.providers.find((candidate) => candidate.id === ref.provider);
    return provider?.models.find((model) => model.model === ref.model) ?? null;
  }

  /**
   * Ref → vista, con `400` si no es seleccionable (design D6). El primario
   * además tiene que estar DISPONIBLE; los eslabones de reserva no, porque el
   * despacho los saltea en tiempo de ejecución (design D4).
   */
  private assertSelectable(ref: AiModelRef, requireAvailable: boolean): AiModelView {
    const provider = this.env.providers.find((candidate) => candidate.id === ref.provider);
    const model = provider?.models.find((candidate) => candidate.model === ref.model);

    if (provider === undefined || model === undefined) {
      throw new BadRequestException({
        code: AI_ERROR.MODEL_NOT_IN_CATALOG,
        provider: ref.provider,
        model: ref.model,
      });
    }

    if (requireAvailable && !provider.available) {
      throw new BadRequestException({
        code: AI_ERROR.PROVIDER_UNAVAILABLE,
        provider: ref.provider,
        reason: provider.unavailableReason,
      });
    }

    return model;
  }

  /**
   * Primario de entorno. Si `AI_DEFAULT_*` apunta fuera del catálogo se reporta
   * con `Logger.error` y se usa el primer modelo del proveedor nombrado — el
   * default documentado Gemini Flash cuando el nombre es Gemini, que es lo que
   * FR-D06 manda. Mismo tratamiento que D5 le da a un valor mal formado: se
   * trata como ausente, no revienta el arranque.
   *
   * Ojo con la diferencia deliberada: una FILA del proyecto fuera del catálogo
   * sí falla cerrado (`rejectOutOfCatalog`) porque la escribió un humano y
   * taparla escondería la configuración rota; el default de entorno, en cambio,
   * tiene un valor obligatorio por requisito al que volver.
   */
  private resolveEnvironmentPrimary(): AiModelView {
    const primary = this.modelInCatalog(this.env.primary);
    if (primary !== null) return primary;

    const provider = this.env.providers.find(
      (candidate) => candidate.id === this.env.primary.provider && candidate.models.length > 0,
    );
    const fallback =
      provider?.models[0] ??
      this.env.providers.find((candidate) => candidate.id === 'gemini' && candidate.models.length > 0)
        ?.models[0];

    if (fallback === undefined) this.rejectOutOfCatalog(this.env.primary);

    this.log.error(
      `AI_DEFAULT fuera del catálogo: ${this.env.primary.provider}:${this.env.primary.model}; ` +
        `se usa ${fallback.provider}:${fallback.model}`,
    );
    return fallback;
  }

  /** Fail-closed: un ref de una fila fuera de catálogo no cae a otro modelo, corta. */
  private rejectOutOfCatalog(ref: AiModelRef): never {
    this.log.error(`configuración fuera del catálogo: ${ref.provider}:${ref.model}`);
    throw new BadRequestException({
      code: AI_ERROR.MODEL_NOT_IN_CATALOG,
      provider: ref.provider,
      model: ref.model,
    });
  }

  /** Filtra los refs del entorno a los que sí están en el catálogo; el resto se reporta. */
  private toChain(refs: readonly AiModelRef[]): AiModelView[] {
    const chain: AiModelView[] = [];
    for (const ref of refs) {
      const model = this.modelInCatalog(ref);
      if (model === null) {
        this.log.error(`eslabón fuera del catálogo, se omite: ${ref.provider}:${ref.model}`);
        continue;
      }
      chain.push(model);
    }
    return chain;
  }

  /** `fallback_chain` es `Json`: se acepta solo una lista de `{ provider, model }` bien formados. */
  private readStoredChain(raw: Prisma.JsonValue): readonly AiModelRef[] {
    if (!Array.isArray(raw)) return [];
    const chain: AiModelRef[] = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const candidate = entry as { provider?: unknown; model?: unknown };
      if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') continue;
      chain.push({ provider: candidate.provider as AiModelRef['provider'], model: candidate.model });
    }
    return chain;
  }
}

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AI_ERROR,
  type AiConfigView,
  type AiModelRef,
  type AiModelView,
  type AiProviderId,
  type AiProviderView,
} from '@umlive/contracts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
 * credenciales UNA vez, al arrancar (design D5). Acá no se lee ninguna clave
 * de ENTORNO.
 *
 * ── La clave propia del proyecto (FR-D11, tarea 7.3) ────────────────────────
 *
 * Se guarda cifrada con AES-256-GCM (`node:crypto`) bajo
 * `AI_KEY_ENCRYPTION_KEY` (32 bytes en base64) y se escribe como
 * `iv|tag|ciphertext`, cada parte en base64, en `project_ai_configs.api_key_cipher`.
 * Es SOLO de escritura: ninguna vista del contrato tiene un campo de clave y
 * esta clase nunca devuelve el texto claro, ni siquiera al log.
 *
 * Tres reglas:
 *
 * 1. Sin `AI_KEY_ENCRYPTION_KEY` no se puede cifrar → el `PUT` que trae una
 *    clave se rechaza con `ai_byo_key_unavailable` (design D5). Guardar en
 *    claro nunca es una opción.
 * 2. Cambiar de proveedor primario sin mandar una clave nueva BORRA la
 *    anterior: una clave de Anthropic bajo un primario Gemini no aplica a nada.
 * 3. Si el ciphertext no se puede descifrar, el proveedor del proyecto queda
 *    `available: false` con `byo_key_unreadable` (tarea 7.4) en vez de
 *    intentar un llamado con una credencial que no se pudo leer.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Resolución de
 * proveedor y modelo", "Gasto y configuración visibles…" y "Clave propia por
 * proyecto, cifrada en reposo".
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** AES-256-GCM: 32 bytes de clave, 12 de IV (nonce), 16 de tag de autenticación. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

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

  /**
   * La clave de cifrado BYO se lee UNA vez, al construir (design D5). `null`
   * significa "cifrado no disponible": un `PUT` con clave se rechaza y un
   * ciphertext guardado se reporta `byo_key_unreadable`.
   */
  private readonly encryptionKey: Buffer | null;

  constructor(
    @Inject(AI_ENV) private readonly env: AiEnvironment,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.encryptionKey = this.readEncryptionKey(config);
  }

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
      providers: this.providersForRow(row),
    };
  }

  /**
   * `PUT .../ai/config` (design D6). Valida el catálogo y la disponibilidad del
   * primario y escribe SIEMPRE proveedor y modelo explícitos — nunca los
   * defaults de columna del esquema (`'gemini-flash'` no es un id real).
   *
   * La clave BYO (FR-D11) se cifra acá si vino, se borra si vino `null` y se
   * borra si el proveedor cambió sin clave nueva (tarea 7.3). El texto claro
   * de la clave no sale de este método ni se loguea.
   */
  async update(projectId: string, request: UpdateAiConfigRequest): Promise<AiConfigView> {
    const primary = this.assertSelectable(request.primary, true);
    const chain = (request.fallbackChain ?? []).map((ref) => this.assertSelectable(ref, false));

    const existing = await this.prisma.projectAiConfig.findUnique({
      where: { projectId },
      select: { provider: true, apiKeyCipher: true },
    });
    const key = this.keyOperation(request.apiKey, existing, primary.provider);

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
        ...(key.action === 'set' ? { apiKeyCipher: key.value } : {}),
      },
      update: {
        provider: primary.provider,
        model: primary.model,
        fallbackChain,
        ...(key.action === 'set' ? { apiKeyCipher: key.value } : {}),
        ...(key.action === 'clear' ? { apiKeyCipher: null } : {}),
      },
    });

    return this.resolve(projectId);
  }

  /** `DELETE .../ai/config`: el proyecto vuelve al default del entorno (design D6). */
  async clear(projectId: string): Promise<void> {
    await this.prisma.projectAiConfig.deleteMany({ where: { projectId } });
  }

  /**
   * Vista de proveedores PARA ESTE PROYECTO: la del entorno, con el proveedor
   * del proyecto degradado a `byo_key_unreadable` si su ciphertext no se puede
   * leer (tarea 7.4).
   *
   * Se recalcula por proyecto y no se cachea porque `providers` es parte de la
   * misma vista que `resolve` lee sin caché (SC-D01).
   */
  private providersForRow(row: StoredConfig): readonly AiProviderView[] {
    if (row.apiKeyCipher === null) return this.env.providers;
    if (this.decrypt(row.apiKeyCipher) !== null) return this.env.providers;

    this.log.error(
      `proyecto con clave BYO ilegible para el proveedor ${row.provider}: ` +
        `ciphertext alterado, o AI_KEY_ENCRYPTION_KEY ausente o rotada; se marca byo_key_unreadable`,
    );

    return this.env.providers.map((provider) =>
      provider.id === row.provider
        ? { ...provider, available: false, unavailableReason: 'byo_key_unreadable' as const }
        : provider,
    );
  }

  /**
   * Qué hacer con la clave guardada (tarea 7.3). Cuatro casos, sin ambigüedad:
   *
   * | `request.apiKey` | resultado |
   * |---|---|
   * | cadena no vacía | `set`: se cifra y reemplaza |
   * | `null` explícito | `clear`: se borra |
   * | vacía / `undefined`, mismo proveedor | `keep` |
   * | vacía / `undefined`, proveedor distinto | `clear` |
   */
  private keyOperation(
    requested: string | null | undefined,
    existing: { readonly provider: string; readonly apiKeyCipher: Uint8Array | null } | null,
    primaryProvider: AiProviderId,
  ): { action: 'set'; value: Uint8Array<ArrayBuffer> } | { action: 'clear' } | { action: 'keep' } {
    if (typeof requested === 'string' && requested.trim().length > 0) {
      return { action: 'set', value: this.encrypt(requested.trim()) };
    }

    if (requested === null) return { action: 'clear' };

    if (existing === null || existing.apiKeyCipher === null) return { action: 'keep' };
    return existing.provider === primaryProvider ? { action: 'keep' } : { action: 'clear' };
  }

  /**
   * AES-256-GCM. Se guarda `iv|tag|ciphertext`, cada parte en base64, como
   * bytes UTF-8 — legible en la base y sin perder autenticidad: el tag cubre
   * el ciphertext, así que alterarlo hace fallar el descifrado (tarea 7.4).
   */
  private encrypt(plain: string): Uint8Array<ArrayBuffer> {
    if (this.encryptionKey === null) {
      throw new BadRequestException({
        code: AI_ERROR.BYO_KEY_UNAVAILABLE,
        reason: 'missing_encryption_key',
      });
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // `new Uint8Array(...)` y no el `Buffer` directo: Prisma tipa la columna
    // `Bytes` como `Uint8Array<ArrayBuffer>`, y un `Buffer` es
    // `Uint8Array<ArrayBufferLike>` (admite `SharedArrayBuffer`), que no asigna.
    return new Uint8Array(
      Buffer.from(
        `${iv.toString('base64')}|${tag.toString('base64')}|${ciphertext.toString('base64')}`,
        'utf8',
      ),
    );
  }

  /**
   * Descifra. Devuelve `null` ante CUALQUIER anomalía — forma inesperada, IV o
   * tag de tamaño equivocado, clave de cifrado ausente, o tag que no valida —
   * para que el llamador degrade a `byo_key_unreadable` en vez de propagar una
   * excepción desde un `GET`.
   */
  private decrypt(cipher: Uint8Array): string | null {
    if (this.encryptionKey === null) return null;

    try {
      const parts = Buffer.from(cipher).toString('utf8').split('|');
      if (parts.length !== 3) return null;

      const [ivPart, tagPart, bodyPart] = parts as [string, string, string];
      const iv = Buffer.from(ivPart, 'base64');
      const tag = Buffer.from(tagPart, 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(bodyPart, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * `AI_KEY_ENCRYPTION_KEY`: 32 bytes en base64 (design D5). Ausente o mal
   * formada → `null` con `Logger.error` y BYO deshabilitado, nunca un crash al
   * arrancar.
   */
  private readEncryptionKey(config: ConfigService): Buffer | null {
    const raw = config.get<string>('AI_KEY_ENCRYPTION_KEY');
    if (raw === undefined || raw === null) return null;

    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    const key = Buffer.from(trimmed, 'base64');
    if (key.length !== KEY_BYTES) {
      this.log.error(
        `AI_KEY_ENCRYPTION_KEY inválida: se esperaban ${KEY_BYTES} bytes en base64 y llegaron ${key.length}; ` +
          'las claves BYO quedan deshabilitadas',
      );
      return null;
    }
    return key;
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

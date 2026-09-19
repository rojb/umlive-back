/**
 * Contrato del panel de IA (M6, rebanada 1/4 — `ai-provider-layer`).
 *
 * Especificación: `openspec/changes/ai-provider-layer/specs/ai-provider-layer-backend/spec.md`
 * (FR-D01 a FR-D15b, SC-D01/D04/D05/D12/D13/D15) y
 * `.../ai-provider-layer-frontend/spec.md` (panel).
 * Diseño: `openspec/changes/ai-provider-layer/design.md` D1, D5, D6 y D8.
 *
 * ── La regla que este archivo hace cumplir (SC-D05) ─────────────────────────
 *
 * NINGUNA vista de este contrato tiene un campo de clave: ni la del entorno,
 * ni la propia del proyecto (FR-D11), ni siquiera un booleano por proveedor.
 * Lo único que el cliente puede saber es `AiConfigView.hasProjectKey`, que dice
 * si hay una clave guardada, nunca cuál. La clave sólo viaja de cliente a
 * servidor (FR-D11, más adelante) y no vuelve en ninguna lectura.
 *
 * ── Los montos viajan como `string`, nunca como `number` ────────────────────
 *
 * Un techo de gasto calculado con punto flotante binario deriva, y un techo que
 * deriva no es un techo (`DATA-MODEL.md` §3.8). Todo precio y todo monto de
 * este contrato es un string decimal; la aritmética del backend se hace con
 * `Prisma.Decimal` (design D1).
 *
 * Solo tipos y constantes, sin dependencias de ejecución — misma regla que
 * `auth.ts` y `projects.ts`. Este paquete es CommonJS: los imports relativos
 * van sin `.js`.
 */

/** Los seis proveedores del catálogo (FR-D02). */
export type AiProviderId =
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'moonshot'
  | 'openai-compatible';

/** Un modelo concreto dentro de un proveedor: la unidad que el host elige. */
export interface AiModelRef {
  readonly provider: AiProviderId;
  readonly model: string;
}

/**
 * Declaración estática de capacidades (FR-D03).
 *
 * `maxImageBytes` y `maxImageDimension` son `number | null`. `null` significa
 * que el límite todavía no está fijado por `ai-image-input`; por la regla de
 * design D1, mientras sea `null` la visión no es negociable para ese modelo.
 */
export interface AiCapabilities {
  readonly text: boolean;
  readonly vision: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly maxImageBytes: number | null;
  readonly maxImageDimension: number | null;
}

/**
 * Precio en USD por millón de tokens, como string decimal.
 *
 * `source` y `verifiedAt` son obligatorios a propósito: un precio sin fuente
 * es un precio inventado, y el techo de gasto se apoya en estos números
 * (FR-D12, deltas de precios en el selector).
 */
export interface AiModelPrice {
  readonly inputPerMtokUsd: string;
  readonly outputPerMtokUsd: string;
  /** De dónde salió el número: documento y sección, o URL oficial. */
  readonly source: string;
  /** Fecha ISO `YYYY-MM-DD` de la verificación del precio. */
  readonly verifiedAt: string;
}

export interface AiModelView extends AiModelRef {
  readonly label: string;
  readonly capabilities: AiCapabilities;
  readonly price: AiModelPrice;
}

/**
 * Motivo por el que un proveedor no se puede elegir.
 *
 * - `missing_api_key`: falta su variable de entorno de clave (FR-D07).
 * - `price_unverified`: está en el catálogo pero ningún modelo suyo tiene un
 *   precio verificado, así que no puede entrar en la tabla de precios ni ser
 *   seleccionable (FR-D02 menos FR-D03, PO-2/tarea 0.2).
 * - `missing_configuration`: al endpoint OpenAI-compatible le falta base URL,
 *   modelo o precios.
 */
export type AiProviderUnavailableReason =
  | 'missing_api_key'
  | 'price_unverified'
  | 'missing_configuration';

export interface AiProviderView {
  readonly id: AiProviderId;
  readonly label: string;
  readonly available: boolean;
  /** `null` si y solo si `available` es `true`. */
  readonly unavailableReason: AiProviderUnavailableReason | null;
  readonly models: readonly AiModelView[];
}

/** De dónde sale la configuración efectiva: override del proyecto o entorno. */
export type AiConfigSource = 'project' | 'environment';

export interface AiConfigView {
  readonly source: AiConfigSource;
  readonly primary: AiModelView;
  readonly fallbackChain: readonly AiModelView[];
  /** FR-D11: hay una clave propia guardada. Es lo máximo que se revela. */
  readonly hasProjectKey: boolean;
  readonly providers: readonly AiProviderView[];
}

/**
 * Cuerpo de `PUT .../ai/config`.
 *
 * Trae a propósito SOLO el proveedor, el modelo y la cadena de respaldo. La
 * clave propia (FR-D11) escribe un campo propio cuando esa fase exista; no se
 * declara acá para no dejar ninguna superficie de clave en este contrato.
 */
export interface UpdateAiConfigRequest {
  readonly primary: AiModelRef;
  readonly fallbackChain?: readonly AiModelRef[];
}

/** Una fila de `ai_turns` para la vista de FR-D12 (máximo 10, las últimas). */
export interface AiSpendTurnView {
  readonly turnId: string;
  readonly createdAt: string;
  readonly diagramName: string;
  readonly model: AiModelRef;
  readonly costUsd: string;
  readonly status: string;
  /** `true` si el turno todavía es una reserva `PENDING` sin liquidar. */
  readonly reserved: boolean;
}

export interface AiSpendView {
  /**
   * `null` cuando `AI_SPEND_CEILING_USD` no está configurado. No es "sin
   * techo": es un techo ausente, y con él el sistema rechaza todo turno con
   * `ceiling_not_configured` (PO-4, design D5).
   */
  readonly ceilingUsd: string | null;
  readonly environmentSpentUsd: string;
  readonly projectSpentUsd: string;
  readonly recentTurns: readonly AiSpendTurnView[];
}

export type AiHealthCheckStepKind = 'text' | 'toolCalling' | 'vision';

export interface AiHealthCheckStep {
  readonly kind: AiHealthCheckStepKind;
  readonly ok: boolean;
  readonly detail: string | null;
}

/** Resultado de `POST .../ai/health-check` (FR-D13, design D8). */
export interface AiHealthCheckResult {
  readonly ok: boolean;
  readonly primary: AiModelRef;
  readonly steps: readonly AiHealthCheckStep[];
  /** Motivo legible del fallo, o `null` si `ok`. */
  readonly failureReason: string | null;
}

/**
 * Códigos de error de la superficie HTTP de IA. Mismo patrón que
 * `PROJECT_ERROR`: constantes `as const` para que el servidor y el cliente no
 * puedan escribir el string dos veces distinto.
 */
export const AI_ERROR = {
  PROVIDER_UNAVAILABLE: 'ai_provider_unavailable',
  MODEL_NOT_IN_CATALOG: 'ai_model_not_in_catalog',
  /** Frase exacta que exige design D5: sin techo configurado no hay default. */
  CEILING_NOT_CONFIGURED: 'ceiling_not_configured',
  SPEND_CEILING_REACHED: 'ai_spend_ceiling_reached',
  RATE_LIMITED: 'rate_limited',
  HEALTH_CHECK_NEEDS_DIAGRAM: 'ai_health_check_needs_diagram',
} as const;

export type AiErrorCode = (typeof AI_ERROR)[keyof typeof AI_ERROR];

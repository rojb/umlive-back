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

// El turno del asistente lleva el tipo de operación que produjo y, cuando se
// rechaza después del proveedor, el rechazo del pipeline ya tipado. Es un
// import SOLO de tipos, así que no introduce ciclo en runtime.
import type { OperationRejected, OperationType } from './operations';

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
 * - `byo_key_unreadable`: el proyecto guardó una clave propia (FR-D11) y el
 *   ciphertext no se puede descifrar — clave de cifrado ausente, rotada o
 *   ciphertext alterado. Se degrada a no disponible en vez de llamar con una
 *   credencial que no se pudo leer (design D8, tarea 7.4).
 */
export type AiProviderUnavailableReason =
  | 'missing_api_key'
  | 'price_unverified'
  | 'missing_configuration'
  | 'byo_key_unreadable';

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
 * ── Por qué `apiKey` SÍ está acá y sigue sin romper SC-D05 ─────────────────
 *
 * Es un campo de ESCRITURA: viaja del cliente al servidor y nunca vuelve. Las
 * vistas (`AiConfigView`, `AiSpendView`, `AiModelView`) siguen sin tener ningún
 * campo de clave — lo único que una lectura revela es `hasProjectKey`. Que este
 * tipo declare `apiKey` es lo que permite que el cliente lo mande sin inventar
 * una forma paralela; que ninguna vista lo declare es lo que hace que no pueda
 * volver (FR-D11, SC-D05).
 *
 * Semántica (design D8, tarea 7.3):
 * - una cadena no vacía se cifra y reemplaza la clave guardada;
 * - `null` borra la clave guardada;
 * - `undefined` (o cadena vacía) no manda clave nueva: se conserva la anterior
 *   SOLO si el proveedor primario no cambió, y se borra si cambió, porque una
 *   clave de Anthropic guardada bajo un primario Gemini ya no aplica a nada.
 */
export interface UpdateAiConfigRequest {
  readonly primary: AiModelRef;
  readonly fallbackChain?: readonly AiModelRef[];
  readonly apiKey?: string | null;
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
  /**
   * Se pidió guardar una clave BYO (FR-D11) y el servidor no tiene clave de
   * cifrado configurada, o la que tiene no son 32 bytes en base64. Guardar en
   * claro NO es una opción: se rechaza el `PUT` (design D5/D8).
   */
  BYO_KEY_UNAVAILABLE: 'ai_byo_key_unavailable',
} as const;

export type AiErrorCode = (typeof AI_ERROR)[keyof typeof AI_ERROR];

// ─────────────────────────────────────────────────────────────────────────────
// Turnos de texto y voz (M6, rebanada 2/4 — `ai-text-instructions`)
// ─────────────────────────────────────────────────────────────────────────────
//
// Especificación: `.../ai-text-instructions-backend/spec.md` (FR-D05, FR-D15b,
// FR-D20, FR-D24, FR-D25, SC-D03/D06/D07/D08/D09/D11/D14/C20) y
// `.../ai-text-instructions-frontend/spec.md`. Diseño: `design.md` D8, D9, D10.
//
// Estos tipos NO tienen ningún campo de clave ni de credencial: valen las
// mismas reglas de SC-D05 que el resto del contrato.

export type AiTurnInputMode = 'TEXT' | 'VOICE';

/** Cuerpo de `POST .../ai/turns`. El `prompt` se acota en el DTO (1 a 2000). */
export interface AiTurnRequest {
  readonly prompt: string;
  readonly inputMode: AiTurnInputMode;
}

/** Una operación que el turno aplicó, con su etiqueta en lenguaje simple. */
export interface AiTurnAppliedOp {
  readonly type: OperationType;
  /** «Clase Dirección creada», «Atributo nombre agregado a Cliente». */
  readonly label: string;
}

/** Una llamada a herramienta que no se aplicó, con su motivo (FR-D25). */
export interface AiTurnNotAppliedCall {
  readonly tool: string;
  readonly reason: string;
}

/** FR-D25 y SC-D11: qué se aplicó, qué no, y qué dijo el modelo. */
export interface AiTurnSummary {
  readonly applied: readonly AiTurnAppliedOp[];
  readonly notApplied: readonly AiTurnNotAppliedCall[];
  readonly modelText: string;
}

export type AiTurnStatus = 'APPLIED' | 'REJECTED' | 'FAILED' | 'CANCELLED';

/**
 * Motivo por el que «Deshacer turno» no se ofrece (PO-1, PO-B).
 *
 * - `not_create_only`: el turno no solo creó (D5 exige inversas solo de
 *   creaciones).
 * - `touched_later`: alguna operación posterior tocó algo que el turno creó.
 * - `already_undone`: está el `undo:0` en el log.
 * - `not_owner`: lo pide alguien que no pidió el turno.
 * - `nothing_applied`: no hay nada que deshacer.
 */
export type AiUndoIneligibleReason =
  | 'not_create_only'
  | 'touched_later'
  | 'already_undone'
  | 'not_owner'
  | 'nothing_applied';

export type AiUndoEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: AiUndoIneligibleReason };

/**
 * Resultado de un turno (D10).
 *
 * Todo turno que llegó al proveedor responde `200` con este cuerpo y su
 * `status`; `rejection` viaja solo en `REJECTED` posterior al proveedor, porque
 * el costo ya se pagó y la fila existe.
 *
 * `costUsd` es `string` decimal, no `number`: misma regla de dinero que el
 * resto del contrato (`DATA-MODEL.md` §3.8).
 */
export interface AiTurnResult {
  readonly turnId: string;
  readonly status: AiTurnStatus;
  readonly summary: AiTurnSummary;
  readonly rejection?: OperationRejected;
  readonly costUsd: string;
  readonly iterations: number;
  readonly provider: string;
  readonly model: string;
  readonly fallbackFired: boolean;
  readonly fallbackFrom: string | null;
  readonly undo: AiUndoEligibility;
}

/**
 * Respuesta de `POST .../ai/turns/:turnId/undo` (D5).
 *
 * `undone: false` con `reason` es la respuesta segura: el doble clic encuentra
 * `undo:0` y devuelve `already_undone` sin aplicar nada una segunda vez.
 */
export interface AiUndoResult {
  readonly turnId: string;
  readonly undone: boolean;
  /** `null` si y solo si `undone` es `true`. */
  readonly reason: AiUndoIneligibleReason | null;
  /** Versión del diagrama después del lote. */
  readonly version: number;
}

/**
 * Códigos de error de las guardas del turno (D9, D10).
 *
 * Son rechazos ANTES del proveedor: errores HTTP y **sin** fila en `ai_turns`.
 * Los `429`/`409` de la reserva ya viajan con `AI_ERROR` de la rebanada 1.
 */
export const AI_TURN_ERROR = {
  /** Congelado antes del proveedor (SC-C20): `423`, cero pedidos al proveedor. */
  DIAGRAM_FROZEN: 'diagram_frozen',
  /** Ya hay un turno de este usuario sobre este diagrama: `409`. */
  TURN_IN_PROGRESS: 'ai_turn_in_progress',
  /** Ningún eslabón de la cadena declara `toolCalling`: `409`. */
  TOOL_CALLING_UNAVAILABLE: 'ai_tool_calling_unavailable',
  /** El archivo supera el tope de la subida: `413`, con `limitBytes`. */
  IMAGE_TOO_LARGE: 'image_too_large',
  /** La firma de los bytes no es PNG/JPEG/WebP: `415`. */
  IMAGE_TYPE_UNSUPPORTED: 'image_type_unsupported',
  /** La firma es válida pero la estructura no se puede leer entera (JPEG truncado): `422`. */
  IMAGE_UNREADABLE: 'image_unreadable',
  /** La imagen no entra en los límites declarados del eslabón efectivo: `422`. */
  IMAGE_EXCEEDS_PROVIDER_LIMITS: 'image_exceeds_provider_limits',
  /** Ningún eslabón de la cadena declara `vision` y `toolCalling`: `409`. */
  AI_VISION_UNAVAILABLE: 'ai_vision_unavailable',
  /** Modo `create` sobre un diagrama con elementos (PO-4): `409`. */
  AI_IMAGE_CREATE_REQUIRES_EMPTY_DIAGRAM: 'ai_image_create_requires_empty_diagram',
  /** La vista previa venció o se perdió en un reinicio: `410`. */
  AI_PREVIEW_EXPIRED: 'ai_preview_expired',
  /** El diagrama cambió desde que se armó el plan (PO-D): `409`, con `reason`. */
  AI_PREVIEW_STALE: 'ai_preview_stale',
  /** La confirmación nombró un índice que el plan no tiene: `400`. */
  AI_PREVIEW_ITEM_UNKNOWN: 'ai_preview_item_unknown',
} as const;

export type AiTurnErrorCode = (typeof AI_TURN_ERROR)[keyof typeof AI_TURN_ERROR];

// ─────────────────────────────────────────────────────────────────────────────
// Entrada de imagen (M6, rebanada 3/4 — `ai-image-input`)
// ─────────────────────────────────────────────────────────────────────────────
//
// Especificación: `.../ai-image-input-backend/spec.md` (FR-D21, FR-D22, FR-D23,
// FR-D25, SC-D02, SC-D16, SC-D18) y `.../ai-image-input-frontend/spec.md`.
// Diseño: `design.md` D2, D6, D7, D8 y D9.
//
// Un turno de imagen es un turno de texto partido en dos pedidos: planificar
// (devuelve `AiImagePreview`, cero escrituras) y confirmar (devuelve
// `AiImageConfirmResult`, un solo lote). Mismas reglas de siempre: ningún tipo
// de acá lleva clave ni credencial, y ningún monto viaja como `number`.

export type AiImageMode = 'create' | 'modify';

/**
 * Por qué un ítem arranca con `confidence: 'low'` (PO-2, D6).
 *
 * - `model`: el propio modelo lo declaró dudoso.
 * - `multiplicity_unparsed`: el servidor no pudo interpretar una multiplicidad.
 * - `name_suspicious`: el nombre trae caracteres fuera de `[\p{L}\p{N}_]`.
 */
export type AiPreviewLowReason = 'model' | 'multiplicity_unparsed' | 'name_suspicious';

/**
 * Un ítem de la vista previa: UNA llamada a herramienta aceptada (D6).
 *
 * `dependsOn` son los ítems que producen los `new:N` que este ítem referencia, y
 * **solo apunta hacia atrás**: por eso el cierre de exclusiones se calcula en
 * una sola pasada. `initiallyExcluded` es `true` para todo ítem de baja
 * confianza y para todo ítem que dependa, directa o indirectamente, de uno.
 */
export interface AiPreviewItem {
  readonly index: number;
  /** Etiqueta en lenguaje simple: «Clase Pedido». */
  readonly label: string;
  readonly kind: 'class' | 'attribute' | 'operation' | 'relationship';
  readonly confidence: 'high' | 'low';
  readonly lowReasons: readonly AiPreviewLowReason[];
  readonly note: string | null;
  readonly dependsOn: readonly number[];
  readonly initiallyExcluded: boolean;
}

/**
 * La vista previa de un turno de imagen (SC-D18, mitad servidor).
 *
 * No lleva ningún byte de la imagen: solo el plan, su costo ya liquidado y el
 * momento en que vence. `truncated: true` es la marca de PO-C — el bucle agotó
 * sus iteraciones y el plan está incompleto, nunca `FAILED`.
 */
export interface AiImagePreview {
  readonly turnId: string;
  readonly mode: AiImageMode;
  /** ISO: vencimiento del TTL de la vista previa (D8). */
  readonly expiresAt: string;
  readonly items: readonly AiPreviewItem[];
  readonly notApplied: AiTurnSummary['notApplied'];
  readonly modelText: string;
  readonly costUsd: string;
  readonly iterations: number;
  readonly truncated: boolean;
  readonly provider: string;
  readonly model: string;
  readonly fallbackFired: boolean;
  readonly fallbackFrom: string | null;
}

/**
 * Cuerpo de `POST .../ai/turns/:turnId/confirm` (PO-2).
 *
 * Los índices son los ítems que el usuario DESTILDÓ. El servidor los valida
 * como enteros únicos dentro del rango de su plan y recalcula el cierre: nunca
 * confía en el cierre que armó el cliente.
 */
export interface AiConfirmTurnRequest {
  readonly excluded: readonly number[];
}

/**
 * Respuesta de la confirmación (D6, D8): el resultado del turno más el cierre
 * de exclusiones que el servidor aplicó de verdad.
 *
 * `alreadyConfirmed` es el eco del doble clic: el plan ya estaba aplicado y no
 * se aplicó una segunda vez.
 */
export type AiImageConfirmResult = AiTurnResult & {
  readonly excludedClosure: readonly number[];
  readonly alreadyConfirmed?: true;
};

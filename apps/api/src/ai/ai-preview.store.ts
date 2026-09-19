import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiImageMode, AiPreviewItem, AiTurnAppliedOp, AiTurnNotAppliedCall } from '@umlive/contracts';
import type { PlannedOp } from './ai-turn-plan';

/**
 * La vista previa del turno de imagen (M6, rebanada 3/4 — `ai-image-input`,
 * diseño D8). Un `Map<turnId, PendingPreview>` en memoria, con TTL y barrido.
 *
 * ── Por qué memoria y por qué está bien ────────────────────────────────────
 *
 * Un turno de imagen es un turno de texto PARTIDO EN DOS: el primero planifica
 * (pagando el proveedor) y el segundo, minutos después, aplica. Entre los dos
 * hay un humano mirando una foto. Lo único que hay que recordar es el plan, y
 * el plan vive en memoria porque hay UNA sola instancia de backend (PRD §12
 * Q5). Un reinicio lo pierde **a propósito**: no hay nada que purgar, la fila de
 * `ai_turns` queda `PENDING` con su costo ya registrado y el confirm responde
 * `410 ai_preview_expired` (nunca dejar operaciones aplicadas sin confirmación).
 *
 * ── Nunca guarda un byte de la imagen ──────────────────────────────────────
 *
 * La entrada no tiene `Buffer` de imagen, ni base64, ni nada que se le parezca:
 * el buffer de multer se libera (`fill(0)`) apenas termina el bucle y acá
 * quedan ítems, operaciones planificadas, ids referenciados y metadatos. Eso es
 * lo que hace cierta la promesa de privacidad de la rebanada.
 *
 * ── El TTL y el barrido ────────────────────────────────────────────────────
 *
 * Diez minutos (`AI_IMAGE_PREVIEW_TTL_MS` lo baja, para poder verificar el
 * vencimiento sin esperar diez minutos reales). Un barrido cada 60 s cierra lo
 * vencido. El `setInterval` va con `.unref()`: sin eso, un temporizador de fondo
 * mantiene vivo el proceso cuando ya nadie lo necesita.
 *
 * ── Una vista previa por (usuario, diagrama) ───────────────────────────────
 *
 * Dos vistas previas vivas sobre el mismo diagrama son dos planes
 * contradictorios: la persona confirma el segundo creyendo que el primero ya no
 * está. Una vista previa nueva CANCELA la anterior y el dueño vuelve a pedir.
 * Ojo con lo que NO ocupa: la vista previa no toma el `Set` de turnos en curso
 * del servicio (el confirm sí, mientras aplica).
 *
 * Especificación: `.../ai-image-input-backend/spec.md`, "Nada se escribe en
 * `diagram_operations` hasta la confirmación explícita" y "La vista previa
 * vencida o perdida se informa sin dejar el gasto sin explicar".
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** TTL por defecto de una vista previa: diez minutos (D8). */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Frecuencia del barrido: un minuto (D8). */
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Los dos estados de una entrada. `confirming` es el candado del doble clic: el
 * `take` lo pone de forma SÍNCRONA, así que un segundo pedido no puede
 * intercalarse entre la lectura y la aplicación (el proceso es de un solo hilo).
 */
export type PreviewState = 'ready' | 'confirming';

/** Por qué se canceló una vista previa sin confirmar. */
export type PreviewCancelReason = 'replaced' | 'expired';

/**
 * Todo lo que el confirm necesita, y nada más (D8). Los bytes de la imagen no
 * están acá por diseño; el `AiTurn` tampoco, porque guardarlo mantendría viva
 * una credencial descifrable por diez minutos sin ninguna ganancia.
 */
export interface PendingPreview {
  readonly userId: string;
  readonly diagramId: string;
  readonly mode: AiImageMode;
  readonly items: readonly AiPreviewItem[];
  /** Las operaciones de cada ítem, alineadas por índice con `items`. */
  readonly opsByItem: readonly (readonly PlannedOp[])[];
  /** Lo que la vista previa lista por ítem, alineado por índice (FR-D25). */
  readonly appliedByItem: readonly (readonly AiTurnAppliedOp[])[];
  readonly notApplied: readonly AiTurnNotAppliedCall[];
  readonly modelText: string;
  /** La versión del diagrama leída ANTES de la foto (PO-D). */
  readonly baseVersion: number;
  /** Los UUID existentes que el plan referencia (D8): precheck y locks. */
  readonly referencedIds: readonly string[];
  /** Vencimiento, en milisegundos desde el epoch. */
  readonly expiresAt: number;
  /** Mutable: `take` lo pasa a `confirming` y `restore` lo vuelve a `ready`. */
  state: PreviewState;
}

/** Lo que hay que guardar al publicar una vista previa; el store agrega TTL y estado. */
export type NewPendingPreview = Omit<PendingPreview, 'expiresAt' | 'state'>;

@Injectable()
export class AiPreviewStore implements OnModuleDestroy {
  private readonly log = new Logger(AiPreviewStore.name);

  private readonly previews = new Map<string, PendingPreview>();
  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  /**
   * Lo que hay que hacer con una vista previa que se cancela sin que nadie la
   * confirme: cerrar su fila `CANCELLED`. Es un callback y no una dependencia
   * porque el store no puede importar `AiTurnService` (sería un ciclo) y
   * tampoco debe saber de proveedores ni de gasto. El servicio lo registra al
   * construirse.
   */
  private onCancel?: (turnId: string, reason: PreviewCancelReason) => void;

  constructor(config: ConfigService) {
    this.ttlMs = readTtl(config);
    this.sweeper = setInterval(() => this.expire(), SWEEP_INTERVAL_MS);
    // No debe mantener vivo el proceso: un temporizador de fondo que nadie
    // limpia es la clase de cosa que hace que un test runner no termine.
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /** Registra el cierre de las vistas previas canceladas (reemplazo o TTL). */
  registerCancel(handler: (turnId: string, reason: PreviewCancelReason) => void): void {
    this.onCancel = handler;
  }

  /**
   * Publica una vista previa y CANCELA la anterior del mismo (usuario,
   * diagrama). Devuelve el `expiresAt` ya calculado, que el servicio necesita
   * para la respuesta (no hay que volver a leer la entrada para saber cuándo
   * vence).
   */
  put(turnId: string, preview: NewPendingPreview): number {
    this.cancelPrevious(preview.userId, preview.diagramId, turnId);
    const expiresAt = Date.now() + this.ttlMs;
    this.previews.set(turnId, { ...preview, expiresAt, state: 'ready' });
    return expiresAt;
  }

  /**
   * Toma la vista previa para confirmarla: `ready → confirming`, SÍNCRONO (D8).
   * `null` cuando no hay entrada lista — perdida en un reinicio, vencida, ya
   * tomada por otro confirm o cancelada. El servicio decide con la fila.
   */
  take(turnId: string): PendingPreview | null {
    const entry = this.previews.get(turnId);
    if (entry === undefined || entry.state !== 'ready') return null;
    entry.state = 'confirming';
    return entry;
  }

  /**
   * Devuelve una entrada `confirming` a `ready`: se puede reintentar dentro del
   * TTL. Es el camino de un diagrama congelado o de un lock ajeno (D8), donde
   * nada se aplicó y la vista previa sigue siendo válida.
   */
  restore(turnId: string): void {
    const entry = this.previews.get(turnId);
    if (entry !== undefined && entry.state === 'confirming') entry.state = 'ready';
  }

  /** Lee sin tomar. */
  get(turnId: string): PendingPreview | undefined {
    return this.previews.get(turnId);
  }

  /** Borra una entrada y devuelve si existía (idempotente). */
  delete(turnId: string): boolean {
    return this.previews.delete(turnId);
  }

  /** El barrido del TTL: cierra lo vencido con `CANCELLED` (D8, tarea 4.5). */
  private expire(): void {
    const now = Date.now();
    for (const [turnId, entry] of [...this.previews.entries()]) {
      if (entry.expiresAt > now) continue;
      this.previews.delete(turnId);
      this.cancel(turnId, 'expired');
    }
  }

  /** Cancela la vista previa anterior del mismo (usuario, diagrama), si hay. */
  private cancelPrevious(userId: string, diagramId: string, keepTurnId: string): void {
    for (const [turnId, entry] of [...this.previews.entries()]) {
      if (turnId === keepTurnId) continue;
      if (entry.userId !== userId || entry.diagramId !== diagramId) continue;
      this.previews.delete(turnId);
      this.cancel(turnId, 'replaced');
    }
  }

  private cancel(turnId: string, reason: PreviewCancelReason): void {
    if (this.onCancel === undefined) {
      this.log.warn(`vista previa ${turnId} cancelada (${reason}) sin manejador de cierre registrado`);
      return;
    }
    try {
      this.onCancel(turnId, reason);
    } catch (error) {
      this.log.error(`no se pudo cerrar la vista previa ${turnId} (${reason}): ${describe(error)}`);
    }
  }
}

/** `AI_IMAGE_PREVIEW_TTL_MS` entero positivo; ausente o mal formado → default con `Logger.error`. */
function readTtl(config: ConfigService): number {
  const raw = config.get<string>('AI_IMAGE_PREVIEW_TTL_MS');
  if (raw === undefined || raw === null) return DEFAULT_TTL_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_TTL_MS;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    new Logger(AiPreviewStore.name).error(
      `AI_IMAGE_PREVIEW_TTL_MS inválido: "${trimmed}"; se usa el default de ${DEFAULT_TTL_MS} ms`,
    );
    return DEFAULT_TTL_MS;
  }
  return parsed;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

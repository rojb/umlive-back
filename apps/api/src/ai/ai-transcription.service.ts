import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AiAudioMediaType,
  AiProviderId,
  AiTranscriptionLanguage,
  AiTranscriptionResult,
  AiTranscriptionUnavailableReason,
} from '@umlive/contracts';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { Prisma } from '../generated/prisma/client';
import { DiagramContentService } from '../uml/diagram-content.service';
import { AiSpendService, TRANSCRIPTION_PROMPT_TEXT, type SpendRejection } from './ai-spend.service';
import type { TranscriptionOutcome } from './providers/ai-sdk.transcriber';
import { AI_ENV, type AiEnvironment, type AiTranscriptionEnvironment } from './providers/llm-provider.factory';
import { WORST_CASE_AUDIO_BPS } from './providers/provider-catalog';

/**
 * La transcripción de voz del servidor (M6, rebanada 4/4 — FR-D20).
 *
 * ── El orden de las guardas es la parte que no se puede mover (D2-D4) ────────
 *
 * | # | Guarda | Costo si falla |
 * |---|---|---|
 * | 0 | `ai.use` (guard HTTP, no acá) | cero |
 * | 1 | diagrama congelado (`423`) | cero: no se reserva ni se llama |
 * | 2 | límite de ritmo PROPIO de transcripción (`429`) | cero |
 * | 3 | disponibilidad del modelo (`409`) | cero |
 * | 4 | MIME declarado + firma de bytes (`415`) | cero: el proveedor nunca se llama |
 * | 5 | reserva por bytes al peor bitrate | acá ya se reserva |
 * | 6 | `transcribe()` | |
 * | 7 | liquidación | |
 *
 * Un diagrama congelado tiene que costar CERO, y un archivo que no es lo que
 * dice ser también: por eso la firma de bytes corre ANTES de reservar. El MIME
 * declarado es una afirmación del cliente; la firma es el hecho.
 *
 * ── La reserva usa el PEOR bitrate, no los 60 s de la propuesta (PO-A) ──────
 *
 * `ceil(bytes × 8 / WORST_CASE_AUDIO_BPS)` segundos, con piso de 60. Un cliente
 * adulterado puede meter minutos de Opus a 6 kbps en 1 MiB; reservar por bytes
 * con el peor bitrate hace que el libro NUNCA cuente de menos, que es la regla
 * que `ai-provider-layer` fijó. El uso honesto sobrecuenta, y se declara.
 *
 * ── El texto NUNCA se guarda ni se loguea (PO-3) ────────────────────────────
 *
 * La fila de `ai_turns` lleva `prompt_text = '[transcription]'`, 0 tokens, modo
 * `VOICE` y el proveedor/modelo del STT. El transcript sale solo en la
 * respuesta HTTP. El audio vive únicamente en el buffer en memoria de multer y
 * se borra apenas termina el llamado: no hay camino que lo escriba a disco.
 *
 * Especificación: `.../ai-voice-server-fallback-backend/spec.md`.
 * Diseño: `design.md` D2, D3, D4. `apps/api` es CommonJS: imports sin `.js`.
 */

/** Piso de la reserva, en segundos (D4). */
const MIN_RESERVATION_SECONDS = 60;

/**
 * Plazo del pedido de transcripción (tarea 2.6). El audio ya viajó al
 * proveedor, así que un plazo agotado NO libera la reserva: la fila queda
 * `FAILED` y el dinero ya se gastó.
 */
export const TRANSCRIPTION_DEADLINE_MS = 30_000;

/** El archivo en memoria que deja multer (`FileInterceptor`, D3). */
export interface UploadedAudio {
  readonly buffer: Buffer;
  readonly mimetype: string;
}

/** Lo que puede devolver `POST .../ai/transcriptions`. */
export type AiTranscriptionOutcome =
  | { readonly kind: 'result'; readonly result: AiTranscriptionResult }
  | { readonly kind: 'frozen' }
  | { readonly kind: 'unavailable'; readonly reason: AiTranscriptionUnavailableReason | null }
  | { readonly kind: 'unsupported_type' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'spend_rejected'; readonly rejection: SpendRejection };

@Injectable()
export class AiTranscriptionService {
  private readonly log = new Logger(AiTranscriptionService.name);

  constructor(
    @Inject(AI_ENV) private readonly env: AiEnvironment,
    private readonly spend: AiSpendService,
    private readonly content: DiagramContentService,
  ) {}

  /**
   * Corre las guardas, reserva, llama al proveedor y liquida. `cancelSignal` la
   * produce el CONTROLADOR desde `res.on('close')`: es lo único que distingue
   * una cancelación del cliente de un plazo agotado.
   */
  async transcribe(
    projectId: string,
    diagramId: string,
    user: CurrentUserPayload,
    dto: { readonly language: AiTranscriptionLanguage },
    audio: UploadedAudio,
    cancelSignal: AbortSignal,
  ): Promise<AiTranscriptionOutcome> {
    // 1. Congelado ANTES de todo lo que cuesta: se lee la FILA, la misma que
    //    mira el pipeline de escritura, y no se escribe ninguna fila nueva.
    const snapshot = await this.content.getDiagramContent(diagramId);
    if (snapshot.diagram.lockState !== 'UNLOCKED') return { kind: 'frozen' };

    // 2. Límite de ritmo PROPIO (advisory acá, autoritativo dentro de openTurn).
    const limited = await this.spend.transcriptionRateLimit(projectId, user.id);
    if (limited !== null) return { kind: 'spend_rejected', rejection: limited };

    // 3. Disponibilidad del proveedor/modelo activo.
    const transcription: AiTranscriptionEnvironment = this.env.transcription;
    const view = transcription.view;
    const transcriber = transcription.transcriber;
    const price = transcription.pricePerMinuteUsd;
    const provider = view.provider;
    const model = view.model;
    if (!view.available || transcriber === null || price === null || provider === null || model === null) {
      return { kind: 'unavailable', reason: view.reason };
    }

    // 4. MIME declarado + firma de bytes. La firma tiene que COINCIDIR con el
    //    tipo declarado, y ese tipo tiene que estar entre los verificados.
    const declared = baseMediaType(audio.mimetype);
    const detected = detectAudioSignature(audio.buffer);
    if (
      declared === null ||
      detected === null ||
      detected !== declared ||
      !view.acceptedMediaTypes.includes(detected)
    ) {
      this.log.warn(
        `transcripción rechazada por tipo: declarado="${audio.mimetype}", firma=${detected ?? 'desconocida'}`,
      );
      return { kind: 'unsupported_type' };
    }

    // 5. Reserva por bytes al PEOR bitrate (PO-A), al mismo lock y techo que el
    //    resto del libro. `openTurn` vuelve a chequear el ritmo y el techo de
    //    forma atómica antes de insertar el `PENDING`.
    const seconds = reservationSeconds(audio.buffer.length);
    const estimate = this.costFor(seconds, price);
    const opened = await this.spend.openTurn({
      projectId,
      diagramId,
      userId: user.id,
      inputMode: 'VOICE',
      promptText: TRANSCRIPTION_PROMPT_TEXT,
      model: { provider, model },
      estimate,
      kind: 'transcription',
    });
    if (!opened.ok) return { kind: 'spend_rejected', rejection: opened };
    const turnId = opened.turnId;

    // 6. El llamado, con el plazo de 30 s y la cancelación del cliente.
    const effective = AbortSignal.any([cancelSignal, AbortSignal.timeout(TRANSCRIPTION_DEADLINE_MS)]);
    const startedAt = Date.now();
    const outcome = await this.runTranscription(transcriber, audio, dto.language, effective);
    const latencyMs = Date.now() - startedAt;

    if (!outcome.ok) {
      // Una cancelación no es un fallo del proveedor: la reserva queda igual en
      // los dos casos, pero el estado de la fila es distinto.
      if (outcome.kind === 'aborted' && cancelSignal.aborted) {
        await this.close(turnId, 'CANCELLED', 'cancelada por el cliente', provider, model, latencyMs);
        return { kind: 'cancelled' };
      }
      await this.close(turnId, 'FAILED', outcome.message, provider, model, latencyMs);
      return { kind: outcome.kind === 'empty' ? 'empty' : 'failed' };
    }

    // Texto vacío con `ok: true`: mismo trato que `NoTranscriptGeneratedError`.
    if (outcome.text.trim().length === 0) {
      await this.close(turnId, 'FAILED', 'el proveedor devolvió texto vacío', provider, model, latencyMs);
      return { kind: 'empty' };
    }

    // 7. Liquidación (D4): con duración real se ajusta el costo; sin ella la
    //    reserva por bytes QUEDA como costo final (fail-closed). En la práctica
    //    el proveedor por defecto no informa duración, así que este es el caso
    //    normal y no un error.
    if (outcome.durationSeconds !== null) {
      await this.spend.settleCall({
        turnId,
        estimate,
        actual: {
          costUsd: this.costFor(outcome.durationSeconds, price),
          inputTokens: 0,
          outputTokens: 0,
        },
      });
    }

    const costUsd = await this.close(turnId, 'APPLIED', null, provider, model, latencyMs);
    return {
      kind: 'result',
      result: { turnId, text: outcome.text, costUsd, provider, model },
    };
  }

  /** Llama al transcriptor y borra el buffer SIEMPRE, haya éxito o error. */
  private async runTranscription(
    transcriber: NonNullable<AiTranscriptionEnvironment['transcriber']>,
    audio: UploadedAudio,
    lang: AiTranscriptionLanguage,
    signal: AbortSignal,
  ): Promise<TranscriptionOutcome> {
    try {
      return await transcriber.transcribe(audio.buffer, lang, signal);
    } finally {
      audio.buffer.fill(0);
    }
  }

  /** Cierra la fila con el proveedor/modelo del STT y devuelve el costo final. */
  private close(
    turnId: string,
    status: 'APPLIED' | 'FAILED' | 'CANCELLED',
    errorMessage: string | null,
    provider: AiProviderId,
    model: string,
    latencyMs: number,
  ): Promise<string> {
    return this.spend.closeTurn({
      turnId,
      status,
      provider,
      model,
      fallbackFired: false,
      fallbackFrom: null,
      latencyMs,
      // `iterations` es del bucle de herramientas: una transcripción no tiene
      // bucle, así que queda en 0 como el default de la columna.
      iterations: 0,
      errorMessage,
    });
  }

  /** `segundos/60 × precio por minuto`, con `Prisma.Decimal` — nunca `number`. */
  private costFor(seconds: number, pricePerMinuteUsd: string): Prisma.Decimal {
    return new Prisma.Decimal(seconds).mul(pricePerMinuteUsd).div(60);
  }
}

/**
 * Duración a reservar por un audio de `bytes`, al PEOR bitrate (PO-A).
 *
 * `ceil(bytes × 8 / WORST_CASE_AUDIO_BPS)` con piso de `MIN_RESERVATION_SECONDS`.
 * Para 1 MiB da 1 399 s; para un clip de 45 kB o menos, los 60 s del piso.
 */
export function reservationSeconds(bytes: number): number {
  const byWorstBitrate = Math.ceil((bytes * 8) / WORST_CASE_AUDIO_BPS);
  return Math.max(MIN_RESERVATION_SECONDS, byWorstBitrate);
}

/**
 * El tipo base del MIME declarado, ya sin parámetros.
 *
 * El navegador manda `audio/webm;codecs=opus`, así que comparar la cadena
 * entera contra el catálogo fallaría por el `codecs`. Se corta en el `;`.
 */
function baseMediaType(declared: string): AiAudioMediaType | null {
  const base = declared.split(';', 1)[0]?.trim().toLowerCase();
  if (base === 'audio/webm' || base === 'audio/ogg' || base === 'audio/mp4') return base;
  return null;
}

/**
 * El tipo que dicen los PRIMEROS BYTES, con las mismas firmas que usa el SDK
 * (D2): EBML `1A 45 DF A3` para WebM, `OggS` para Ogg y `ftyp` en el offset 4
 * para MP4. `null` significa "ninguna firma conocida": eso es un `415`, nunca
 * un pase al proveedor.
 */
function detectAudioSignature(bytes: Uint8Array): AiAudioMediaType | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return 'audio/ogg';
  }
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return 'audio/mp4';
  }
  return null;
}

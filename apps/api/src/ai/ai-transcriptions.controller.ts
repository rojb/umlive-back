import {
  Catch,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { FileInterceptor, type MulterModuleOptions } from '@nestjs/platform-express';
import { AI_ERROR, AI_TURN_ERROR, type AiTranscriptionResult } from '@umlive/contracts';
import type { Response } from 'express';
import multer from 'multer';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { spendRejectionToHttp } from './ai.controller';
import { AiTranscriptionService, type AiTranscriptionOutcome, type UploadedAudio } from './ai-transcription.service';
import { TranscriptionQueryDto } from './dto/transcription-query.dto';
import { AUDIO_MAX_BYTES } from './providers/provider-catalog';

/**
 * La ruta de la transcripción de voz (M6, rebanada 4/4 — FR-D20, D2/D3).
 *
 * | Ruta | Acción |
 * |---|---|
 * | `POST .../diagrams/:diagramId/ai/transcriptions` | `ai.use` |
 *
 * ── El `FileInterceptor` va a NIVEL DE RUTA, con `memoryStorage()` ──────────
 *
 * Las opciones locales PISAN las de cualquier `MulterModule` global
 * (`file.interceptor.js:16-19`). Si alguien registrara un módulo con `dest`, el
 * audio de un usuario terminaría escrito en disco — exactamente lo que esta
 * rebanada no puede hacer. Declarar `storage: memoryStorage()` acá hace que el
 * archivo viva solo en `file.buffer` y muera con el pedido, pase lo que pase
 * con la configuración global.
 *
 * Los límites NO tienen default en multer: `fileSize: 1 MiB` es de esta ruta,
 * `files: 1` cierra la variante de muchos archivos, y `fields: 0` / `parts: 1`
 * prohíben cualquier campo de texto en el multipart (el idioma viaja en la
 * query). Un `LIMIT_FILE_SIZE` se traduce a `413 { code, limitBytes }`.
 *
 * ── El orden de Nest ───────────────────────────────────────────────────────
 *
 * El guard de `ai.use` corre ANTES que el interceptor: a un no miembro se lo
 * rechaza con `403` sin que multer lea un byte. Después vienen las guardas del
 * servicio (D2-D4), ya con el archivo en memoria.
 *
 * Especificación: `.../ai-voice-server-fallback-backend/spec.md`.
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Límites de multer de la ruta: un archivo, cero campos, una parte (D3). */
export const AUDIO_MULTER_LIMITS = {
  fileSize: AUDIO_MAX_BYTES,
  files: 1,
  fields: 0,
  parts: 1,
} as const;

/**
 * Las opciones de multer, con `memoryStorage()` EXPLÍCITO (D3): el audio nunca
 * toca el disco, ni siquiera si otro módulo registra un `MulterModule` con
 * `dest`.
 */
export const TRANSCRIPTION_MULTER_OPTIONS: MulterModuleOptions = {
  storage: multer.memoryStorage(),
  limits: { ...AUDIO_MULTER_LIMITS },
};

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Traduce el `PayloadTooLargeException` que Nest produce a partir del
 * `LIMIT_FILE_SIZE` de multer. Acotado a este controlador: en una ruta que solo
 * recibe `multipart`, la única fuente de un `413` es el tope del archivo.
 */
@Catch(PayloadTooLargeException)
export class TranscriptionAudioTooLargeFilter implements ExceptionFilter {
  private readonly log = new Logger(TranscriptionAudioTooLargeFilter.name);

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    this.log.warn(`transcripción rechazada por tamaño: el tope es ${AUDIO_MAX_BYTES} bytes`);
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
      code: AI_ERROR.AI_AUDIO_TOO_LARGE,
      limitBytes: AUDIO_MAX_BYTES,
      message: `El audio supera el límite de ${Math.floor(AUDIO_MAX_BYTES / (1024 * 1024))} MB por transcripción.`,
    });
  }
}

@Controller('projects/:projectId/diagrams/:diagramId/ai')
export class AiTranscriptionsController {
  constructor(private readonly transcriptions: AiTranscriptionService) {}

  @Post('transcriptions')
  @RequiresProjectAction('ai.use')
  @UseInterceptors(FileInterceptor('audio', TRANSCRIPTION_MULTER_OPTIONS))
  @UseFilters(TranscriptionAudioTooLargeFilter)
  @HttpCode(HttpStatus.OK)
  async transcribe(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query() dto: TranscriptionQueryDto,
    @UploadedFile() audio: UploadedAudio | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiTranscriptionResult | Record<string, unknown> | void> {
    // La cancelación (D4): el cliente corta la conexión. `!res.writableEnded`
    // distingue "el cliente se fue" de "la respuesta terminó bien", que también
    // dispara `close` en algunos runtimes. Un pedido sin archivo llega con un
    // buffer vacío y cae en `415`, no en un `500`.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const received: UploadedAudio = {
      buffer: audio?.buffer ?? Buffer.alloc(0),
      mimetype: audio?.mimetype ?? '',
    };

    const outcome = await this.transcriptions.transcribe(projectId, diagramId, user, dto, received, abort.signal);
    return transcriptionHttp(outcome, res);
  }
}

/**
 * Traducción HTTP del resultado de una transcripción. Todas las guardas viajan
 * como error HTTP `{ code }`: ninguna escribió una fila en `ai_turns` ni llamó
 * al proveedor. Lo único que responde `200` es una transcripción que llegó al
 * proveedor y volvió con texto.
 */
function transcriptionHttp(
  outcome: AiTranscriptionOutcome,
  res: Response,
): AiTranscriptionResult | Record<string, unknown> | void {
  switch (outcome.kind) {
    case 'result':
      return outcome.result;
    case 'frozen':
      res.status(HttpStatus.LOCKED);
      return { code: AI_TURN_ERROR.DIAGRAM_FROZEN };
    case 'unavailable':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_ERROR.AI_TRANSCRIPTION_UNAVAILABLE, reason: outcome.reason };
    case 'unsupported_type':
      res.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
      return { code: AI_ERROR.AI_AUDIO_UNSUPPORTED_TYPE };
    case 'empty':
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
      return { code: AI_ERROR.AI_TRANSCRIPTION_EMPTY };
    case 'failed':
      res.status(HttpStatus.BAD_GATEWAY);
      return { code: AI_ERROR.AI_TRANSCRIPTION_FAILED };
    case 'cancelled':
      // El cliente cerró la conexión: no hay a quién responderle. La fila ya
      // quedó `CANCELLED` con su reserva en pie.
      return undefined;
    case 'spend_rejected': {
      const http = spendRejectionToHttp(outcome.rejection);
      res.status(http.status);
      for (const [name, value] of Object.entries(http.headers)) res.setHeader(name, value);
      return http.body;
    }
  }
}

import { IsIn } from 'class-validator';
import type { AiTranscriptionLanguage } from '@umlive/contracts';

/**
 * Query de `POST .../ai/transcriptions` (M6, rebanada 4/4, tarea 2.7).
 *
 * El idioma viaja en la QUERY y no en el `multipart`, porque la parte multipart
 * no lleva ningún otro campo: `FileInterceptor` está configurado con
 * `fields: 0` y `parts: 1`, así que no hay dónde ponerlo sin abrir la puerta a
 * campos de texto.
 *
 * `language` es obligatorio y solo acepta los dos valores que el producto
 * define (FR-D20): `es-ES` y `es-419`. Con `forbidNonWhitelisted` global,
 * cualquier otro valor —o cualquier query de más— responde `400` antes de leer
 * un byte del archivo.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */
const TRANSCRIPTION_LANGUAGES: readonly AiTranscriptionLanguage[] = ['es-ES', 'es-419'];

export class TranscriptionQueryDto {
  @IsIn(TRANSCRIPTION_LANGUAGES)
  language!: AiTranscriptionLanguage;
}

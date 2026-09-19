import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { AiImageMode } from '@umlive/contracts';

/**
 * Los campos de TEXTO del `multipart` de planificación (M6, rebanada 3/4 —
 * `ai-image-input`, tarea 2.4). La imagen viaja en el mismo `multipart`, en el
 * campo `image`, y la consume multer: acá solo queda lo que el usuario escribió.
 *
 * ── Por qué el tope de 2000 es del DTO y no del prompt ──────────────────────
 *
 * Es la misma razón que en el turno de texto: un turno es UNA instrucción, y un
 * texto de 100 kB no es una instrucción — es una carga que se paga por token
 * antes de que nadie la mire. El mínimo de 1 rechaza un `prompt` vacío.
 *
 * `mode` es `create` o `modify` (PO-4): crear solo se habilita sobre un diagrama
 * vacío, y modificar nunca borra ni mueve lo que ya existe (PO-3). El modo se
 * valida acá y se vuelve a comprobar contra el diagrama en el servicio, porque
 * entre el pedido y la lectura del contenido el diagrama pudo cambiar.
 *
 * El `ValidationPipe` global (`main.ts`, `whitelist` + `forbidNonWhitelisted`)
 * aplica estos decoradores: un campo de más en el `multipart` es un `400`, no un
 * silencio.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

const IMAGE_MODES: readonly AiImageMode[] = ['create', 'modify'];

export class AiImageTurnDto {
  @IsIn(IMAGE_MODES)
  mode!: AiImageMode;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  prompt?: string;
}

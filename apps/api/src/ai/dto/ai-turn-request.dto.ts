import { IsIn, IsString, Length } from 'class-validator';
import type { AiTurnInputMode, AiTurnRequest } from '@umlive/contracts';

/**
 * Cuerpo de `POST .../ai/turns` (M6, rebanada 2/4 — `ai-text-instructions`,
 * tarea 5.9).
 *
 * `prompt` va de 1 a 2000 caracteres. El tope es del DTO y no del prompt de
 * sistema: un turno es UNA instrucción, y un texto de 100 kB no es una
 * instrucción — es una carga que se paga por token antes de que nadie la mire.
 * El mínimo de 1 rechaza el envío vacío sin dejar que el proveedor cobre por
 * nada.
 *
 * `inputMode` es `TEXT` o `VOICE` (`AiTurnInputMode`). `IMAGE` existe en la
 * tabla `ai_turns` y es de `ai-image-input`, no de acá: aceptarlo por esta ruta
 * sería aceptar un turno de imagen sin imagen.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */
const INPUT_MODES: readonly AiTurnInputMode[] = ['TEXT', 'VOICE'];

export class AiTurnRequestDto implements AiTurnRequest {
  @IsString()
  @Length(1, 2000)
  prompt!: string;

  @IsIn(INPUT_MODES)
  inputMode!: AiTurnInputMode;
}

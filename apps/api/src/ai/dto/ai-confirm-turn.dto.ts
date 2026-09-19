import { ArrayUnique, IsArray, IsInt, Min } from 'class-validator';
import type { AiConfirmTurnRequest } from '@umlive/contracts';

/**
 * El cuerpo de `POST …/ai/turns/:turnId/confirm` (M6, rebanada 3/4 —
 * `ai-image-input`, tarea 2.4).
 *
 * `excluded` son los índices que el usuario DESTILDÓ en la vista previa. Acá
 * solo se valida su FORMA —enteros, únicos, no negativos—; el rango real depende
 * del plan que el servidor tiene en memoria, así que lo comprueba el servicio
 * contra su propia vista previa y responde `400 ai_preview_item_unknown` si
 * alguno no existe (D6). Un DTO no puede saber cuántos ítems tiene el plan.
 *
 * Que venga la lista entera y no un delta es a propósito: el servidor recalcula
 * el cierre de exclusiones sobre SU plan (PO-2), así que un cliente que manda
 * solo la clase excluida igual se lleva sus atributos.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */
export class AiConfirmTurnDto implements AiConfirmTurnRequest {
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  excluded!: number[];
}

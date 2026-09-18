import { IsUUID, ValidateIf } from 'class-validator';
import type { SetElementParentRequest } from '@umlive/contracts';

/**
 * `parentId: string | null` — mismo patrón `ValidateIf` que
 * `CreateElementDto.parentId` (design.md §3, §5). La regla de padre por
 * `kind` del hijo (D4) y la guarda de ciclo de contención (D1, D3) corren
 * en el servicio, dentro de la misma transacción que el `UPDATE` — nunca
 * acá, porque dependen de estado persistido, no de la forma del cuerpo.
 */
export class SetElementParentDto implements SetElementParentRequest {
  @ValidateIf((o: SetElementParentDto) => o.parentId !== null)
  @IsUUID('4')
  parentId!: string | null;
}

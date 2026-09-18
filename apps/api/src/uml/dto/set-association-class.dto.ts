import { IsUUID, ValidateIf } from 'class-validator';
import type { SetAssociationClassRequest } from '@umlive/contracts';

/**
 * `elementId: string | null` — mismo patrón `ValidateIf` que
 * `SetElementParentDto.parentId` (design.md D5). `null` = desligar. Las
 * comprobaciones que dependen de estado persistido (existe en el diagrama,
 * `kind === 'CLASS'`, no es uno de los dos extremos) corren en el servicio,
 * dentro de la misma transacción que el `UPDATE` — nunca acá.
 */
export class SetAssociationClassDto implements SetAssociationClassRequest {
  @ValidateIf((o: SetAssociationClassDto) => o.elementId !== null)
  @IsUUID('4')
  elementId!: string | null;
}

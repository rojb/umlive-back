import { IsString, MaxLength, ValidateIf } from 'class-validator';
import type { SetRelationshipStereotypeRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/** Idéntico a `SetElementStereotypeDto` (design.md D10) — misma normalización en las dos rutas. */
export class SetRelationshipStereotypeDto implements SetRelationshipStereotypeRequest {
  @ValidateIf((o: SetRelationshipStereotypeDto) => o.stereotype !== null)
  @IsString()
  @MaxLength(200)
  @NoNulBytes()
  stereotype!: string | null;
}

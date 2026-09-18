import { IsInt, Min, ValidateIf } from 'class-validator';
import type { SetEndMultiplicityRequest } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';

/**
 * `upperBound` acepta `null` (`*`) y "sin definir" (`undefined`) sin
 * rechazarlos acá — `RelationshipsService.setEndMultiplicity` normaliza
 * `undefined → null` antes de escribir, así los dos casos de SC-B09 llegan a
 * `ck_composite_multiplicity` como el mismo `NULL` (D2: la CHECK es el único
 * punto de aplicación, nunca el DTO).
 */
export class SetEndMultiplicityDto implements SetEndMultiplicityRequest {
  @IsInt()
  @Min(0)
  @IsInt32Range()
  lowerBound!: number;

  @ValidateIf((o: SetEndMultiplicityDto) => o.upperBound !== null && o.upperBound !== undefined)
  @IsInt()
  @IsInt32Range()
  upperBound!: number | null;
}

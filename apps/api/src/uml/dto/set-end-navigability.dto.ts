import { IsBoolean } from 'class-validator';
import type { SetEndNavigabilityRequest } from '@umlive/contracts';

export class SetEndNavigabilityDto implements SetEndNavigabilityRequest {
  @IsBoolean()
  isNavigable!: boolean;
}

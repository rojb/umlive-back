import { IsBoolean } from 'class-validator';
import type { SetElementAbstractRequest } from '@umlive/contracts';

export class SetElementAbstractDto implements SetElementAbstractRequest {
  @IsBoolean()
  isAbstract!: boolean;
}

import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { SetElementBodyRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/** El servicio rechaza con `409 body_requires_comment` si `kind !== 'COMMENT'` (§3). */
export class SetElementBodyDto implements SetElementBodyRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  @NoNulBytes()
  body!: string;
}

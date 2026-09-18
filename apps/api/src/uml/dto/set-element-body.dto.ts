import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { SetElementBodyRequest } from '@umlive/contracts';

/** El servicio rechaza con `409 body_requires_comment` si `kind !== 'COMMENT'` (§3). */
export class SetElementBodyDto implements SetElementBodyRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body!: string;
}

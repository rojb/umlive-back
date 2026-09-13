import { IsString, MinLength } from 'class-validator';
import type { RenameElementRequest } from '@umlive/contracts';

/** `ck_element_named` exige `length(btrim(name)) > 0` para todo lo que no sea `COMMENT`. */
export class RenameElementDto implements RenameElementRequest {
  @IsString()
  @MinLength(1)
  name!: string;
}

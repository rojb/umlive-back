import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { EditableParameterDirection, UpdateParameterRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

const EDITABLE_DIRECTIONS: EditableParameterDirection[] = ['IN', 'OUT', 'INOUT'];

/** Igual que `AddParameterDto`: `direction` nunca acepta `RETURN` (design.md §7). */
export class UpdateParameterDto implements UpdateParameterRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name?: string;

  @IsOptional()
  @IsIn(EDITABLE_DIRECTIONS)
  direction?: EditableParameterDirection;

  @IsOptional()
  @IsUUID('4')
  typeElementId?: string | null;

  @IsOptional()
  @IsString()
  @NoNulBytes()
  typeName?: string | null;

  @IsOptional()
  @IsString()
  @NoNulBytes()
  defaultValue?: string | null;
}

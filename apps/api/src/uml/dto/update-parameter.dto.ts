import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { EditableParameterDirection, UpdateParameterRequest } from '@umlive/contracts';

const EDITABLE_DIRECTIONS: EditableParameterDirection[] = ['IN', 'OUT', 'INOUT'];

/** Igual que `AddParameterDto`: `direction` nunca acepta `RETURN` (design.md §7). */
export class UpdateParameterDto implements UpdateParameterRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(EDITABLE_DIRECTIONS)
  direction?: EditableParameterDirection;

  @IsOptional()
  @IsUUID('4')
  typeElementId?: string | null;

  @IsOptional()
  @IsString()
  typeName?: string | null;

  @IsOptional()
  @IsString()
  defaultValue?: string | null;
}

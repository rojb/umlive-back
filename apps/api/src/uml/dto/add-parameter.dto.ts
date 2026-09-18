import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { AddParameterRequest, EditableParameterDirection } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

const EDITABLE_DIRECTIONS: EditableParameterDirection[] = ['IN', 'OUT', 'INOUT'];

/**
 * `direction` valida contra `EditableParameterDirection`, no contra
 * `ParameterDirection` — rechaza `RETURN` con `400 class-validator`, antes
 * del servicio y mucho antes de la base (design.md §7, spec "Tipo de
 * retorno canónico, y el parámetro RETURN queda prohibido en toda
 * mutación"). Único punto que lo impide: la base permite exactamente un
 * `RETURN` por operación, pero no prohíbe que exista.
 */
export class AddParameterDto implements AddParameterRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name!: string;

  @IsIn(EDITABLE_DIRECTIONS)
  direction!: EditableParameterDirection;

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

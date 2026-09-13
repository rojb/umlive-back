import { IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { AddParameterRequest, EditableParameterDirection } from '@umlive/contracts';

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
  name!: string;

  @IsIn(EDITABLE_DIRECTIONS)
  direction!: EditableParameterDirection;

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

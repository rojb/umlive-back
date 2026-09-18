import { IsString, MaxLength, MinLength } from 'class-validator';
import type { AddEnumLiteralRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/**
 * `position` la asigna el servicio al agregar, igual que en
 * features/parámetros. `@MaxLength(120)`/`@NoNulBytes()` (verify-report
 * 2026-09-18, RW-4): mismo motivo que `RenameElementDto` —
 * `uml_enum_literals_enumeration_id_name_key` es otro índice único sobre
 * `name`.
 */
export class AddEnumLiteralDto implements AddEnumLiteralRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name!: string;
}

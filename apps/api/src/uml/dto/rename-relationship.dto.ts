import { IsString, MaxLength } from 'class-validator';
import type { RenameRelationshipRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/**
 * A diferencia de `RenameElementDto`, sin `@MinLength(1)`: no hay ninguna
 * `CHECK` que exija nombre no vacío para `uml_relationships` (`name` es
 * nullable y opcional en el modelo, a diferencia de `ck_element_named`).
 * `@MaxLength(120)`/`@NoNulBytes()` (verify-report 2026-09-18, RW-4): mismo
 * motivo que `RenameElementDto`.
 */
export class RenameRelationshipDto implements RenameRelationshipRequest {
  @IsString()
  @MaxLength(120)
  @NoNulBytes()
  name!: string;
}

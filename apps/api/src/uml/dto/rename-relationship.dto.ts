import { IsString } from 'class-validator';
import type { RenameRelationshipRequest } from '@umlive/contracts';

/**
 * A diferencia de `RenameElementDto`, sin `@MinLength(1)`: no hay ninguna
 * `CHECK` que exija nombre no vacío para `uml_relationships` (`name` es
 * nullable y opcional en el modelo, a diferencia de `ck_element_named`).
 */
export class RenameRelationshipDto implements RenameRelationshipRequest {
  @IsString()
  name!: string;
}

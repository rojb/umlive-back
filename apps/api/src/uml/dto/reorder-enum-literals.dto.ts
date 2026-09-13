import { ArrayUnique, IsArray, IsUUID } from 'class-validator';
import type { ReorderEnumLiteralsRequest } from '@umlive/contracts';

/** Una sola sentencia `VALUES`, sin guarda de conjunto: `uml_enum_literals` no tiene único de posición (design.md §5). */
export class ReorderEnumLiteralsDto implements ReorderEnumLiteralsRequest {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  orderedLiteralIds!: string[];
}

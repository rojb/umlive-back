import { ArrayUnique, IsArray, IsUUID } from 'class-validator';
import type { ReorderFeaturesRequest } from '@umlive/contracts';

/**
 * Orden completo, nunca un delta (design.md §5). `@ArrayUnique()` es una
 * barrera barata en el borde; NO sustituye la comprobación de conjunto real
 * contra la base — esa solo hace falta en `reorderParameters` (§5,
 * `uml_parameters` tiene único de posición; `uml_features` no).
 */
export class ReorderFeaturesDto implements ReorderFeaturesRequest {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  orderedFeatureIds!: string[];
}

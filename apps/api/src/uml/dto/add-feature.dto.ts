import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { AddFeatureRequest, FeatureKind, Visibility } from '@umlive/contracts';

const FEATURE_KINDS: FeatureKind[] = ['ATTRIBUTE', 'OPERATION'];
const VISIBILITIES: Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE'];

/**
 * `position` NO viaja acá: el servicio la asigna, creciente y persistente
 * por dueño (design.md, requisito "Alta de clasificador con miembros
 * ordenados"; tasks.md 3.3). Reordenar es una función aparte
 * (`ReorderFeaturesDto`).
 */
export class AddFeatureDto implements AddFeatureRequest {
  @IsIn(FEATURE_KINDS)
  kind!: FeatureKind;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsIn(VISIBILITIES)
  visibility!: Visibility;

  @IsOptional()
  @IsUUID('4')
  typeElementId?: string | null;

  @IsOptional()
  @IsString()
  typeName?: string | null;

  @IsOptional()
  @IsInt()
  lowerBound?: number;

  @IsOptional()
  @IsInt()
  upperBound?: number | null;

  @IsOptional()
  @IsBoolean()
  isStatic?: boolean;

  @IsOptional()
  @IsBoolean()
  isReadonly?: boolean;

  @IsOptional()
  @IsBoolean()
  isDerived?: boolean;

  @IsOptional()
  @IsBoolean()
  isAbstract?: boolean;

  @IsOptional()
  @IsBoolean()
  isQuery?: boolean;

  @IsOptional()
  @IsString()
  defaultValue?: string | null;
}

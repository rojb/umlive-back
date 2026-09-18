import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { AddFeatureRequest, FeatureKind, Visibility } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';
import { NoNulBytes } from './no-nul-bytes.decorator';

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
  @MaxLength(120)
  @NoNulBytes()
  name!: string;

  @IsIn(VISIBILITIES)
  visibility!: Visibility;

  @IsOptional()
  @IsUUID('4')
  typeElementId?: string | null;

  @IsOptional()
  @IsString()
  @NoNulBytes()
  typeName?: string | null;

  @IsOptional()
  @IsInt()
  @IsInt32Range()
  lowerBound?: number;

  @IsOptional()
  @IsInt()
  @IsInt32Range()
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
  @NoNulBytes()
  defaultValue?: string | null;
}

import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import type { UpdateFeatureRequest, Visibility } from '@umlive/contracts';

const VISIBILITIES: Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE'];

/** `kind` no es editable después de creado (`UpdateFeatureRequest = Partial<Omit<AddFeatureRequest,'kind'>>`). */
export class UpdateFeatureDto implements UpdateFeatureRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: Visibility;

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

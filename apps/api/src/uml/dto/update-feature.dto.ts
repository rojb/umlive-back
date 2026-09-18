import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { UpdateFeatureRequest, Visibility } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';
import { NoNulBytes } from './no-nul-bytes.decorator';

const VISIBILITIES: Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE'];

/** `kind` no es editable después de creado (`UpdateFeatureRequest = Partial<Omit<AddFeatureRequest,'kind'>>`). */
export class UpdateFeatureDto implements UpdateFeatureRequest {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name?: string;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: Visibility;

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

import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { AggregationKind, CreateRelationshipEndRequest, CreateRelationshipRequest, RelationshipKind } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';
import { NoNulBytes } from './no-nul-bytes.decorator';

const RELATIONSHIP_KINDS: RelationshipKind[] = ['ASSOCIATION', 'GENERALIZATION', 'INTERFACE_REALIZATION', 'DEPENDENCY', 'USAGE'];
const AGGREGATION_KINDS: AggregationKind[] = ['NONE', 'SHARED', 'COMPOSITE'];

/**
 * Un extremo de `ends` — solo tiene sentido cuando `kind === 'ASSOCIATION'`
 * (D4). `upperBound` es requerido por el tipo (`number | null`) pero acepta
 * `null` (`*`) y también "sin definir" (`undefined`): el DTO NO rechaza
 * ninguno de los dos — `ck_composite_multiplicity` es el único punto de
 * aplicación de SC-B09 (D2). `RelationshipsService.createRelationship`
 * normaliza `undefined → null` antes de escribir, así ambos casos llegan a
 * la base como el mismo `NULL` y producen el mismo `409`.
 */
export class CreateRelationshipEndDto implements CreateRelationshipEndRequest {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @NoNulBytes()
  roleName?: string | null;

  @IsInt()
  @Min(0)
  @IsInt32Range()
  lowerBound!: number;

  @ValidateIf((o: CreateRelationshipEndDto) => o.upperBound !== null && o.upperBound !== undefined)
  @IsInt()
  @IsInt32Range()
  upperBound!: number | null;

  @IsBoolean()
  isNavigable!: boolean;

  @IsIn(AGGREGATION_KINDS)
  aggregation!: AggregationKind;
}

/**
 * `ends` MUST venir solo si `kind === 'ASSOCIATION'` (D4) — la regla de
 * cruce con `kind` no la puede expresar `class-validator` a nivel de campo
 * (depende de otro campo del mismo objeto), así que `RelationshipsService`
 * es quien responde `400` si `ends` llega junto con cualquier otro `kind`.
 */
export class CreateRelationshipDto implements CreateRelationshipRequest {
  @IsIn(RELATIONSHIP_KINDS)
  kind!: RelationshipKind;

  @IsUUID('4')
  sourceElementId!: string;

  @IsUUID('4')
  targetElementId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @NoNulBytes()
  name?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateRelationshipEndDto)
  ends?: [CreateRelationshipEndRequest, CreateRelationshipEndRequest];
}

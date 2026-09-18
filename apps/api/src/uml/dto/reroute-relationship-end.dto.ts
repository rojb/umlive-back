import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { RerouteRelationshipEndRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/** Misma forma para `.../source` y `.../target` (design.md §6). */
export class RerouteRelationshipEndDto implements RerouteRelationshipEndRequest {
  @IsUUID('4')
  elementId!: string;

  @IsOptional()
  @IsString()
  @NoNulBytes()
  anchor?: string | null;
}

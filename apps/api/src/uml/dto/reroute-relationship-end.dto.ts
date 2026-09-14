import { IsOptional, IsString, IsUUID } from 'class-validator';
import type { RerouteRelationshipEndRequest } from '@umlive/contracts';

/** Misma forma para `.../source` y `.../target` (design.md §6). */
export class RerouteRelationshipEndDto implements RerouteRelationshipEndRequest {
  @IsUUID('4')
  elementId!: string;

  @IsOptional()
  @IsString()
  anchor?: string | null;
}

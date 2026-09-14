import { IsString, ValidateIf } from 'class-validator';
import type { SetRelationshipAnchorsRequest } from '@umlive/contracts';

/** Texto libre sin interpretar (D7) — mapean 1:1 a `sourceHandle`/`targetHandle` de xyflow. */
export class SetRelationshipAnchorsDto implements SetRelationshipAnchorsRequest {
  @ValidateIf((o: SetRelationshipAnchorsDto) => o.sourceAnchor !== null)
  @IsString()
  sourceAnchor!: string | null;

  @ValidateIf((o: SetRelationshipAnchorsDto) => o.targetAnchor !== null)
  @IsString()
  targetAnchor!: string | null;
}

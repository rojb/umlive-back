import { IsString, ValidateIf } from 'class-validator';
import type { SetRelationshipAnchorsRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/**
 * Texto libre sin interpretar (D7) — mapean 1:1 a `sourceHandle`/`targetHandle`
 * de xyflow. `@NoNulBytes()` (verify-report 2026-09-18, RW-4): sin cota de
 * FORMA, un NUL embebido pasaba y reventaba en la escritura con `22021`.
 */
export class SetRelationshipAnchorsDto implements SetRelationshipAnchorsRequest {
  @ValidateIf((o: SetRelationshipAnchorsDto) => o.sourceAnchor !== null)
  @IsString()
  @NoNulBytes()
  sourceAnchor!: string | null;

  @ValidateIf((o: SetRelationshipAnchorsDto) => o.targetAnchor !== null)
  @IsString()
  @NoNulBytes()
  targetAnchor!: string | null;
}

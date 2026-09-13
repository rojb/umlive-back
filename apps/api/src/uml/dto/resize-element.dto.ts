import { IsInt, Min } from 'class-validator';
import type { ResizeElementRequest } from '@umlive/contracts';

/** `@Min(1)` adelanta `ck_layout_size` (`width > 0 AND height > 0`) al borde HTTP (design.md §3). */
export class ResizeElementDto implements ResizeElementRequest {
  @IsInt()
  @Min(1)
  width!: number;

  @IsInt()
  @Min(1)
  height!: number;
}

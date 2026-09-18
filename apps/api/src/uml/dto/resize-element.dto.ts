import { IsInt, Min } from 'class-validator';
import type { ResizeElementRequest } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';

/**
 * `@Min(1)` adelanta `ck_layout_size` (`width > 0 AND height > 0`) al borde
 * HTTP (design.md §3). `@IsInt32Range()` (verify-report 2026-09-18, RW-4):
 * `width: 2^40` pasaba `@IsInt()` y reventaba en la escritura con `P2020`.
 */
export class ResizeElementDto implements ResizeElementRequest {
  @IsInt()
  @Min(1)
  @IsInt32Range()
  width!: number;

  @IsInt()
  @Min(1)
  @IsInt32Range()
  height!: number;
}

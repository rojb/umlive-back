import { IsInt } from 'class-validator';
import type { MoveElementRequest } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';

/**
 * Sin mínimo en ninguno de los dos campos (design.md §3, spec "El servidor
 * no calcula ni completa la geometría del nodo"): el lienzo usa el origen y
 * coordenadas negativas normalmente. `ck_layout_size` no restringe posición.
 * `@IsInt32Range()` (verify-report 2026-09-18, RW-4): `x: 3e9`/`x: 1e308`
 * pasaban `@IsInt()` y reventaban en la escritura con `P2020`, nunca con
 * `MALFORMED`.
 */
export class MoveElementDto implements MoveElementRequest {
  @IsInt()
  @IsInt32Range()
  x!: number;

  @IsInt()
  @IsInt32Range()
  y!: number;
}

import { IsInt } from 'class-validator';
import type { MoveElementRequest } from '@umlive/contracts';

/**
 * Sin mínimo en ninguno de los dos campos (design.md §3, spec "El servidor
 * no calcula ni completa la geometría del nodo"): el lienzo usa el origen y
 * coordenadas negativas normalmente. `ck_layout_size` no restringe posición.
 */
export class MoveElementDto implements MoveElementRequest {
  @IsInt()
  x!: number;

  @IsInt()
  y!: number;
}

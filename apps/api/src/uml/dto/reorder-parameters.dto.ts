import { ArrayUnique, IsArray, IsUUID } from 'class-validator';
import type { ReorderParametersRequest } from '@umlive/contracts';

/**
 * Orden completo de TODOS los parámetros de la operación, nunca un delta
 * (design.md §5). `@ArrayUnique()` acá es solo la barrera barata de forma;
 * la comprobación real de "es exactamente el conjunto existente" (misma
 * cardinalidad, sin faltantes, sin ajenos) vive en `ParametersService`
 * porque solo el servicio conoce el conjunto real en la base (tasks.md 4.3).
 */
export class ReorderParametersDto implements ReorderParametersRequest {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  orderedParameterIds!: string[];
}

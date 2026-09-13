import { IsOptional, IsString, Length } from 'class-validator';
import type { CreateProjectRequest } from '@umlive/contracts';

/**
 * Sin `projectId` ni `role` (FR-A12/INV-2): esta ruta no lleva `:projectId`
 * y el creador siempre pasa a ser `HOST` — no es un valor que el cliente
 * elija. `ck_projects_name` en la base exige 1..120 tras `btrim`; se valida
 * el mismo rango acá para no depender solo del error crudo de Postgres.
 */
export class CreateProjectDto implements CreateProjectRequest {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

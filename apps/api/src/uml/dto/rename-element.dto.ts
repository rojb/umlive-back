import { IsString, MaxLength, MinLength } from 'class-validator';
import type { RenameElementRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/**
 * `ck_element_named` exige `length(btrim(name)) > 0` para todo lo que no
 * sea `COMMENT`. `@MaxLength(120)` (verify-report 2026-09-18, RW-4): sin
 * cota, un nombre de 300 000 caracteres pasaba `class-validator` y
 * reventaba en `uq_element_name_per_parent` con `54000` (fila de índice
 * > 2704 bytes) — mismo tope que `ck_projects_name`/`ck_diagrams_name`
 * (`CreateProjectDto`/`RenameDiagramDto`), aunque acá la CHECK de la base
 * no tenga techo. `@NoNulBytes()`: un NUL embebido pasaba y reventaba con
 * `22021`.
 */
export class RenameElementDto implements RenameElementRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name!: string;
}

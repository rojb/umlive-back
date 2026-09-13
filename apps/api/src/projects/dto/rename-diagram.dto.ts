import { IsString, Length } from 'class-validator';
import type { RenameDiagramRequest } from '@umlive/contracts';

/** Solo `name` es editable en esta rebanada (design.md §6). `ck_diagrams_name` exige 1..120 tras `btrim`. */
export class RenameDiagramDto implements RenameDiagramRequest {
  @IsString()
  @Length(1, 120)
  name!: string;
}

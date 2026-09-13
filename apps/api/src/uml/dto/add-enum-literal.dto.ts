import { IsString, MinLength } from 'class-validator';
import type { AddEnumLiteralRequest } from '@umlive/contracts';

/** `position` la asigna el servicio al agregar, igual que en features/parámetros. */
export class AddEnumLiteralDto implements AddEnumLiteralRequest {
  @IsString()
  @MinLength(1)
  name!: string;
}

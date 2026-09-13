import { IsEmail } from 'class-validator';
import type { AddMemberRequest } from '@umlive/contracts';

/**
 * Solo `email` — no existe búsqueda por nombre de usuario (FR-A08
 * corregido, propuesta contradicción 6). Sin `projectId` ni `role`: el
 * proyecto sale de la ruta y el rol asignado es siempre `PARTICIPANT`
 * (FR-A12/INV-2).
 */
export class AddMemberDto implements AddMemberRequest {
  @IsEmail()
  email!: string;
}

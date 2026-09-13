import { IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH, type ChangePasswordRequest } from '@umlive/contracts';

/**
 * SC-A07 / SC-A08. `currentPassword` no lleva `MinLength`: una contraseña
 * vieja corta (de antes de que existiera esta regla) todavía tiene que poder
 * verificarse para autorizar el cambio.
 */
export class ChangePasswordDto implements ChangePasswordRequest {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  newPassword!: string;
}

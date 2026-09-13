import { IsEmail, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH, type RegisterRequest } from '@umlive/contracts';

/** SC-A01, SC-A02, SC-A03. */
export class RegisterDto implements RegisterRequest {
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @IsEmail()
  email!: string;

  /** SC-A03: menos de `PASSWORD_MIN_LENGTH` no crea usuario. */
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;
}

import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import type { LoginRequest } from '@umlive/contracts';

/**
 * Sin `MinLength(PASSWORD_MIN_LENGTH)` en `password` — a propósito. SC-A04
 * exige que login inválido sea indistinguible; validar longitud acá no
 * ayuda a nadie legítimo (el registro ya la exige) y solo agrega una rama
 * de respuesta distinta que no hace falta.
 */
export class LoginDto implements LoginRequest {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

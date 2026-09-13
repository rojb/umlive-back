import { IsOptional, IsString, IsUrl, Length } from 'class-validator';

/**
 * Solo `displayName`, `avatarUrl`, `locale` (INV-2). El `ValidationPipe`
 * global (`main.ts`) corre con `forbidNonWhitelisted: true`, así que un
 * campo de más ya rebota con `400` antes de llegar acá — este DTO es la
 * lista blanca real.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  displayName?: string;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @IsOptional()
  @IsString()
  @Length(2, 10)
  locale?: string;
}

import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';
import type { GenerateJoinCodeRequest } from '@umlive/contracts';

/**
 * C3: `expiresAt`/`maxUses` opcionales al generar (design.md §2.5 nota /
 * §12) — el formulario de B1 puede no exponerlos en esta rebanada sin que
 * nada se rompa. Sin `projectId` ni `role` (FR-A12/INV-2): esta ruta no
 * lleva `:projectId` en el cuerpo y el creador siempre es quien ya pasó por
 * `ProjectAccessGuard` como `HOST`.
 */
export class GenerateJoinCodeDto implements GenerateJoinCodeRequest {
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;
}

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import type { AiModelRef, AiProviderId, UpdateAiConfigRequest } from '@umlive/contracts';

/**
 * DTO de `PUT .../ai/config` (design D6).
 *
 * Trae SOLO proveedor, modelo y cadena de reserva. La clave BYO (FR-D11) es la
 * Fase 7 y tendría su propio campo de escritura; acá no existe ninguna
 * superficie de clave (SC-D05).
 *
 * La cadena se topea en 3 eslabones: es el mismo tope que aplica el despacho
 * (primario + 3, design D4), así que rechazarlo temprano evita guardar una
 * configuración que después se recortaría en silencio.
 */

/** Los seis proveedores del catálogo (`AiProviderId`). */
const PROVIDER_IDS: readonly AiProviderId[] = [
  'gemini',
  'openai',
  'anthropic',
  'deepseek',
  'moonshot',
  'openai-compatible',
];

export class AiModelRefDto implements AiModelRef {
  @IsIn(PROVIDER_IDS)
  provider!: AiProviderId;

  @IsString()
  @Length(1, 120)
  model!: string;
}

export class UpdateAiConfigDto implements UpdateAiConfigRequest {
  @ValidateNested()
  @Type(() => AiModelRefDto)
  primary!: AiModelRefDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => AiModelRefDto)
  fallbackChain?: AiModelRefDto[];
}

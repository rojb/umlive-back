import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { AiModelRef, AiProviderId, UpdateAiConfigRequest } from '@umlive/contracts';

/**
 * DTO de `PUT .../ai/config` (design D6).
 *
 * Trae proveedor, modelo, cadena de reserva y —desde la tarea 7.3— la clave BYO
 * del proyecto (FR-D11). **La clave es un campo de ESCRITURA**: entra por acá y
 * ninguna vista la devuelve; lo único que una lectura revela es
 * `AiConfigView.hasProjectKey` (SC-D05).
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

  /**
   * Clave BYO del proyecto. `@IsOptional()` de class-validator deja pasar
   * también `null`, que es el borrado explícito (tarea 7.3); una cadena vacía o
   * ausente significa "no mando clave nueva".
   *
   * El tope de 200 caracteres es un tope de FORMA, no una regla de formato: no
   * se puede validar el formato de seis vendors distintos sin inventar reglas, y
   * una regla inventada rechazaría una clave válida. El servicio ignora una
   * cadena vacía o de solo espacios (equivale a "sin clave nueva"), así que
   * tampoco hace falta una longitud mínima acá.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string | null;
}

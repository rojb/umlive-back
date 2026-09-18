import { IsString, MaxLength, ValidateIf } from 'class-validator';
import type { SetElementStereotypeRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/**
 * Cota de FORMA, no la regla de negocio (design.md D10): la regla real —
 * `409 stereotype_invalid` si supera `MAX_STEREOTYPE_LENGTH` (64) — la
 * aplica `normalizeStereotype()` en el servicio, DESPUÉS de quitar los
 * `«»`. Un `@MaxLength(64)` acá, sobre el texto crudo, rechazaría con `400`
 * un `«` + 64 caracteres + `»` (66 crudos, 64 normalizados) que el spec
 * exige aceptar — por eso el tope acá es holgado (200): defensa contra un
 * payload absurdo, nunca la fuente del `409`.
 */
export class SetElementStereotypeDto implements SetElementStereotypeRequest {
  @ValidateIf((o: SetElementStereotypeDto) => o.stereotype !== null)
  @IsString()
  @MaxLength(200)
  @NoNulBytes()
  stereotype!: string | null;
}

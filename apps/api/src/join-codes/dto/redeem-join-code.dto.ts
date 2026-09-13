import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { JOIN_CODE_SHAPE, normalizeJoinCode, type RedeemJoinCodeRequest } from '@umlive/contracts';

/**
 * **Trampa evitada, no heredada del literal de tasks.md 2.1**: `@Matches`
 * sin `@Transform` valida la forma de lo que el usuario TIPEÓ, no la
 * NORMALIZADA — y `JOIN_CODE_SHAPE` solo acepta mayúsculas. SC-A13 exige
 * literalmente que `POST { code: "7km9px2q" }` (minúsculas) funcione. Sin
 * este `@Transform`, el `ValidationPipe` global (que corre DESPUÉS de
 * `RedemptionThrottleGuard` y ANTES del controller) rechazaría con `400`
 * cualquier código en minúsculas antes de que `RedemptionService` llegara a
 * normalizarlo — un defecto que compila limpio y solo se ve al caminar el
 * escenario. `normalizeJoinCode` es la misma función que usa el guard y el
 * servicio (design.md §7): una sola definición de "el mismo código".
 */
export class RedeemJoinCodeDto implements RedeemJoinCodeRequest {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeJoinCode(value) : value))
  @Matches(JOIN_CODE_SHAPE)
  code!: string;
}

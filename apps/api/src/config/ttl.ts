/**
 * Parser de TTL humano («15m», «30d», «900») a segundos.
 *
 * Vive acá y no en `tokens.service.ts` (D1 de
 * `nfr-verification-and-security-hardening`) porque el esquema que valida el
 * arranque y el servicio que firma los tokens tienen que usar EXACTAMENTE el
 * mismo parser: si el validador aceptara un formato que el servicio después no
 * entiende —o al revés—, la compuerta del arranque mentiría.
 *
 * Sin dependencia nueva — `jsonwebtoken` tipa `expiresIn` con un literal de
 * `ms` que no vale la pena importar para esto solo.
 */
export function parseTtlSeconds(raw: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new Error(`TTL inválido en la configuración: "${raw}"`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 's') as 's' | 'm' | 'h' | 'd';
  const secondsPerUnit: Record<'s' | 'm' | 'h' | 'd', number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return value * secondsPerUnit[unit];
}

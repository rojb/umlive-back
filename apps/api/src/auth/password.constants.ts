import { Algorithm } from '@node-rs/argon2';

/**
 * Parámetros de Argon2id, fijos y **fuera** de `.env` a propósito.
 *
 * Un parámetro configurable es un parámetro que deriva, y su deriva rompe
 * SC-A04 en silencio: si estos números cambiaran a mitad de proyecto, los
 * hashes viejos se verificarían con un costo distinto al del señuelo
 * precomputado de `AuthService` (ver `auth.service.ts`), y la igualdad de
 * tiempo entre "cuenta inexistente" y "contraseña incorrecta" se rompería
 * sin que nadie tocara el login.
 *
 * Configuración de referencia OWASP (m=19 MiB, t=2, p=1) — se prefiere sobre
 * la variante de 64 MiB porque la instancia hospedada es chica (~US$5-10/mes,
 * PRD §12) y porque menor costo significa menor varianza absoluta, lo que
 * hace la ventana de ±50 ms de SC-A04 más fácil de sostener.
 *
 * Diseño: `openspec/changes/auth/design.md` §3.
 */
export const ARGON2_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

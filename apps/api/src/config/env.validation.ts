import { z } from 'zod';
import { parseTtlSeconds } from './ttl';

/**
 * Validación del entorno al arrancar (D1 de
 * `nfr-verification-and-security-hardening/design.md`).
 *
 * Tres decisiones que no son obvias leyendo el código:
 *
 *   1. **Devuelve `config` SIN transformar.** El `validate` de `ConfigModule`
 *      es una COMPUERTA, no una fuente de configuración: `assignVariablesToProcess`
 *      escribe solo las claves que la función devuelve, así que devolver la
 *      salida parseada de zod borraría del entorno toda variable que el esquema
 *      no declare (las claves de IA, `WEB_DIST_PATH`). Los consumidores siguen
 *      leyendo strings, como hoy.
 *   2. **El mensaje lista TODAS las variables inválidas juntas y nunca imprime
 *      un valor.** Un error que cita el secreto que está reclamando lo escribe
 *      en el log de arranque.
 *   3. **Falla rápido y ruidoso.** `ConfigModule.forRoot` es async, así que el
 *      `throw` rechaza `NestFactory.create` y el proceso termina con código 1
 *      antes de abrir el puerto.
 *
 * Reglas: `DATABASE_URL` no vacía; `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/
 * `AUTH_THROTTLE_PEPPER` ≥ 32 caracteres y access ≠ refresh; `ACCESS_TOKEN_TTL`
 * opcional (`15m` por defecto en el consumidor) en `(0, 900]` s;
 * `REFRESH_TOKEN_TTL` opcional y > 0; `LOCK_TTL_MS` entero en `[6000, 15000]`;
 * `LOCK_SWEEP_INTERVAL_MS` entero en `[100, 1000]`; `TRUST_PROXY_HOPS` `^[0-3]$`;
 * `PORT` en `[1, 65535]`; `NODE_ENV`/`COOKIE_SECURE` de enum.
 */

const MIN_SECRET_CHARS = 32;
const ACCESS_TTL_MAX_SECONDS = 900;
const LOCK_TTL_MIN_MS = 6_000;
const LOCK_TTL_MAX_MS = 15_000;
const SWEEP_MIN_MS = 100;
const SWEEP_MAX_MS = 1_000;

/**
 * Una variable opcional escrita como `""` (el placeholder de un `.env`) cuenta
 * como ausente. No se «arregla» el valor: solo se omite la validación.
 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Secreto de sesión: ≥ 32 caracteres. `""` = ausente = falta. */
const secret = z.preprocess(
  emptyToUndefined,
  z
    .string({
      required_error: 'es obligatoria',
      invalid_type_error: 'debe ser texto',
    })
    .min(MIN_SECRET_CHARS, { message: `debe tener al menos ${MIN_SECRET_CHARS} caracteres` }),
);

/** TTL opcional y parseable, con tope opcional en segundos. */
function ttl(options: { maxSeconds?: number } = {}) {
  return z.preprocess(
    emptyToUndefined,
    z
      .string({ invalid_type_error: 'debe ser texto' })
      .optional()
      .superRefine((value, ctx) => {
        if (value === undefined) return;
        let seconds: number;
        try {
          seconds = parseTtlSeconds(value);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no es un TTL válido (p. ej. 15m, 900s)' });
          return;
        }
        if (seconds <= 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'debe ser mayor que 0' });
        } else if (options.maxSeconds !== undefined && seconds > options.maxSeconds) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `no puede superar los ${options.maxSeconds} segundos`,
          });
        }
      }),
  );
}

/** Entero opcional dentro de un rango — `LOCK_TTL_MS`, `LOCK_SWEEP_INTERVAL_MS`, `PORT`. */
function optionalInt(min: number, max: number, message: string) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ invalid_type_error: message })
      .int(message)
      .min(min, message)
      .max(max, message)
      .optional(),
  );
}

const envSchema = z
  .object({
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z.string({ required_error: 'es obligatoria' }).min(1, { message: 'no puede estar vacía' }),
    ),
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    AUTH_THROTTLE_PEPPER: secret,
    ACCESS_TOKEN_TTL: ttl({ maxSeconds: ACCESS_TTL_MAX_SECONDS }),
    REFRESH_TOKEN_TTL: ttl(),
    LOCK_TTL_MS: optionalInt(
      LOCK_TTL_MIN_MS,
      LOCK_TTL_MAX_MS,
      `debe ser un entero entre ${LOCK_TTL_MIN_MS} y ${LOCK_TTL_MAX_MS}`,
    ),
    LOCK_SWEEP_INTERVAL_MS: optionalInt(
      SWEEP_MIN_MS,
      SWEEP_MAX_MS,
      `debe ser un entero entre ${SWEEP_MIN_MS} y ${SWEEP_MAX_MS}`,
    ),
    TRUST_PROXY_HOPS: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^[0-3]$/, 'debe ser un número de saltos entre 0 y 3')
        .optional(),
    ),
    PORT: optionalInt(1, 65_535, 'debe ser un entero entre 1 y 65535'),
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z
        .enum(['development', 'production'], {
          errorMap: () => ({ message: 'debe ser development o production' }),
        })
        .optional(),
    ),
    COOKIE_SECURE: z.preprocess(
      emptyToUndefined,
      z
        .enum(['true', 'false'], {
          errorMap: () => ({ message: 'debe ser "true" o "false"' }),
        })
        .optional(),
    ),
  })
  .superRefine((value, ctx) => {
    if (
      typeof value.JWT_ACCESS_SECRET === 'string' &&
      value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'debe ser distinta de JWT_ACCESS_SECRET',
      });
    }
  });

/** Une todas las variables inválidas en un solo mensaje, sin imprimir NINGÚN valor. */
function describeIssues(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join('.') : 'entorno';
    return `${name}: ${issue.message}`;
  });
  return `Entorno inválido — ${parts.join('; ')}`;
}

/**
 * Compuerta del arranque que consume `ConfigModule.forRoot({ validate })`.
 * Devuelve la MISMA referencia que recibe: no transforma ni normaliza nada.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(config);
  if (!result.success) throw new Error(describeIssues(result.error));
  return config;
}

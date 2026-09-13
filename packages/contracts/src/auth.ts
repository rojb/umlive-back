/**
 * Contrato de identidad y sesión — solo tipos y constantes, sin dependencias
 * de ejecución (`contracts` es un paquete `tsc` pelado: meter `zod` acá se lo
 * impone a las dos aplicaciones). La validación vive donde ya vive: DTOs con
 * `class-validator` en el borde de NestJS y validación en pantalla en la web.
 *
 * Lo que se comparte es lo que no puede derivar entre las dos mitades.
 *
 * Especificación: `openspec/changes/auth/specs/auth-backend/spec.md`,
 * `openspec/changes/auth/specs/auth-frontend/spec.md`.
 * Diseño: `openspec/changes/auth/design.md` §6.
 */

/** SC-A03 y el medidor de fuerza del frontend leen el mismo número. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Códigos de error estables entre servidor y cliente. El cuerpo HTTP nunca
 * expone un mensaje libre para estos casos — solo el código, para que el
 * frontend decida el texto en su idioma (y para que SC-A04 tenga un cuerpo
 * comparable byte a byte entre los dos caminos de login inválido).
 */
export const AUTH_ERROR = {
  INVALID_CREDENTIALS: 'invalid_credentials',
  EMAIL_TAKEN: 'email_taken',
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
  SESSION_EXPIRED: 'session_expired',
  WRONG_PASSWORD: 'wrong_password',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];

/** Nunca incluye `passwordHash` — ni el tipo lo declara. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: string;
  createdAt: string;
}

export interface RegisterRequest {
  displayName: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  /** Interruptor «Mantener sesión» de A1 — controla el `maxAge` de la cookie, no el TTL del refresh (diseño §4.3). */
  rememberMe?: boolean;
}

/** Respuesta de `register` y `login`. El access token nunca toca `localStorage` (diseño §7). */
export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  /** Segundos hasta el vencimiento del access token. */
  expiresIn: number;
}

/** Respuesta de `POST /api/auth/refresh`. */
export interface RefreshResponse {
  accessToken: string;
  expiresIn: number;
}

/** Respuesta de `GET /api/users/me`. */
export interface MeResponse extends AuthUser {
  /** `count(refresh_tokens WHERE revoked_at IS NULL AND expires_at > now())` (FR-A04). */
  activeSessionCount: number;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

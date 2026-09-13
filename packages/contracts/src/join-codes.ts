/**
 * Contrato de códigos de acceso — solo tipos y constantes, sin dependencias
 * de ejecución (misma regla que `auth.ts`/`projects.ts`).
 *
 * Especificación: `openspec/changes/join-codes/specs/join-codes-backend/spec.md`,
 * `openspec/changes/join-codes/specs/join-codes-frontend/spec.md`.
 * Diseño: `openspec/changes/join-codes/design.md` §7.
 */

import type { ProjectSummary } from './projects';

export const JOIN_CODE_LENGTH = 8;

/**
 * Crockford Base32, MAYÚSCULAS. Sin `I/L/O/U` (design.md §2.4). Subconjunto
 * estricto de `ck_join_code_shape` (`^[A-Za-z0-9]{8}$`,
 * `20260912000001_integrity/migration.sql:78-79`) — no hace falta migración.
 */
export const JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Forma del código ya NORMALIZADO (mayúsculas, sin confusables). No aplicar
 * directamente sobre lo que el usuario tipeó — pasar primero por
 * `normalizeJoinCode` (design.md §2.4, la trampa que rompe SC-A13 en silencio
 * si se olvida).
 */
export const JOIN_CODE_SHAPE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/**
 * Misma función en el servidor y en el cliente: una sola definición de "el
 * mismo código". `O → 0`, `I/L → 1`, mayúsculas, sin espacios ni guiones
 * (para pegar un código agrupado como `7KM9 PX2Q`). El servidor la aplica
 * SIEMPRE, aunque el cliente ya lo haya hecho — el cliente es una comodidad,
 * nunca una garantía (FR-A12).
 */
export const normalizeJoinCode = (raw: string): string =>
  raw
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

export interface JoinCodeView {
  id: string;
  code: string;
  diagramId: string;
  diagramName: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
}

/** C3: `expiresAt`/`maxUses` opcionales al generar — FR-A15 se respeta al redimir, no se exige acá. */
export interface GenerateJoinCodeRequest {
  expiresAt?: string;
  maxUses?: number;
}

export interface RedeemJoinCodeRequest {
  code: string;
}

/** `project` es el `ProjectSummary` listo para A3: el cliente no vuelve a pedir el dashboard. */
export interface RedeemJoinCodeResponse {
  project: ProjectSummary;
  alreadyMember: boolean;
}

/**
 * `join_code_exhausted` es un agregado sobre SC-A14/SC-A17 (design.md §3.1),
 * no su reemplazo: agotar usos y vencer por fecha son causas distintas con
 * acciones distintas del lado del participante.
 *
 * `too_many_attempts` repite el literal de `AUTH_ERROR.TOO_MANY_ATTEMPTS`
 * (`auth.ts`) a propósito — mismo significado, declarado en el espacio de
 * nombres de esta rebanada para que una pantalla de proyectos no tenga que
 * importar el contrato de `auth`.
 */
export const JOIN_CODE_ERROR = {
  INVALID: 'join_code_invalid',
  REVOKED: 'join_code_revoked',
  EXPIRED: 'join_code_expired',
  EXHAUSTED: 'join_code_exhausted',
  NOT_FOUND: 'join_code_not_found',
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
} as const;

export type JoinCodeErrorCode = (typeof JOIN_CODE_ERROR)[keyof typeof JOIN_CODE_ERROR];

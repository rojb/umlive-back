/**
 * Eventos de WebSocket. Un solo lugar donde viven los nombres de canal.
 *
 * Especificación: SPECS.md §4 (SPEC-C)
 */

import type {
  LockDenied, LockGranted, LockReleased,
  OperationCommitted, OperationRejected, OperationRequest,
} from './operations';

/** Cliente → servidor. */
export interface ClientEvents {
  'diagram:join': (p: { diagramId: string; lastVersion: number }) => void;
  'diagram:leave': (p: { diagramId: string }) => void;
  'op:submit': (p: OperationRequest) => void;
  'lock:request': (p: { diagramId: string; elementId: string }) => void;
  'lock:release': (p: { diagramId: string; elementId: string }) => void;
  /** Cada 5 s mientras haya locks tomados. Renueva el TTL (SC-C04). */
  'lock:heartbeat': (p: { diagramId: string; elementIds: string[] }) => void;
  'presence:cursor': (p: { diagramId: string; x: number; y: number }) => void;
  'presence:select': (p: { diagramId: string; elementIds: string[] }) => void;
}

/** Servidor → cliente. */
export interface ServerEvents {
  /** Respuesta a join: delta ordenado o snapshot según el hueco (SC-C24, SC-C25). */
  'diagram:sync': (p: DiagramSync) => void;
  'op:committed': (p: OperationCommitted) => void;
  'op:rejected': (p: OperationRejected) => void;
  'lock:granted': (p: LockGranted) => void;
  'lock:denied': (p: LockDenied) => void;
  'lock:released': (p: LockReleased) => void;
  /** Difundido al congelar. Todos pasan a solo lectura en <= 1 s (SC-C18). */
  'diagram:frozen': (p: { by: { userId: string; displayName: string }; at: string }) => void;
  'diagram:unfrozen': (p: { by: { userId: string; displayName: string }; at: string }) => void;
  'presence:joined': (p: PresenceUser) => void;
  'presence:left': (p: { userId: string }) => void;
  'presence:cursor': (p: { userId: string; x: number; y: number }) => void;
  'presence:select': (p: { userId: string; elementIds: string[] }) => void;
  /** Expulsión: se quitó al usuario del proyecto (SC-A12). */
  'access:revoked': (p: { reason: string }) => void;
}

export type DiagramSync =
  | { mode: 'delta'; fromVersion: number; toVersion: number; operations: OperationCommitted[] }
  | { mode: 'snapshot'; version: number; state: unknown; operations: OperationCommitted[] };

export interface PresenceUser {
  userId: string;
  displayName: string;
  color: string;
  heldElementIds: string[];
}

/**
 * Paleta de presencia. Ningún color es verde ni ámbar: esos significan estado
 * (en vivo, congelado) y un usuario no debe poder confundirse con un estado.
 */
export const PRESENCE_COLORS = ['#2B6CB8', '#7A4FD0', '#0E7C86', '#A8446B', '#B0562A', '#4A5C9E'] as const;

export function presenceColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

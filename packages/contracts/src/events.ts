/**
 * Eventos de WebSocket. Un solo lugar donde viven los nombres de canal.
 *
 * Especificación: SPECS.md §4 (SPEC-C)
 */

import type {
  LockDenied, LockGranted, LockReleased,
  OperationCommitted, OperationRejected, OperationRequest,
} from './operations';
import type { DiagramContent } from './uml';

/**
 * Lo que viaja en `handshake.auth` (collaboration-gateway/design.md §D3).
 * `diagramId` va ACÁ y no solo en `diagram:join` porque SC-C28 exige que el
 * rechazo ocurra EN EL HANDSHAKE, y sin `diagramId` el handshake no puede
 * resolver membresía contra un proyecto. Un socket sirve a un solo
 * diagrama: `diagram:join` con otro id se rechaza.
 */
export interface SocketHandshakeAuth {
  token: string;
  diagramId: string;
}

/** Códigos de `connect_error` (design.md §D3). No-miembro y rol insuficiente comparten `forbidden`. */
export type SocketRejectionCode = 'unauthenticated' | 'bad_request' | 'diagram_not_found' | 'forbidden';

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
  /** Token renovado por el cliente HTTP. El socket NUNCA llama a /auth/refresh (SC-A06, design.md §D5). */
  'auth:token': (p: { token: string }) => void;
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
  /**
   * Roster completo, dirigido SOLO al socket que se une. Deduplicado por
   * `userId`: cuatro ventanas de la misma persona son UNA fila y UN color.
   * Existe porque `presence:joined`/`presence:left` son incrementales y sin
   * esto la cuarta ventana en abrirse no ve a las tres que ya estaban
   * (SC-C27 sería incumplible). reconnect-and-presence/design.md §D8.
   */
  'presence:roster': (p: PresenceUser[]) => void;
  /** Expulsión: se quitó al usuario del proyecto (SC-A12). */
  'access:revoked': (p: { reason: string }) => void;
  /** Emitido justo antes de desconectar por `exp` vencido — distingue vencimiento de caída de red (design.md §D5). */
  'auth:expired': () => void;
}

export type DiagramSync =
  | { mode: 'delta'; fromVersion: number; toVersion: number; operations: OperationCommitted[] }
  // `state: DiagramContent` — era `unknown` (design.md §D9). Import de solo
  // tipo: se borra al compilar, sin ciclo en runtime con `./operations`, que
  // ya importa de `./uml`.
  | { mode: 'snapshot'; version: number; state: DiagramContent; operations: OperationCommitted[] };

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

/**
 * ⚠️ ÚLTIMO RECURSO. La fuente primaria del color es la asignación POR SALA
 * que hace el gateway al unirse (reconnect-and-presence/design.md §D7) y que
 * el cliente lee del roster. Con 4 usuarios este hash colisiona el 72,2 % de
 * las veces (1 − (5/6)(4/6)(3/6)). El cliente NUNCA lo llama.
 */
export function presenceColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

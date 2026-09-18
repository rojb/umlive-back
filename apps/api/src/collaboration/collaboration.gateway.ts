import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  PROJECT_ERROR,
  type ClientEvents,
  type OperationRequest,
  type ProjectRole,
  type ServerEvents,
  type SocketHandshakeAuth,
  type SocketRejectionCode,
} from '@umlive/contracts';
import type { Server, Socket } from 'socket.io';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { SocketAuthService } from '../auth/socket-auth.service';
import { ProjectAccessResolver, type ProjectAccessResult } from '../projects/project-access.resolver';
import { DiagramContentService } from '../uml/diagram-content.service';
import { OperationsService } from './operations.service';

/**
 * Lo que el middleware de handshake deja en `socket.data` (design.md §D6).
 * **Ninguna** estructura propia de conteo por `userId` acá ni en ningún otro
 * punto del archivo — la sala ES la room de Socket.IO, poblada por socket.
 */
interface SocketData {
  user: CurrentUserPayload;
  access: { projectId: string; role: ProjectRole };
  diagramId: string;
  /** Segundos epoch — del JWT (`exp`), no de `Date.now()`. */
  tokenExp: number;
}

type CollabSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
type CollabServer = Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>;

/** Grace del barredor de vencimiento (design.md §D5) — solo absorbe desfase de reloj. */
const SOCKET_AUTH_GRACE_MS = 30_000;
/** Un solo barredor, no un timer por socket (design.md §D5, mismo patrón que `locks.service.ts`). */
const SOCKET_AUTH_SWEEP_INTERVAL_MS = 10_000;

/**
 * Transporte WebSocket de M3 (collaboration-gateway/design.md, rebanada 1 de
 * 4). Middleware de handshake (D1/D3), gate de membresía a `diagram:join`
 * (D3), snapshot v0 al vuelo (D8/D9), renovación de sesión sin reconectar
 * (D5), contabilidad de sala por socket (D6). **Sin** `LocksService` (D7) —
 * no hay handler `lock:request` todavía.
 */
@WebSocketGateway()
export class CollaborationGateway implements OnGatewayInit<CollabServer>, OnGatewayDisconnect<CollabSocket> {
  private readonly logger = new Logger(CollaborationGateway.name);

  @WebSocketServer()
  private readonly server!: CollabServer;

  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly socketAuth: SocketAuthService,
    private readonly accessResolver: ProjectAccessResolver,
    private readonly diagramContent: DiagramContentService,
    private readonly operations: OperationsService,
  ) {}

  /**
   * Único portón de entrada (design.md §D1/§D3): corre ANTES de
   * `handleConnection` y de cualquier `@SubscribeMessage`. Un veredicto
   * negativo SIEMPRE es `next(new Error(code))` — nunca `socket.disconnect()`
   * tras aceptar. El evento `connect` no debe disparar en el cliente
   * rechazado (SC-C28).
   */
  afterInit(server: CollabServer): void {
    server.use(async (socket: CollabSocket, next) => {
      const auth = socket.handshake.auth as Partial<SocketHandshakeAuth>;
      const token = typeof auth.token === 'string' ? auth.token : undefined;
      const diagramId = typeof auth.diagramId === 'string' ? auth.diagramId : undefined;

      if (!token) {
        next(this.rejection('unauthenticated'));
        return;
      }

      const verified = await this.socketAuth.verifyAccessToken(token);
      if (!verified) {
        next(this.rejection('unauthenticated'));
        return;
      }

      const result = await this.accessResolver.resolveAccess({
        userId: verified.id,
        diagramId,
        action: 'diagram.view',
      });

      if (!result.ok) {
        next(this.rejection(this.toRejectionCode(result.reason)));
        return;
      }

      // `diagramId` ya pasó por el resolver — no puede ser `undefined` acá:
      // sin él, `resolveAccess` habría devuelto `bad_request` más arriba.
      socket.data = {
        user: { id: verified.id, sid: verified.sid, displayName: verified.displayName },
        access: { projectId: result.context.projectId, role: result.context.role },
        diagramId: diagramId!,
        tokenExp: verified.exp,
      };
      next();
    });

    this.sweeper = setInterval(() => this.sweepExpired(), SOCKET_AUTH_SWEEP_INTERVAL_MS);
    // No debe mantener vivo el proceso (mismo patrón que `locks.service.ts`).
    this.sweeper.unref?.();
  }

  /**
   * `handleDisconnect` existe para dejar escrito, en el lugar donde el
   * próximo que toque esta rebanada lo va a buscar, que NO llama a
   * `LocksService` (design.md §D7): no hay handler `lock:request` todavía,
   * así que el registro de locks está siempre vacío, y el alcance GLOBAL de
   * `releaseAllForUser` soltaría locks vivos de otras ventanas del mismo
   * usuario si alguna vez tuviera efecto — el defecto de contabilidad por
   * usuario (D6) entrando por la puerta de atrás. Cablearlo es tarea de la
   * rebanada 3, junto con INV-WS-1 y el protocolo `lock:*` completo.
   */
  handleDisconnect(_client: CollabSocket): void {
    // Intencionalmente vacío.
  }

  /**
   * SC-C28 defensa en profundidad: `diagram:join` vuelve a chequear acceso
   * contra el mismo resolver — el punto donde se nota que a alguien lo
   * sacaron del proyecto entre el handshake y el join. Un socket sirve a un
   * solo diagrama: `diagramId` distinto al del handshake se rechaza.
   */
  @SubscribeMessage('diagram:join')
  async handleJoin(
    @ConnectedSocket() client: CollabSocket,
    @MessageBody() payload: { diagramId: string; lastVersion: number },
  ): Promise<void> {
    if (payload.diagramId !== client.data.diagramId) {
      client.disconnect(true);
      return;
    }

    const result = await this.accessResolver.resolveAccess({
      userId: client.data.user.id,
      diagramId: client.data.diagramId,
      action: 'diagram.view',
    });
    if (!result.ok) {
      client.disconnect(true);
      return;
    }

    await client.join(this.roomOf(client.data.diagramId));

    // `lastVersion` se acepta y se DESCARTA a propósito (design.md §D9): el
    // log de operaciones está vacío en esta rebanada y la versión siempre es
    // 0 — `mode: 'delta'` no puede existir todavía.
    //
    // W-1 (verify 2026-09-18): el snapshot va SOLO al socket que se une, vía
    // `emitToSocket`, nunca a la sala entera. `emitTo` (sala) difundía el
    // sync completo a los demás miembros en cada join — costo innecesario y
    // la vía por la que W-2 encontró que un expulsado seguía recibiendo
    // contenido.
    const state = await this.diagramContent.getDiagramContent(client.data.diagramId);
    this.emitToSocket(client, 'diagram:sync', { mode: 'snapshot', version: 0, state, operations: [] });
  }

  /**
   * Renovación sin reconectar (design.md §D5). El gateway NUNCA dispara ni
   * acepta que el socket llame a `/auth/refresh` — esa llamada es
   * responsabilidad exclusiva del cliente HTTP, fuera del socket (SC-A06).
   * Este handler reverifica lo que el cliente ya obtuvo.
   */
  @SubscribeMessage('auth:token')
  async handleAuthToken(
    @ConnectedSocket() client: CollabSocket,
    @MessageBody() payload: { token: string },
  ): Promise<void> {
    const verified = await this.socketAuth.verifyAccessToken(payload.token);
    if (!verified || verified.id !== client.data.user.id) {
      // `sub` distinto o verificación fallida: un socket no puede cambiar de
      // identidad en caliente.
      client.disconnect(true);
      return;
    }

    // W-2 (verify 2026-09-18): re-chequear membresía en CADA renovación, no
    // solo en el join. Sin esto, a un miembro expulsado DESPUÉS de unirse a
    // la sala le bastaba con seguir renovando su token para quedar vivo
    // indefinidamente, mientras HTTP ya le respondía 403. Expulsar de
    // inmediato al momento exacto de la revocación (sin esperar a que el
    // socket intente renovar) es `concurrency-ux` (SC-A12) — deuda explícita
    // de la rebanada 3 (design.md §D7/§11). Acá solo se cierra la ventana de
    // "seguir vivo renovando" que encontró W-2, con el mismo vocabulario de
    // error que ya usa el handshake.
    const access = await this.accessResolver.resolveAccess({
      userId: client.data.user.id,
      diagramId: client.data.diagramId,
      action: 'diagram.view',
    });
    if (!access.ok) {
      this.emitToSocket(client, 'access:revoked', { reason: this.toRejectionCode(access.reason) });
      client.disconnect(true);
      return;
    }

    client.data.tokenExp = verified.exp;
  }

  /**
   * Handler `op:submit` (`operations-pipeline/design.md` D3). Una línea sin
   * rama que pueda errarse: `diagramId`/`actorId` AUTORITATIVOS son los de
   * `socket.data` (del handshake), NUNCA los que pudiera traer el payload —
   * el pipeline no valida eso porque el gateway ya se lo garantiza. El
   * despacho por `out.route` no es una decisión de este archivo: la trae el
   * propio `OperationOutcome`, fijada por quien conoce el motivo
   * (`OperationsService`). `emitToSocket` es la misma puerta por-socket que
   * ya usan `diagram:sync`/`access:revoked` (§D8 corregido 2026-09-18) — el
   * eco de SC-C10 y el rechazo de SC-C11 la reusan en vez de sumar un método
   * hermano.
   */
  @SubscribeMessage('op:submit')
  async onOperationSubmit(@ConnectedSocket() client: CollabSocket, @MessageBody() req: OperationRequest): Promise<void> {
    const out = await this.operations.submit(client.data.diagramId, client.data.user.id, req);
    // `as never`: el precio honesto de que TypeScript no correlaciona `event`
    // con `payload` en un índice dinámico — un solo `as`, en el sitio de
    // despacho, cero en las 32 entradas del mapa (design.md D3).
    out.route === 'room'
      ? this.emitTo(client.data.diagramId, out.event, out.payload as never)
      : this.emitToSocket(client, out.event, out.payload as never);
  }

  /**
   * Puerta de salida por SALA (design.md §D8). Ningún otro punto de este
   * archivo, ni ningún otro service, llama `this.server.emit`/`.to(...).emit`
   * directo. La barrera de tipos (`ServerEvents`) más la de grafo (este
   * gateway NO inyecta `PrismaService`) hacen imposible emitir una fila
   * cruda de Prisma.
   *
   * **Corrección 2026-09-18 (verify W-3)**: `emitTo` (sala) NO es la única
   * puerta — hay una segunda, `emitToSocket` (un socket), con el mismo
   * tipado sobre `ServerEvents`. La letra original del MUST ("todo evento
   * saliente pasa por `emitTo`") era incompleta: `emitTo` firma por sala y
   * ni el snapshot del join (W-1) ni `auth:expired`/`access:revoked`, que
   * son estrictamente por-socket, entran ahí. Ver
   * `collaboration-gateway-backend/spec.md` para el texto corregido.
   */
  private emitTo<E extends keyof ServerEvents>(diagramId: string, event: E, payload: Parameters<ServerEvents[E]>[0]): void {
    this.server.to(this.roomOf(diagramId)).emit(event, ...([payload] as Parameters<ServerEvents[E]>));
  }

  /** Puerta de salida por SOCKET individual — ver la nota de `emitTo` de arriba. */
  private emitToSocket<E extends keyof ServerEvents>(client: CollabSocket, event: E, ...payload: Parameters<ServerEvents[E]>): void {
    client.emit(event, ...payload);
  }

  /**
   * Barredor único (design.md §D5, mismo patrón que `locks.service.ts:53-56`):
   * recorre los sockets conectados y desconecta los que tengan
   * `now > tokenExp + grace`, emitiendo `auth:expired` justo antes — a ESE
   * socket puntual, no a la sala (nadie más debe enterarse de que a otro se
   * le venció la sesión).
   */
  private sweepExpired(): void {
    const nowSeconds = Date.now() / 1000;
    const graceSeconds = SOCKET_AUTH_GRACE_MS / 1000;
    for (const client of this.server.sockets.sockets.values()) {
      const data = (client as CollabSocket).data;
      if (!data || nowSeconds <= data.tokenExp + graceSeconds) continue;
      this.emitToSocket(client as CollabSocket, 'auth:expired');
      client.disconnect(true);
    }
  }

  private roomOf(diagramId: string): string {
    return `diagram:${diagramId}`;
  }

  private toRejectionCode(reason: Extract<ProjectAccessResult, { ok: false }>['reason']): SocketRejectionCode {
    if (reason === 'bad_request') return 'bad_request';
    if (reason === PROJECT_ERROR.DIAGRAM_NOT_FOUND) return 'diagram_not_found';
    // `project_not_found` e `insufficient_role` comparten `forbidden` — el
    // contrato de socket no distingue no-miembro de rol insuficiente, igual
    // que HTTP (design.md §D3, SC-A12 respaldo).
    return 'forbidden';
  }

  private rejection(code: SocketRejectionCode): Error {
    const err = new Error(code);
    this.logger.debug(`handshake rechazado: ${code}`);
    return err;
  }
}

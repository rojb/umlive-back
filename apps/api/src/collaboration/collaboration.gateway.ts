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
  type OperationRejected,
  type OperationRequest,
  type ProjectRole,
  type ServerEvents,
  type SocketHandshakeAuth,
  type SocketRejectionCode,
} from '@umlive/contracts';
import { isUUID } from 'class-validator';
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

  /**
   * Cola por socket (verify-report 2026-09-18, W-3) — una cadena de
   * promesas por `socket.id`, NUNCA una cola global: sockets DISTINTOS
   * siguen corriendo en paralelo, solo las operaciones del MISMO socket se
   * serializan. Sin esto, Socket.IO despacha los handlers `async` de
   * `op:submit` en paralelo y cada `submit` compite por el `FOR UPDATE` de
   * fila — 30 `element.move` seguidos del mismo cliente confirmaban en un
   * orden distinto al que se enviaron (4 inversiones observadas en runtime).
   * Se limpia en `handleDisconnect` (design.md §D7 de `collaboration-gateway`:
   * nada por-usuario, todo por-socket).
   */
  private readonly socketQueues = new Map<string, Promise<void>>();

  /**
   * Tope de profundidad por-socket (verify-report 2026-09-18, RS-4). Sin
   * esto, un cliente puede encolar miles de `op:submit` en `socketQueues` y
   * cada uno retiene su payload en memoria hasta que le toca procesarse —
   * el patrón normal de `enqueueForSocket` (W-3) no tiene, por diseño,
   * ningún límite propio. Se lee y actualiza ANTES de encolar, nunca
   * adentro de la cadena de promesas.
   */
  private readonly socketQueueDepth = new Map<string, number>();
  private static readonly MAX_QUEUE_DEPTH = 100;

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
   * `handleDisconnect` NO llama a `LocksService` (design.md §D7): no hay
   * handler `lock:request` todavía, así que el registro de locks está
   * siempre vacío, y el alcance GLOBAL de `releaseAllForUser` soltaría locks
   * vivos de otras ventanas del mismo usuario si alguna vez tuviera efecto —
   * el defecto de contabilidad por usuario (D6) entrando por la puerta de
   * atrás. Cablearlo es tarea de la rebanada 3, junto con INV-WS-1 y el
   * protocolo `lock:*` completo. Lo único que SÍ limpia acá (verify-report
   * W-3, `operations-pipeline`) es la cola por-socket de `op:submit`.
   */
  handleDisconnect(client: CollabSocket): void {
    // W-3: soltar la cola de este socket. Sin esto, `socketQueues` crece sin
    // límite en un servidor de larga vida (una entrada por cada socket que
    // alguna vez mandó un `op:submit`, nunca liberada).
    this.socketQueues.delete(client.id);
    // RS-4: mismo motivo, para el contador de profundidad.
    this.socketQueueDepth.delete(client.id);
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
   * Handler `op:submit` (`operations-pipeline/design.md` D3, corregido
   * 2026-09-18 por verify-report C-2/W-3/W-4, y de nuevo en la
   * re-verificación 2026-09-18 por RW-1/RW-2/RS-4). Orden de admisión,
   * del más barato al más caro:
   *
   * 0. Forma del SOBRE (RW-2) — SINCRÓNICO, fuera de la cola: un `req` roto
   *    no toca la base ni compite por ningún lock, así que no necesita el
   *    orden estricto de la cola por-socket.
   * 0.5. Tope de profundidad por-socket (RS-4) — también fuera de la cola:
   *    es una defensa de CAPACIDAD, no de contenido.
   * 1. Membresía + permiso VIGENTE (C-2/RW-1) — el diagrama SIEMPRE es
   *    `client.data.diagramId` (autoritativo, del handshake), nunca el que
   *    pudiera traer el payload. Sin acceso confirmado, el rechazo NO lleva
   *    `currentVersion` (RW-1): nada que no esté autorizado para ESTE
   *    diagrama se entera de su versión.
   * 2. Unido a la sala (W-4) — recién acá, con el acceso YA confirmado en el
   *    paso 1, `currentVersion` es seguro de revelar.
   * 3-4. Lista blanca de `type` + validación de payload (C-1, W-1, W-2) y el
   *    resto del pipeline: `OperationsService.submit`.
   *
   * Todo del paso 1 en adelante bajo `enqueueForSocket` (W-3): las
   * operaciones del MISMO socket se procesan en el orden en que se
   * mandaron. Sockets DISTINTOS no se estorban entre sí. `emitToSocket` es
   * la misma puerta por-socket que ya usan `diagram:sync`/`access:revoked`.
   */
  @SubscribeMessage('op:submit')
  async onOperationSubmit(@ConnectedSocket() client: CollabSocket, @MessageBody() req: unknown): Promise<void> {
    // 0. Forma del SOBRE (verify-report 2026-09-18, RW-2). `req === null`
    // (`emit('op:submit', null)`) o un `diagramId` que no es un UUID
    // (`req.diagramId = "pepe"`) tiraban un `TypeError`/`22P02` sin atrapar
    // más abajo en el pipeline — el remitente se quedaba sin NINGUNA
    // salida, la misma violación que W-2 ya había cerrado para la FORMA del
    // *payload* (acá es la forma del SOBRE que lo contiene).
    const envelope = parseOperationEnvelope(req);
    if (!envelope.ok) {
      this.emitToSocket(client, 'op:rejected', this.rejectedOp(client, envelope.opId, 'MALFORMED', envelope.message));
      return;
    }

    // 0.5. Tope de profundidad por-socket (RS-4), ANTES de encolar.
    // `MALFORMED` porque `RATE_LIMITED` no existe en `RejectionReason`
    // (`operations.ts`) — sumar un motivo nuevo movería el contrato y el
    // frontend por una defensa de borde que esta pasada no pidió.
    const depth = this.socketQueueDepth.get(client.id) ?? 0;
    if (depth >= CollaborationGateway.MAX_QUEUE_DEPTH) {
      this.emitToSocket(
        client,
        'op:rejected',
        this.rejectedOp(client, envelope.value.opId, 'MALFORMED', 'Demasiadas operaciones en cola para este socket. Esperá a que se procesen las anteriores.'),
      );
      return;
    }
    this.socketQueueDepth.set(client.id, depth + 1);

    await this.enqueueForSocket(client, () => this.processOperationSubmit(client, envelope.value)).finally(() => {
      const left = (this.socketQueueDepth.get(client.id) ?? 1) - 1;
      if (left <= 0) this.socketQueueDepth.delete(client.id);
      else this.socketQueueDepth.set(client.id, left);
    });
  }

  private async processOperationSubmit(client: CollabSocket, req: OperationRequest): Promise<void> {
    const room = this.roomOf(client.data.diagramId);

    // 1. Membresía + permiso VIGENTES, en CADA `op:submit` (verify-report
    // C-2, INV-8 de `SPECS.md:52`). El handshake y `diagram:join` autorizan
    // una sola vez; sin esto, a un miembro EXPULSADO después de unirse le
    // alcanzaba con seguir mandando operaciones (no solo renovar el token,
    // como ya cerraba W-2 de `auth:token`) para seguir escribiendo — HTTP ya
    // respondía 403 en el mismo instante. `resolveAccess` nunca lanza
    // (`ProjectAccessResolver`, `design.md §D2` de `collaboration-gateway`):
    // acá se traduce a un `OperationRejected`, nunca a una excepción HTTP.
    const access = await this.accessResolver.resolveAccess({
      userId: client.data.user.id,
      diagramId: client.data.diagramId,
      action: 'diagram.edit',
    });
    if (!access.ok) {
      // `insufficient_role` de `ProjectAccessResolver` YA fusiona "no es
      // miembro" y "es miembro pero el rol no alcanza" (mismo criterio que
      // el handshake y que HTTP, `design.md §7.2`: un id no es enumerable).
      // `NOT_A_MEMBER` es el motivo del protocolo (`operations.ts`) que
      // describe el caso — el que este mismo hallazgo (C-2) demuestra: un
      // miembro QUITADO. `diagram_not_found`/`project_not_found` (el
      // diagrama o el proyecto desaparecieron a mitad de sesión) son la
      // misma familia que `TARGET_NOT_FOUND`: lo que direccionó ya no está.
      const reason = access.reason === 'bad_request' ? 'MALFORMED' : access.reason === PROJECT_ERROR.INSUFFICIENT_ROLE ? 'NOT_A_MEMBER' : 'TARGET_NOT_FOUND';
      const message =
        reason === 'NOT_A_MEMBER'
          ? 'Ya no sos miembro de este proyecto, o tu rol no alcanza para editar.'
          : reason === 'TARGET_NOT_FOUND'
            ? 'El diagrama o el proyecto ya no existen.'
            : 'La operación no tiene una forma válida.';
      // RW-1 (verify-report 2026-09-18): SIN `currentVersion` — la
      // autorización para ESTE diagrama recién falló, así que no hay
      // "versión de ahora" que sea seguro revelarle a este remitente.
      this.emitToSocket(client, 'op:rejected', this.rejectedOp(client, req.opId, reason, message));
      return;
    }

    // 2. Unido a la sala (verify-report W-4). `diagram:join` hace `await
    // resolveAccess` antes de `client.join` (D3 de `collaboration-gateway`),
    // y los handlers de Socket.IO corren en paralelo — un `op:submit` que
    // llega ANTES de que el `join` termine (reconexión) confirmaba y
    // difundía igual, pero el remitente nunca recibía nada: violaba "todo
    // `op:submit` DEBE producir exactamente una salida". Nunca silenciar:
    // rechazo tipado, solo al remitente. El acceso YA se confirmó arriba
    // (paso 1), así que acá `currentVersion` es seguro de revelar (RW-1).
    if (!client.rooms.has(room)) {
      const currentVersion = await this.operations.currentVersion(client.data.diagramId);
      this.emitToSocket(
        client,
        'op:rejected',
        this.rejectedOp(client, req.opId, 'MALFORMED', 'Todavía no te uniste a este diagrama. Esperá a que la sincronización termine e intentá de nuevo.', currentVersion),
      );
      return;
    }

    // 3-4. Lista blanca de `type` + validación de payload (C-1, W-1, W-2) y
    // el resto del pipeline: `OperationsService.submit` (`operations.service.ts`).
    const out = await this.operations.submit(client.data.diagramId, client.data.user.id, req);
    // `as never`: el precio honesto de que TypeScript no correlaciona `event`
    // con `payload` en un índice dinámico — un solo `as`, en el sitio de
    // despacho, cero en las 32 entradas del mapa (design.md D3).
    out.route === 'room' ? this.emitTo(client.data.diagramId, out.event, out.payload as never) : this.emitToSocket(client, out.event, out.payload as never);
  }

  /**
   * Construye un `OperationRejected` sin abrir la transacción — para los
   * rechazos que este archivo emite ANTES del pipeline (RW-2, RS-4, W-4,
   * C-2). `diagramId` SIEMPRE es `client.data.diagramId` (autoritativo, del
   * handshake) — NUNCA el que pudiera traer el payload (RW-1: antes de esta
   * corrección, un rechazo leía y devolvía el `diagramId` del CLIENTE, un
   * oráculo de existencia/versión para un diagrama ajeno). `currentVersion`
   * es OPCIONAL (RW-1) y el LLAMADOR decide si corresponde: solo después de
   * confirmar autorización vigente para este diagrama.
   */
  private rejectedOp(client: CollabSocket, opId: string, reason: OperationRejected['reason'], message: string, currentVersion?: number): OperationRejected {
    return { opId, diagramId: client.data.diagramId, reason, message, currentVersion };
  }

  /**
   * Cola por-socket (verify-report W-3): encadena `task` detrás de lo último
   * que ese `socket.id` haya encolado. El `.catch` al final de la cadena
   * (nunca dentro de `task`) es a propósito: si `task` fallara sin
   * atraparlo, la promesa encadenada rechazaría y `socketQueues.get(id)`
   * quedaría apuntando a una promesa rechazada — el SIGUIENTE `.then()`
   * saltaría directo a su rama de error sin correr `task`, y ese socket
   * dejaría de procesar operaciones en silencio. `processOperationSubmit` ya
   * no debería lanzar (`OperationsService.submit` no lanza; los dos
   * rechazos tempranos de acá tampoco), pero la cola no depende de esa
   * garantía para seguir viva — el error se loguea y la cadena sigue.
   */
  private enqueueForSocket(client: CollabSocket, task: () => Promise<void>): Promise<void> {
    const previous = this.socketQueues.get(client.id) ?? Promise.resolve();
    const next = previous.then(task, task).catch((err) => {
      this.logger.error(`op:submit sin atrapar en la cola de ${client.id}: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
    });
    this.socketQueues.set(client.id, next);
    return next;
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

type OperationEnvelope = { ok: true; value: OperationRequest } | { ok: false; opId: string; message: string };

/**
 * Forma del SOBRE de `op:submit`, ANTES de que nada en el pipeline lea un
 * campo de `req` (verify-report 2026-09-18, RW-2). Es una capa MÁS angosta
 * que `validateOperationPayload` (que valida `req.payload` para un `type` ya
 * conocido, dentro de `OperationsService.submit`): acá no hace falta abrir
 * la base ni conocer el `OperationType` — un objeto sin `diagramId`/`opId`/
 * `type` con la FORMA correcta no llega ni siquiera a la cola por-socket.
 * `diagramId` se valida solo por FORMA (no se usa para autorizar nada — eso
 * es siempre `client.data.diagramId`, RW-1); esta capa existe para que un
 * `req.diagramId` no-string no tire una excepción sin atrapar más abajo.
 */
function parseOperationEnvelope(req: unknown): OperationEnvelope {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    return { ok: false, opId: '', message: 'La operación no tiene una forma válida.' };
  }
  const r = req as Record<string, unknown>;
  const opId = typeof r.opId === 'string' ? r.opId : '';
  if (typeof r.diagramId !== 'string' || !isUUID(r.diagramId)) {
    return { ok: false, opId, message: 'El identificador del diagrama no es un UUID válido.' };
  }
  if (opId.length === 0) {
    return { ok: false, opId, message: 'El identificador de la operación no tiene una forma válida.' };
  }
  if (typeof r.type !== 'string' || r.type.length === 0) {
    return { ok: false, opId, message: 'El tipo de operación no tiene una forma válida.' };
  }
  return { ok: true, value: req as OperationRequest };
}

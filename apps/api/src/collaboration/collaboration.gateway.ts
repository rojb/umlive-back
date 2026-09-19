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
  PRESENCE_COLORS,
  PROJECT_ERROR,
  presenceColor,
  type AccessRevokedReason,
  type ClientEvents,
  type DiagramFreezeInfo,
  type DiagramSync,
  type LockAllResult,
  type LockHolder,
  type OperationCommitted,
  type OperationRejected,
  type OperationRequest,
  type PresenceUser,
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
import { LocksService } from './locks.service';
import { OperationsService } from './operations.service';
import { buildRoster, pickColor } from './presence';
import { ReconnectService } from './reconnect.service';

/**
 * Lo que el middleware de handshake deja en `socket.data` (design.md §D6) más
 * lo que esta rebanada agrega (`reconnect-and-presence/design.md` §6) —
 * ningún `Map` nuevo por-usuario: `color`/`presence`/`lastCursorAt` viven y
 * mueren con el socket.
 */
interface SocketData {
  user: CurrentUserPayload;
  access: { projectId: string; role: ProjectRole };
  diagramId: string;
  /** Segundos epoch — del JWT (`exp`), no de `Date.now()`. */
  tokenExp: number;
  /** Asignado por sala en `diagram:join` (design.md §D7) — la FUENTE del color, nunca `presenceColor(userId)` salvo último recurso. */
  color?: string;
  /** Marca "entró a la sala" — `teardown` lo lee y lo borra (design.md §D2). Ausente hasta que `diagram:join` complete (Fase 4). */
  presence?: PresenceUser;
  /** Piso de 20ms por socket para `presence:cursor` (design.md §D10). */
  lastCursorAt?: number;
  /**
   * Piso de 1s por socket entre re-syncs de un socket VIVO
   * (`frontend-cutover/design.md` §D3). Solo lo escribe y lo lee la rama de
   * RE-SYNC de `diagram:join` — mismo patrón que `lastCursorAt`.
   */
  lastSyncAt?: number;
}

/** Constantes de módulo (design.md §6) — una sola forma correcta, no configuración. */
const CURSOR_MIN_INTERVAL_MS = 20;
const MAX_ID_BATCH = 200;
/**
 * Tope de `lock:requestAll` (`hierarchical-delete` D3): un cierre de borrado
 * puede ser grande (un paquete con sus descendientes y sus relaciones), pero
 * no arbitrario. Por encima de esto el payload se descarta sin adquirir ni
 * difundir nada — mismo criterio que `MAX_ID_BATCH`, con el tope propio de un
 * cierre.
 */
const MAX_LOCK_ALL_BATCH = 1000;
/**
 * Límite de tasa OBLIGATORIO del re-sync (`frontend-cutover/design.md` §D3,
 * `frontend-cutover-backend/spec.md`). Un hueco de versión dispara un re-sync
 * y un re-sync mal manejado puede producir otro hueco: sin piso, la
 * resincronización se convierte en tormenta de `diagram:sync`. El `Logger.warn`
 * del descarte es la señal de que el cliente entró en bucle.
 */
const SYNC_MIN_INTERVAL_MS = 1000;

type CollabSocket = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketData>;
type CollabServer = Server<ClientEvents, ServerEvents, Record<string, never>, SocketData>;

/** Grace del barredor de vencimiento (design.md §D5) — solo absorbe desfase de reloj. */
const SOCKET_AUTH_GRACE_MS = 30_000;
/** Un solo barredor, no un timer por socket (design.md §D5, mismo patrón que `locks.service.ts`). */
const SOCKET_AUTH_SWEEP_INTERVAL_MS = 10_000;

/**
 * Transporte WebSocket de M3. Middleware de handshake (`collaboration-gateway`
 * D1/D3), gate de membresía a `diagram:join` (D3), renovación de sesión sin
 * reconectar (D5), contabilidad de sala por socket (D6). `diagram:sync` honra
 * `lastVersion` vía `ReconnectService` (`reconnect-and-presence/design.md`
 * §D3-D6). `LocksService` cablea el protocolo `lock:*` SIN exigencia (D7 —
 * `canWrite()` es M4) y `teardown` libera bajo INV-WS-1 en `handleDisconnect`
 * y `diagram:leave` (§D2). Color por sala y `presence:roster`/`joined` se
 * agregan en `diagram:join` (§D7-D8) junto con `presence:cursor`/`select` vía
 * `emitToOthers` (§D9-D10).
 *
 * **Ampliado por `diagram-freeze` (rebanada 3 de M4):** `emitFreezeState` es la
 * única puerta de salida del congelado, y `emitSync` garantiza que todo
 * `diagram:sync` — el del join Y el del re-sync — vaya seguido de
 * `diagram:frozen` si la compuerta del diagrama está cerrada (D7), en el mismo
 * bloque síncrono. Las ramas `frozen` de `lock:request`/`lock:requestAll`
 * responden una denegación reconocible sin `holder` en vez de quedarse en
 * silencio (D4-bis).
 *
 * **Ampliado por `concurrency-ux` (rebanada 4 de M4):** `evictUserFromProject`
 * (D8, SC-A12) y `evictDiagram` (D9) desalojan SIN un solo `await` — leen el
 * `Map` local del namespace, nunca `fetchSockets()` —, con el orden
 * `lock:released` → `access:revoked` → `disconnect(true)` → `presence:left`.
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
    private readonly operations: OperationsService,
    private readonly reconnect: ReconnectService,
    private readonly locks: LocksService,
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

    // `setReleaseListener` es un SETTER de un solo slot (`locks.service.ts:63`
    // — `this.onRelease = fn`), no un acumulador. Se registra UNA SOLA VEZ,
    // acá en `afterInit`. Nota fechada 2026-09-18 (reconnect-and-presence/
    // design.md §D10): si M4 necesita un segundo oyente, tiene que COMPONER
    // — un segundo `setReleaseListener` reemplaza a este en silencio y las
    // liberaciones dejan de llegar a la sala.
    this.locks.setReleaseListener((diagramId, elementId, cause) => {
      this.emitTo(diagramId, 'lock:released', { elementId, cause });
    });
  }

  /**
   * `teardown` cablea `LocksService` (reconnect-and-presence/design.md §D2):
   * único, compartido por `handleDisconnect` y `diagram:leave`. Cuenta
   * sockets del MISMO `userId` en la sala vía `fetchSockets()` — INV-WS-1,
   * nunca un contador propio — y solo libera/anuncia si este socket era el
   * ÚLTIMO de ese usuario en esa sala. `releaseAllForUser` (alcance GLOBAL)
   * fue ELIMINADO de `locks.service.ts`: bajo D3 (un socket = un diagrama)
   * + D6 (contabilidad por socket) de `collaboration-gateway`, cerrar una
   * de cuatro ventanas del mismo usuario habría soltado los locks de las
   * otras tres y los de todos los diagramas de todos sus proyectos.
   */
  handleDisconnect(client: CollabSocket): void {
    // W-3: soltar la cola de este socket. Sin esto, `socketQueues` crece sin
    // límite en un servidor de larga vida (una entrada por cada socket que
    // alguna vez mandó un `op:submit`, nunca liberada).
    this.socketQueues.delete(client.id);
    // RS-4: mismo motivo, para el contador de profundidad.
    this.socketQueueDepth.delete(client.id);

    void this.teardown(client);
  }

  /**
   * Salir por la puerta, en vez de caerse. Sin esto, `diagram:leave`
   * (`events.ts:15`, en el contrato desde la rebanada 1 sin comportamiento
   * asignado) dejaría los locks tomados hasta el TTL y al usuario colgado
   * en el roster de los otros tres — el mismo defecto que INV-WS-1 evita en
   * la desconexión, por la otra puerta.
   */
  @SubscribeMessage('diagram:leave')
  async handleLeave(@ConnectedSocket() client: CollabSocket): Promise<void> {
    await this.teardown(client);
    await client.leave(this.roomOf(client.data.diagramId));
  }

  /**
   * Único, compartido por `handleDisconnect` y `diagram:leave` (design.md
   * §D2). Tres detalles que no son cosméticos:
   *
   * 1. 🔴 El filtro `s.id !== socket.id` es OBLIGATORIO, no defensivo. En
   *    Socket.IO el socket abandona sus salas entre `disconnecting` y
   *    `disconnect`, así que en teoría `fetchSockets()` ya no lo incluye —
   *    pero el momento exacto en que corre `handleDisconnect` de Nest
   *    respecto de ese vaciado no es algo sobre lo que convenga apostar la
   *    demo, y `diagram:leave` corre con el socket TODAVÍA adentro de la
   *    sala. Sin el filtro, `diagram:leave` NUNCA soltaría nada: el usuario
   *    siempre se encontraría a sí mismo.
   * 2. El orden importa: primero se sueltan los locks (cada uno emite su
   *    propio `lock:released` a la sala, vía `setReleaseListener`),
   *    DESPUÉS `presence:left`. Al revés, los otros clientes borrarían al
   *    usuario del roster y recién después recibirían liberaciones de
   *    alguien que ya no existe para ellos — bordes huérfanos.
   * 3. Idempotente: `socket.data.presence = undefined` antes de decidir,
   *    así que `diagram:leave` seguido de `disconnect` (o viceversa) no
   *    duplica el trabajo.
   */
  private async teardown(socket: CollabSocket): Promise<void> {
    const presence = socket.data.presence;
    const diagramId = socket.data.diagramId;
    if (!presence || !diagramId) return; // nunca entró a la sala (diagram:join): nada que soltar

    socket.data.presence = undefined;

    const peers = await this.server.in(this.roomOf(diagramId)).fetchSockets();
    const otro = peers.some((s) => s.id !== socket.id && s.data?.user?.id === presence.userId);
    if (otro) return; // INV-WS-1: no era el último socket de este usuario en esta sala

    // `cause: 'disconnected'` para los dos llamadores — `diagram:leave` no
    // es un motivo distinto en el contrato (`LockReleased['cause']`): desde
    // la perspectiva de los locks, salir por la puerta y caerse producen el
    // mismo efecto observable.
    this.locks.releaseAllForUserInDiagrams(presence.userId, [diagramId], 'disconnected');
    this.emitTo(diagramId, 'presence:left', { userId: presence.userId });
  }

  /**
   * Desalojo por expulsión del proyecto (`concurrency-ux` D8, SC-A12). Lo llama
   * `MemberRemovalController` DESPUÉS del `COMMIT` de la transacción que sacó
   * la membresía, en el MISMO bloque síncrono.
   *
   * Todo el cuerpo es síncrono y no hay un `await` en ninguna parte, y ESE es
   * el requisito, no un detalle de estilo: con `fetchSockets()` (la operación
   * asíncrona equivalente) el usuario expulsado podría volver a pedir un lock
   * en el intervalo entre resolver los diagramas y desalojar — `acquire` no
   * mira la membresía — y ese lock sobreviviría al desalojo hasta el TTL, con
   * el usuario ya fuera del proyecto. Acá, juntar los sockets, soltar y
   * desconectar ocurre sin ceder el hilo.
   *
   * El filtro es por `access.projectId` (del handshake) y NO por diagrama: un
   * socket que ya pasó el handshake y todavía no se unió a la sala también es
   * del proyecto del que se lo echó, y los sockets del mismo usuario en OTROS
   * proyectos no se tocan (escenario de aislamiento entre proyectos).
   *
   * Orden de emisión, load-bearing (mismo criterio que `teardown`): los locks
   * primero — cada `lock:released` va a la sala y los demás clientes borran el
   * borde —, después `access:revoked` (D10: el panel terminal del expulsado),
   * después el cierre, y `presence:left` al final, para que el roster pierda a
   * alguien que ya no tiene locks ni socket. `disconnect(true)` (server
   * disconnect) drena el buffer de engine.io antes de cerrar: el aviso de
   * expulsión llega ANTES que el cierre de la conexión (spec de
   * `concurrency-ux`).
   */
  evictUserFromProject(userId: string, projectId: string, diagramIds: string[]): void {
    const targets = this.localSockets().filter((s) => s.data.user?.id === userId && s.data.access?.projectId === projectId);
    this.locks.releaseAllForUserInDiagrams(userId, diagramIds, 'removed_from_project');
    const rooms = this.evict(targets, 'removed_from_project');
    for (const diagramId of rooms) this.emitTo(diagramId, 'presence:left', { userId });
  }

  /**
   * Desalojo por borrado del diagrama (`concurrency-ux` D9). Lo llama
   * `DiagramDeletionController` después del soft-delete; la limpieza de la
   * compuerta de congelado la hace `LocksService.forgetDiagram`, que corre
   * justo después y en el mismo bloque síncrono.
   *
   * Sin `presence:left` por sala: la sala queda VACÍA, así que no hay a quién
   * avisarle. Sin liberar locks tampoco — `forgetDiagram` los descarta sin
   * emitir, por la misma razón, y porque la liberación con causa
   * `'removed_from_project'` de acá mentiría sobre el motivo.
   */
  evictDiagram(diagramId: string): void {
    const targets = this.localSockets().filter((s) => s.data.diagramId === diagramId);
    this.evict(targets, 'diagram_deleted');
  }

  /**
   * El desalojo en sí, compartido por expulsión y borrado (D8/D9). Devuelve las
   * SALAS de los sockets que estaban presentes, para que el llamador decida si
   * corresponde anunciar `presence:left` (expulsión) o no (borrado).
   *
   * `s.data.presence = undefined` ANTES de emitir y desconectar es lo que hace
   * que el `teardown` que dispara `disconnect(true)` sea un no-op: sin esto, el
   * `presence:left` se emitiría dos veces y los locks se soltarían una segunda
   * vez con causa `'disconnected'`, ensuciando el motivo real del desalojo.
   */
  private evict(targets: CollabSocket[], reason: AccessRevokedReason): Set<string> {
    const rooms = new Set<string>();
    for (const socket of targets) {
      if (socket.data.presence) rooms.add(socket.data.diagramId);
      socket.data.presence = undefined;
      this.emitToSocket(socket, 'access:revoked', { reason });
      socket.disconnect(true);
    }
    return rooms;
  }

  /**
   * Los sockets conectados a ESTE proceso (`concurrency-ux` D8).
   *
   * El `Map` del namespace y NO `fetchSockets()`: el segundo es asíncrono y
   * `evictUserFromProject` no puede permitirse un punto de suspensión. Es
   * válido porque hay UNA sola instancia de backend (PRD §12 Q5), el mismo
   * supuesto que ya declara `LocksService`. Es el ÚNICO acceso al `Map` — el
   * barredor de vencimiento también entra por acá —, así que no hay dos formas
   * de recorrer los sockets que puedan divergir.
   */
  localSockets(): CollabSocket[] {
    return [...this.server.sockets.sockets.values()] as CollabSocket[];
  }

  /**
   * `lock:request` (design.md §D7). SIN `async`: `socket.data.diagramId` y
   * `socket.data.color` ya están resueltos desde `diagram:join`, así que
   * todo el handler es síncrono — es la razón por la que el color se
   * calcula AL UNIRSE y no acá (un `await fetchSockets()` en este camino
   * destruiría la atomicidad de `acquire` que resuelve SC-C03).
   * `socket.data.diagramId` es la autoridad exclusiva: el `diagramId` del
   * payload NUNCA se lee.
   */
  @SubscribeMessage('lock:request')
  onLockRequest(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { elementId: string }): void {
    if (typeof payload?.elementId !== 'string' || !isUUID(payload.elementId)) {
      this.logger.warn(`lock:request con elementId malformado de ${client.id}`);
      return;
    }
    const diagramId = client.data.diagramId;
    const holder: LockHolder = {
      userId: client.data.user.id,
      displayName: client.data.user.displayName,
      color: client.data.color ?? '',
    };
    const outcome = this.locks.acquire(diagramId, payload.elementId, holder);
    if (outcome.ok) {
      this.emitTo(diagramId, 'lock:granted', {
        elementId: payload.elementId,
        holder,
        expiresAt: new Date(outcome.expiresAt).toISOString(),
      });
    } else if ('frozen' in outcome) {
      // La compuerta está cerrada (`diagram-freeze` D4-bis): la denegación NO
      // puede nombrar un `holder`, porque no hay ninguno. Se responde igual —
      // la versión original de D4 no respondía nada y eso dejaba al cliente
      // esperando un `lock:granted` que nunca iba a llegar, el mismo bug que
      // el acuse frozen de `lock:requestAll` ya evitaba.
      this.emitToSocket(client, 'lock:denied', { reason: 'frozen', elementId: payload.elementId });
    } else {
      // `reason: 'held'` — la otra mitad de la unión, y la que SIGUE exigiendo
      // el `holder` (FR-C04: denegar sin decir quién es el bug que evita).
      this.emitToSocket(client, 'lock:denied', { reason: 'held', elementId: payload.elementId, holder: outcome.holder });
    }
  }

  /** `lock:release` — mismo patrón síncrono, misma autoridad exclusiva de `socket.data.diagramId`. */
  @SubscribeMessage('lock:release')
  onLockRelease(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { elementId: string }): void {
    if (typeof payload?.elementId !== 'string' || !isUUID(payload.elementId)) {
      this.logger.warn(`lock:release con elementId malformado de ${client.id}`);
      return;
    }
    this.locks.release(client.data.diagramId, payload.elementId, client.data.user.id, 'released');
  }

  /**
   * `lock:requestAll` (`hierarchical-delete` D3, SC-C14/SC-C17). **SIN `async`**
   * y sin un solo punto de suspensión: `acquireAll` es de dos fases y atómico
   * en el modelo de un solo hilo de Node, y el acuse sale en el MISMO tick.
   *
   * Responde por RETORNO (el acuse de Socket.IO) y no con eventos sueltos: si
   * el cliente recibiera `lock:granted` sueltos no podría distinguir los de
   * **su** petición de los de otra. Con el acuse sabe si ESTA petición salió
   * bien o mal, y con qué elemento y dueño se denegó.
   *
   * Si el acuse es `ok`, difunde `lock:granted` por cada id (la sala entera
   * necesita saber qué quedó tomado). Si deniega, **no difunde nada** — igual
   * que `lock:denied`. Ese "nada" es load-bearing: los locks de un cierre
   * denegado no se tomaron, así que anunciarlos mentiría a las otras ventanas.
   *
   * `socket.data.diagramId` es la autoridad exclusiva; el `diagramId` del
   * payload NUNCA se lee (D7 de `reconnect-and-presence`). Un payload
   * malformado (no-arreglo de strings, o más de `MAX_LOCK_ALL_BATCH` ids) se
   * descarta sin adquirir ni difundir nada: no hay acuse que dar, y el
   * cliente lo resuelve por su propia cota de espera.
   */
  @SubscribeMessage('lock:requestAll')
  onLockRequestAll(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { elementIds: string[] }): LockAllResult | undefined {
    if (
      !Array.isArray(payload?.elementIds) ||
      payload.elementIds.length > MAX_LOCK_ALL_BATCH ||
      !payload.elementIds.every((id) => typeof id === 'string' && isUUID(id))
    ) {
      this.logger.warn(`lock:requestAll malformado o por encima del tope de ${client.id}`);
      return undefined;
    }

    const diagramId = client.data.diagramId;
    const holder: LockHolder = {
      userId: client.data.user.id,
      displayName: client.data.user.displayName,
      color: client.data.color ?? '',
    };
    // Deduplicado: un cierre puede traer el mismo id dos veces (raíz repetida,
    // o una asociación reflexiva que satisface dos términos de la consulta).
    const ids = [...new Set(payload.elementIds)];

    const outcome = this.locks.acquireAll(diagramId, ids, holder);
    if (!outcome.ok) {
      // Las DOS denegaciones se reconocen por su forma. `frozen` es la compuerta
      // cerrada (`diagram-freeze` D4): sin `denied`/`holder` porque no hay
      // ninguno, y con `ok: false` igual para que el Inspector no quede colgado
      // esperando un acuse que nunca llega.
      return 'frozen' in outcome
        ? { ok: false, frozen: true }
        : { ok: false, denied: { reason: 'held', elementId: outcome.elementId, holder: outcome.holder } };
    }

    const expiresAt = new Date(outcome.expiresAt).toISOString();
    for (const elementId of ids) this.emitTo(diagramId, 'lock:granted', { elementId, holder, expiresAt });
    return { ok: true, expiresAt };
  }

  /** `lock:heartbeat` — mismo patrón síncrono. Sin acuse a propósito (design.md §D10): compensado por `lock:released` del barrido/relevo. */
  @SubscribeMessage('lock:heartbeat')
  onLockHeartbeat(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { elementIds: string[] }): void {
    if (!Array.isArray(payload?.elementIds) || payload.elementIds.length > MAX_ID_BATCH || !payload.elementIds.every((id) => typeof id === 'string' && isUUID(id))) {
      this.logger.warn(`lock:heartbeat malformado o por encima del tope de ${client.id}`);
      return;
    }
    this.locks.heartbeat(client.data.diagramId, payload.elementIds, client.data.user.id);
  }

  /**
   * `presence:cursor` — solo `emitToOthers` (design.md §D9), `volatile` y
   * con piso de 20ms por socket (§D10) independiente del estrangulado del
   * cliente. `NaN`/`Infinity` en `x`/`y` se descartan sin emitir.
   */
  @SubscribeMessage('presence:cursor')
  onPresenceCursor(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { x: number; y: number }): void {
    if (typeof payload?.x !== 'number' || typeof payload?.y !== 'number' || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
      this.logger.warn(`presence:cursor malformado de ${client.id}`);
      return;
    }
    const now = Date.now();
    const last = client.data.lastCursorAt ?? 0;
    if (now - last < CURSOR_MIN_INTERVAL_MS) return;
    client.data.lastCursorAt = now;
    this.emitToOthers(client, 'presence:cursor', { userId: client.data.user.id, x: payload.x, y: payload.y }, { volatile: true });
  }

  /** `presence:select` — `emitToOthers`, NUNCA volátil: dispara por gesto, no por movimiento (design.md §D9). */
  @SubscribeMessage('presence:select')
  onPresenceSelect(@ConnectedSocket() client: CollabSocket, @MessageBody() payload: { elementIds: string[] }): void {
    if (!Array.isArray(payload?.elementIds) || payload.elementIds.length > MAX_ID_BATCH || !payload.elementIds.every((id) => typeof id === 'string' && isUUID(id))) {
      this.logger.warn(`presence:select malformado o por encima del tope de ${client.id}`);
      return;
    }
    this.emitToOthers(client, 'presence:select', { userId: client.data.user.id, elementIds: payload.elementIds });
  }

  /**
   * SC-C28 defensa en profundidad: `diagram:join` vuelve a chequear acceso
   * contra el mismo resolver — el punto donde se nota que a alguien lo
   * sacaron del proyecto entre el handshake y el join. Un socket sirve a un
   * solo diagrama: `diagramId` distinto al del handshake se rechaza.
   *
   * **Además, desde `frontend-cutover` (D3) este handler es IDEMPOTENTE**: un
   * `diagram:join` repetido con el mismo `diagramId` sobre un socket que YA
   * entró a la sala se trata como RE-SYNC (ver la rama más abajo), no como un
   * segundo join. Es la costura que el hueco de versión y el pendiente vencido
   * necesitan sin reconectar — reconectar tiraría sala, locks y color. Cero
   * cambio de contrato: `ClientEvents` no se toca.
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

    const diagramId = client.data.diagramId;

    // 🔴 RE-SYNC de un socket VIVO (`frontend-cutover/design.md` §D3).
    // `socket.data.presence` es la marca de "entró a la sala" (D2 de
    // `reconnect-and-presence`): si ya está asignada, este `diagram:join` no
    // es un join. El re-chequeo de acceso de arriba YA corrió, igual que en
    // el join original, así que un miembro expulsado a mitad de sesión sigue
    // siendo rechazado por esta misma puerta.
    if (client.data.presence) {
      const now = Date.now();
      const last = client.data.lastSyncAt ?? 0;
      if (now - last < SYNC_MIN_INTERVAL_MS) {
        // Límite de tasa OBLIGATORIO (D3): el pedido se DESCARTA y se avisa.
        // No se responde nada — responder un error por cada pedido de una
        // ráfaga es la tormenta que este piso existe para evitar.
        this.logger.warn(`re-sync descartado por el piso de ${SYNC_MIN_INTERVAL_MS}ms en el socket ${client.id}`);
        return;
      }
      client.data.lastSyncAt = now;

      // SOLO la rama de sync. Deliberadamente NO se hace ninguna de estas:
      //   · `socket.join()`      — el socket YA está en la sala (Socket.IO es
      //                            idempotente, pero no dependemos de eso).
      //   · asignar color        — el color es del SOCKET, no del join (D7 de
      //                            `reconnect-and-presence`).
      //   · `presence:joined`    — sería FALSO: el usuario ya estaba acá.
      //   · tocar locks/roster   — nada cambió para la sala.
      // Y `emitToSocket` (no `emitTo`): el sync es del que lo pidió, como en
      // el join (W-1 del verify 2026-09-18).
      const resync = await this.reconnect.sync(diagramId, payload.lastVersion);
      this.emitSync(client, resync);
      return;
    }

    // INV-RC-1 (reconnect-and-presence/design.md §D3): el join va PRIMERO,
    // SIEMPRE antes de leer la versión o las filas del log. Toda operación
    // confirmada es entonces anterior a la lectura de versión (y está en el
    // delta/snapshot) o posterior al join (y llega por difusión) — los dos
    // conjuntos se solapan, no dejan hueco. Si esto se reordena, el delta
    // deja de ser completo y nada falla ruidosamente.
    await client.join(this.roomOf(diagramId));

    const userId = client.data.user.id;

    // Color por sala + roster (design.md §D7-D8). `fetchSockets()` YA
    // incluye a este socket (recién se unió arriba). Se filtra a sí mismo
    // para decidir "¿ya tenía otra ventana acá?" y para armar la lista de
    // colores tomados por OTROS.
    const peers = await this.server.in(this.roomOf(diagramId)).fetchSockets();
    const others = peers.filter((s) => s.id !== client.id);
    const ownPeer = others.find((s) => s.data?.user?.id === userId);
    const takenColors = others.map((s) => s.data?.color).filter((c): c is string => Boolean(c));
    const color = pickColor(ownPeer?.data.color, takenColors, PRESENCE_COLORS, () => presenceColor(userId));
    client.data.color = color;

    const heldElementIds = this.locks.heldBy(userId, diagramId);
    client.data.presence = { userId, displayName: client.data.user.displayName, color, heldElementIds };

    // Roster completo, dirigido SOLO a quien se une, deduplicado por
    // `userId` — la primera aparición (este socket, o su ventana anterior
    // si `ownPeer` existe) gana el color de referencia.
    const entries = [{ userId, displayName: client.data.user.displayName, color }, ...others.map((s) => ({ userId: s.data.user.id, displayName: s.data.user.displayName, color: s.data.color ?? presenceColor(s.data.user.id) }))];
    const roster = buildRoster(entries, (uid) => this.locks.heldBy(uid, diagramId));
    this.emitToSocket(client, 'presence:roster', roster);

    // `presence:joined` SOLO si este socket es el primero de ese `userId`
    // en la sala — mismo gate INV-WS-1 que `presence:left` (design.md §D8):
    // la propuesta solo declaraba la mitad simétrica (`left`). Sin esto,
    // abrir la segunda ventana de un usuario dispara un "llegó" falso en
    // las pantallas de los demás para alguien que ya estaba.
    if (!ownPeer) {
      this.emitTo(diagramId, 'presence:joined', { userId, displayName: client.data.user.displayName, color, heldElementIds });
    }

    // `lastVersion` ahora se HONRA (design.md §D4/§D9 — ya no se descarta):
    // `ReconnectService.sync` decide delta vs. estado completo por el hueco.
    //
    // W-1 (verify 2026-09-18): el sync va SOLO al socket que se une, vía
    // `emitToSocket`, nunca a la sala entera. `emitTo` (sala) difundía el
    // sync completo a los demás miembros en cada join — costo innecesario y
    // la vía por la que W-2 encontró que un expulsado seguía recibiendo
    // contenido.
    const sync = await this.reconnect.sync(diagramId, payload.lastVersion);
    this.emitSync(client, sync);
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
      this.emitToSocket(client, 'access:revoked', { reason: this.revokedReason(access.reason) });
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
   * Difunde los hechos confirmados de un lote (M6, rebanada 2/4 —
   * `ai-text-instructions` D10, INV-3). Cada operación va como un
   * `op:committed` propio, en orden de versión, con `actorKind: 'AI'`,
   * `actorId` de quien pidió el turno y su `aiTurnId` (SC-D09).
   *
   * **Lo llama `AiTurnService` DESPUÉS de que `applyBatch` resolvió** — o sea
   * después del `COMMIT`. Emitir antes es cómo las otras ventanas terminan
   * mostrando un diagrama que no existe: la operación se difundió, la
   * transacción revirtió, y nadie revierte el `op:committed` de la sala.
   *
   * Es una puerta ADICIONAL, no un bypass: sale por `emitTo`, la misma puerta
   * por sala que el resto del archivo, y mantiene la barrera de tipos y de
   * grafo que ese método documenta (el gateway no conoce la capa de base).
   */
  emitCommitted(diagramId: string, committed: readonly OperationCommitted[]): void {
    for (const payload of committed) this.emitTo(diagramId, 'op:committed', payload);
  }

  /**
   * Quién es este usuario en la sala, para armar el `LockHolder` de un turno
   * (D10). El color NO se recalcula acá: sale de la asignación por sala que
   * hizo `diagram:join` (`socket.data.color`, D7 de `reconnect-and-presence`).
   *
   * SÍNCRONO y sobre el `Map` local del namespace, por el mismo motivo que
   * `evictUserFromProject`: el llamador está por tomar locks y no puede
   * permitirse un punto de suspensión.
   *
   * `null` si el usuario no está conectado a este diagrama; el llamador usa
   * entonces un color neutro fijo. Que no esté conectado NO es un error: un
   * turno puede llegar de un cliente que perdió el socket.
   */
  presenceHolder(diagramId: string, userId: string): LockHolder | null {
    const socket = this.localSockets().find(
      (candidate) => candidate.data?.diagramId === diagramId && candidate.data?.user?.id === userId,
    );
    if (!socket) return null;
    return {
      userId,
      displayName: socket.data.user.displayName,
      color: socket.data.color ?? presenceColor(userId),
    };
  }

  /**
   * Difunde el cambio de estado de congelado (`diagram-freeze` D3).
   *
   * Público para que `DiagramFreezeService` NO arme su propio `emit`: toda
   * salida sigue pasando por `emitTo`, y el gateway sigue SIN importar la capa
   * de base — la barrera de tipos y la de grafo que ya documenta `emitTo`
   * abajo.
   */
  emitFreezeState(diagramId: string, event: 'diagram:frozen' | 'diagram:unfrozen', info: DiagramFreezeInfo): void {
    this.emitTo(diagramId, event, info);
  }

  /**
   * Todo `diagram:sync` va seguido de `diagram:frozen` si la compuerta del
   * diagrama está cerrada (`diagram-freeze` D7), y **en el mismo bloque
   * síncrono**: `socket.emit` encola el frame y vuelve, así que no hay ningún
   * punto de suspensión entre los dos eventos y Socket.IO los entrega en ese
   * orden.
   *
   * Lo usan el UNIRSE **y el RE-SYNC**. Si el re-sync no lo usara, el cliente
   * se descongelaría solo en cada re-sync: el modo delta no lleva el congelado
   * y el cliente reinicia `frozen` con cada `diagram:sync`.
   *
   * Por qué es correcto con cualquier intercalado: el socket ya está en la sala
   * antes de leer (INV-RC-1), así que un cambio que ocurra ANTES de este
   * método llega por la sala antes del sync (el sync lo pisa y este método
   * vuelve a poner lo que diga la compuerta en ese momento), y uno que ocurra
   * DESPUÉS llega después. En los dos casos, el último mensaje coincide con la
   * compuerta.
   */
  private emitSync(client: CollabSocket, sync: DiagramSync): void {
    this.emitToSocket(client, 'diagram:sync', sync);
    const info = this.locks.frozenInfo(client.data.diagramId);
    if (info) this.emitToSocket(client, 'diagram:frozen', info);
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
   * Puerta de salida por SALA MENOS EL REMITENTE (reconnect-and-presence/
   * design.md §D9) — TERCERA ruta, no un bypass de `emitTo`. La sala sale de
   * `client.data.diagramId`, NUNCA del payload que el cliente pudo mandar.
   * Solo `presence:cursor`/`presence:select` usan esta puerta; escribir un
   * `socket.to(room).emit(...)` crudo en cualquier otro punto del archivo
   * sería el primer agujero en esta invariante.
   */
  private emitToOthers<E extends keyof ServerEvents>(
    client: CollabSocket,
    event: E,
    payload: Parameters<ServerEvents[E]>[0],
    opts?: { volatile?: boolean },
  ): void {
    const channel = client.to(this.roomOf(client.data.diagramId));
    (opts?.volatile ? channel.volatile : channel).emit(event, ...([payload] as Parameters<ServerEvents[E]>));
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
    for (const client of this.localSockets()) {
      const data = client.data;
      if (!data || nowSeconds <= data.tokenExp + graceSeconds) continue;
      this.emitToSocket(client, 'auth:expired');
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

  /**
   * Motivo de `access:revoked` para el re-chequeo de `auth:token` (W-2 de
   * `reconnect-and-presence`) — que NO es el camino de `evict`.
   *
   * Antes emitía un `SocketRejectionCode` bajo un `reason: string` libre.
   * Desde `concurrency-ux` D11 ese payload es `AccessRevokedReason`, y no es
   * una traducción cosmética: el panel del cliente es TERMINAL y su texto sale
   * de un `switch` exhaustivo sobre la causa (D10). `'forbidden'` no es una
   * causa, es un código de rechazo, y dejarlo obligaría al cliente a adivinar
   * qué mostrar.
   *
   * El mapeo por naturaleza del fallo: el diagrama que ya no está es el caso
   * borrado (D9); todo lo demás — membresía revocada a mitad de sesión, rol
   * degradado, proyecto borrado — desde la perspectiva de este socket es lo
   * mismo: ya no pertenece acá.
   */
  private revokedReason(reason: Extract<ProjectAccessResult, { ok: false }>['reason']): AccessRevokedReason {
    return reason === PROJECT_ERROR.DIAGRAM_NOT_FOUND ? 'diagram_deleted' : 'removed_from_project';
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

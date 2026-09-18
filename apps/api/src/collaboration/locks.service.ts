import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DiagramFreezeInfo, LockAllOutcome, LockHolder, LockReleased } from '@umlive/contracts';

/**
 * Registro de bloqueos de elemento — en memoria, a propósito.
 *
 * Por qué no está en la base (DATA-MODEL.md §1.6):
 *
 *   TTL de 15 s renovado cada 5, con 30 editores, son ~6 escrituras por segundo
 *   de puro ruido. Ninguna necesita sobrevivir un reinicio: si el proceso muere,
 *   todos los clientes se desconectan y todos los locks DEBEN soltarse igual
 *   (SC-C06). Persistirlos sería pagar por una garantía que no queremos.
 *
 * Esto asume UNA instancia de backend, confirmado en PRD §12 Q5. Con varias
 * haría falta Redis, y está explícitamente fuera de alcance.
 *
 * Especificación: SPECS.md §4.1 — SC-C01 … SC-C08
 */

interface Lock {
  elementId: string;
  holder: LockHolder;
  expiresAt: number;
}

/** Resultado de pedir un lock. Discriminado para que el llamador no adivine. */
export type LockOutcome =
  | { ok: true; expiresAt: number }
  | { ok: false; holder: LockHolder };

/**
 * La compuerta del diagrama está cerrada (`diagram-freeze` D4). Variante propia
 * y NO `holder` opcional: un diagrama congelado no tiene tenedor, y por eso
 * `r.holder` después de `!r.ok` deja de compilar en los dos handlers del
 * gateway — cada uno tiene que decidir qué responder (D4-bis).
 */
export type LockFrozen = { ok: false; frozen: true };

/** Constante de módulo: la misma referencia en cada denegación por congelado. */
const FROZEN: LockFrozen = { ok: false, frozen: true };

@Injectable()
export class LocksService implements OnModuleDestroy {
  private readonly log = new Logger(LocksService.name);

  /** diagramId → (elementId → Lock) */
  private readonly byDiagram = new Map<string, Map<string, Lock>>();

  /**
   * Compuerta de congelado (`diagram-freeze` D4): diagramId → quién y cuándo.
   * Es la fuente del estado que recibe quien se une (D7) y la que consultan
   * `acquire`/`acquireAll`. NO es autoridad de escritura — eso es la rama `423`
   * de la base —: es autoridad de ADQUISICIÓN de locks, y existe porque
   * soltar todo sin prohibir volver a tomar deja la puerta abierta.
   *
   * Un `Map` en memoria alcanza porque hay UNA sola instancia de backend
   * (PRD §12 Q5). Se hidrata una vez al arrancar (`DiagramFreezeService.
   * onModuleInit`, D6) y después solo la mueven `freeze`/`unfreeze`.
   */
  private readonly frozen = new Map<string, DiagramFreezeInfo>();

  /** Índice inverso userId → Set<`${diagramId}:${elementId}`>, para soltar en O(k) al desconectar. */
  private readonly byUser = new Map<string, Set<string>>();

  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  /**
   * Callback que el gateway registra para difundir liberaciones. El servicio
   * no conoce el socket: mantenerlo así lo hace testeable sin levantar red.
   */
  private onRelease?: (diagramId: string, elementId: string, cause: LockReleased['cause']) => void;

  constructor(config: ConfigService) {
    this.ttlMs = Number(config.get('LOCK_TTL_MS') ?? 15_000);
    const sweepMs = Number(config.get('LOCK_SWEEP_INTERVAL_MS') ?? 1_000);
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    // No debe mantener vivo el proceso.
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  setReleaseListener(fn: (diagramId: string, elementId: string, cause: LockReleased['cause']) => void) {
    this.onRelease = fn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Adquisición
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SC-C01 / SC-C02 / SC-C03.
   *
   * Node corre una sola tarea por vez, así que este método es atómico respecto
   * de otras llamadas: no hay `await` adentro. Eso resuelve la carrera de SC-C03
   * sin sincronización explícita — y es la razón por la que NO debe volverse
   * `async` sin repensarlo.
   */
  acquire(diagramId: string, elementId: string, holder: LockHolder): LockOutcome | LockFrozen {
    // Compuerta PRIMERO y sin `await` (`diagram-freeze` D4): esta y `acquireAll`
    // son los dos únicos caminos de adquisición, así que cubren `lock:request`
    // y `lock:requestAll` por construcción.
    if (this.frozen.has(diagramId)) return FROZEN;
    const locks = this.locksOf(diagramId);
    const now = Date.now();
    const existing = locks.get(elementId);

    if (existing && existing.expiresAt > now) {
      // Re-pedir lo propio renueva, no falla.
      if (existing.holder.userId === holder.userId) {
        existing.expiresAt = now + this.ttlMs;
        return { ok: true, expiresAt: existing.expiresAt };
      }
      return { ok: false, holder: existing.holder };
    }

    // Relevo de un lock VENCIDO ajeno (reconnect-and-presence/design.md §D1).
    // Si no se deindexa al dueño ANTERIOR acá, su clave `${diagramId}:${elementId}`
    // queda stale en `byUser` para siempre: cuando ese usuario se desconecte,
    // `releaseAllForUserInDiagrams` la recorre y borra el lock VIVO del nuevo
    // dueño, más un `lock:released` que nadie pidió. Síncrono a propósito:
    // `deindex` es un `Map`/`Set` en memoria y `onRelease` encola un `emit`
    // de Socket.IO y vuelve — ninguno de los dos suspende la ejecución, así
    // que `acquire` sigue siendo atómica (SC-C03). Si al tocar esto aparece
    // la palabra clave que vuelve una función asíncrona, el arreglo está mal.
    if (existing && existing.holder.userId !== holder.userId) {
      this.deindex(existing.holder.userId, diagramId, elementId);
      this.onRelease?.(diagramId, elementId, 'expired');
    }

    const expiresAt = now + this.ttlMs;
    locks.set(elementId, { elementId, holder, expiresAt });
    this.index(holder.userId, diagramId, elementId);
    return { ok: true, expiresAt };
  }

  /**
   * Adquisición atómica de varios (SC-C14: borrar exige el cierre ENTERO —
   * la raíz, sus descendientes y cada relación incidente). De dos fases, sin un
   * solo `await` adentro (D1 de `hierarchical-delete`):
   *
   *   fase 1 — recorre los ids SIN TOCAR NADA y devuelve el primer dueño ajeno
   *            vigente, con el `elementId` que falló (SC-C17 exige nombrarlo);
   *   fase 2 — corre solo si la fase 1 NO denegó, y llama `acquire` por cada id.
   *
   * Si se deniega, no se tomó nada y no se difundió nada: la atomicidad es
   * POR CONSTRUCCIÓN, no por deshacer. El diseño anterior tomaba de a uno y
   * hacía rollback de lo tomado — y ese rollback le soltaba al usuario locks
   * que YA TENÍA antes de pedir, además de una ventana donde `acquire` podía
   * haber avisado a la sala que un lock venció. Sin un punto de suspensión
   * entre las dos fases, nada cambia entre el chequeo y la toma.
   *
   * Nota sobre el chequeo de higiene de la tarea 4.7: mide LÍNEAS DE CÓDIGO, no
   * prosa. La primera pasada lo satisfizo reescribiendo estos comentarios para
   * que no apareciera la palabra; se revirtió el 2026-09-18 porque un comentario
   * que dice `await` es MÁS claro, no menos, y porque un grep que se conforma
   * con que nadie escriba la palabra no verifica nada. Lo que se verifica es que
   * no haya `await` en el cuerpo, y eso se lee.
   */
  acquireAll(diagramId: string, elementIds: readonly string[], holder: LockHolder): LockAllOutcome | LockFrozen {
    // Misma compuerta que `acquire`, ANTES de la fase 1 (D4).
    if (this.frozen.has(diagramId)) return FROZEN;

    const locks = this.byDiagram.get(diagramId);
    const now = Date.now();

    for (const id of elementIds) {
      const lock = locks?.get(id);
      if (lock && lock.expiresAt > now && lock.holder.userId !== holder.userId) {
        return { ok: false, elementId: id, holder: lock.holder };
      }
    }

    let expiresAt = now + this.ttlMs;
    for (const id of elementIds) {
      const r = this.acquire(diagramId, id, holder);
      // Imposible con el modelo de un solo hilo: entre la fase 1 y la fase 2 no
      // hay ningún punto de suspensión. Es una aserción, no una rama viva.
      if (!r.ok) throw new Error('acquireAll: invariante de dos fases rota');
      expiresAt = r.expiresAt;
    }
    return { ok: true, expiresAt };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Consulta
  // ───────────────────────────────────────────────────────────────────────────

  /** Quién lo tiene, o null si está libre. Vencidos cuentan como libres. */
  holderOf(diagramId: string, elementId: string): LockHolder | null {
    const lock = this.byDiagram.get(diagramId)?.get(elementId);
    if (!lock || lock.expiresAt <= Date.now()) return null;
    return lock.holder;
  }

  /**
   * ¿Puede este usuario escribir sobre estos elementos?
   *
   * Lo llama el pipeline de operaciones **lo ÚLTIMO antes de la mutación,
   * dentro de la transacción y después del eco idempotente por `opId`** — ver
   * `element-lock-enforcement/design.md` D3. Este docstring decía antes «ANTES
   * de tocar la base», que prescribe el sitio que MAXIMIZA la ventana de la
   * carrera TTL/`COMMIT` (D8): el `423` y el `409` van después del eco porque
   * un reintento de una operación ya confirmada no escribe nada, y rechazarlo
   * revertiría estado autoritativo (SC-C10).
   *
   * SÍNCRONO a propósito: lee un `Map` en memoria y no tiene un solo punto de
   * suspensión adentro. Eso y su ubicación tardía son las dos
   * únicas mitigaciones posibles de esa carrera sin acoplar los locks a
   * PostgreSQL (D8). La carrera sigue existiendo y sigue siendo un límite
   * ACEPTADO.
   *
   * Un elemento libre se considera escribible: pedir el lock es
   * responsabilidad del cliente, pero no tenerlo no habilita a otro a pisarlo
   * — porque si otro lo tuviera, este chequeo fallaría.
   *
   * Es CONSULTA PURA (D6): no adquiere nada, así que `atomic` no participa acá
   * — no hay estado parcial que revertir y se devuelve al primer dueño ajeno,
   * CON el `elementId` que lo tiene (`hierarchical-delete` D1/D6).
   */
  canWrite(diagramId: string, elementIds: readonly string[], userId: string): LockAllOutcome {
    for (const id of elementIds) {
      const holder = this.holderOf(diagramId, id);
      if (holder && holder.userId !== userId) return { ok: false, elementId: id, holder };
    }
    // `expiresAt` NO significa nada en este retorno: `canWrite` no adquiere
    // nada, así que no hay TTL que devolver. Es un centinela que miente a
    // propósito por compatibilidad de forma con `acquire`. El pipeline NO
    // debe leerlo (D10).
    return { ok: true, expiresAt: 0 };
  }

  heldBy(userId: string, diagramId: string): string[] {
    const keys = this.byUser.get(userId);
    if (!keys) return [];
    const prefix = `${diagramId}:`;
    return [...keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Renovación y liberación
  // ───────────────────────────────────────────────────────────────────────────

  /** SC-C04. Solo renueva lo que el usuario realmente tiene. */
  heartbeat(diagramId: string, elementIds: string[], userId: string): void {
    const locks = this.byDiagram.get(diagramId);
    if (!locks) return;
    const expiresAt = Date.now() + this.ttlMs;
    for (const id of elementIds) {
      const lock = locks.get(id);
      if (lock?.holder.userId === userId) lock.expiresAt = expiresAt;
    }
  }

  release(diagramId: string, elementId: string, userId: string, cause: LockReleased['cause'] = 'released'): boolean {
    const locks = this.byDiagram.get(diagramId);
    const lock = locks?.get(elementId);
    if (!lock || lock.holder.userId !== userId) return false;
    locks!.delete(elementId);
    this.deindex(userId, diagramId, elementId);
    this.onRelease?.(diagramId, elementId, cause);
    return true;
  }

  /**
   * Suelta los locks de TODO un cierre de borrado, sin filtrar por dueño
   * (`hierarchical-delete` D2). Lo llama `OperationsService` **después del
   * COMMIT** y solo en el camino que confirma: el eco idempotente no vuelve a
   * soltar.
   *
   * Suelta aunque el lock esté vencido y el barrido todavía no lo haya
   * limpiado: después de esto el barrido ya no lo ve, y `'deleted'` informa
   * mejor que `'expired'`.
   *
   * `deindex` se hace con el `userId` del DUEÑO del lock, nunca con el del que
   * borra — si no, la clave `${diagramId}:${elementId}` queda stale en `byUser`
   * del dueño y su desconexión borraría un lock VIVO de otro.
   *
   * ⚠️ Reusa `this.onRelease`, el MISMO oyente que registra el gateway una vez
   * en `afterInit`. **No se registra un segundo `setReleaseListener`**: es un
   * setter de un solo slot (`this.onRelease = fn`), así que el segundo
   * REEMPLAZA al primero en silencio y las liberaciones dejan de llegar a la
   * sala. La higiene del repo lo verifica con `rg "setReleaseListener\("` → una
   * sola ocurrencia.
   */
  releaseElements(diagramId: string, ids: readonly string[], cause: LockReleased['cause']): void {
    const locks = this.byDiagram.get(diagramId);
    if (!locks) return;
    for (const id of ids) {
      const lock = locks.get(id);
      if (!lock) continue;
      locks.delete(id);
      this.deindex(lock.holder.userId, diagramId, id);
      this.onRelease?.(diagramId, id, cause);
    }
  }

  /**
   * SC-A12. Alcance por proyecto: suelta los locks del usuario, pero SOLO en
   * los diagramas de `diagramIds`. Quien llama resuelve primero los
   * diagramas del proyecto del que se quitó al usuario (design.md §4).
   *
   * También es el método que `reconnect-and-presence` cablea desde
   * `teardown(socket)` para una desconexión/`diagram:leave` bajo INV-WS-1
   * (design.md §D2): el alcance por diagrama es correcto ahí porque un
   * socket sirve un solo diagrama (D3 de `collaboration-gateway`) y la
   * contabilidad es por socket, no por usuario (D6). El método que ANTES
   * existía para desconexión (`releaseAllForUser`, alcance GLOBAL) se
   * eliminó: bajo D3+D6 su alcance era falso — cerrar una de cuatro ventanas
   * habría soltado los locks del usuario en las otras tres y en todos los
   * diagramas de todos los proyectos. Cero llamadores antes de esta
   * rebanada; ahora dos: `teardown` y (más adelante) `MembersService.remove()`.
   */
  releaseAllForUserInDiagrams(userId: string, diagramIds: string[], cause: LockReleased['cause'] = 'removed_from_project'): void {
    const keys = this.byUser.get(userId);
    if (!keys) return;
    const scope = new Set(diagramIds);
    for (const key of [...keys]) {
      const sep = key.indexOf(':');
      const diagramId = key.slice(0, sep);
      if (!scope.has(diagramId)) continue;
      const elementId = key.slice(sep + 1);
      this.byDiagram.get(diagramId)?.delete(elementId);
      this.deindex(userId, diagramId, elementId);
      this.onRelease?.(diagramId, elementId, cause);
    }
  }

  /**
   * SC-C18. Congelar suelta TODO lo del diagrama, de todos los usuarios.
   *
   * PRIVADO desde `diagram-freeze` (D4): soltar todo sin cerrar la compuerta es
   * justo el defecto que la propuesta encontró, así que no debe quedar ningún
   * camino que lo haga. El único llamador legítimo es `freeze()`, que marca y
   * suelta en el MISMO paso — no queda ni un tick entre «soltar todo» y
   * «prohibir tomar».
   */
  private releaseAllInDiagram(diagramId: string, cause: LockReleased['cause'] = 'frozen'): void {
    const locks = this.byDiagram.get(diagramId);
    if (!locks) return;
    for (const [elementId, lock] of locks) {
      this.deindex(lock.holder.userId, diagramId, elementId);
      this.onRelease?.(diagramId, elementId, cause);
    }
    locks.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Congelado (`diagram-freeze` D4)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cierra la compuerta y suelta todos los locks del diagrama, en un único
   * paso SÍNCRONO (D4). Sin `await` a propósito: es el mismo criterio que
   * `acquire`/`acquireAll` — no puede haber un punto de suspensión entre
   * marcar y soltar.
   */
  freeze(diagramId: string, info: DiagramFreezeInfo): void {
    this.frozen.set(diagramId, info);
    this.releaseAllInDiagram(diagramId, 'frozen');
  }

  /**
   * Abre la compuerta (D3). Se llama ANTES de difundir `diagram:unfrozen`: un
   * cliente que responde a ese evento con un `lock:request` inmediato tiene que
   * recibir el lock.
   */
  unfreeze(diagramId: string): void {
    this.frozen.delete(diagramId);
  }

  /** El estado que se le manda a quien se une o re-sincroniza (D7). `undefined` = compuerta abierta. */
  frozenInfo(diagramId: string): DiagramFreezeInfo | undefined {
    return this.frozen.get(diagramId);
  }

  /**
   * Borra TODO el rastro en memoria de un diagrama que se acaba de borrar
   * (`concurrency-ux` D9): sus locks y su entrada de la compuerta de congelado.
   *
   * SÍNCRONO y **sin emitir nada**, a diferencia de los otros métodos de
   * liberación: lo llama `DiagramDeletionController` inmediatamente después de
   * desalojar la sala, así que ya no queda nadie a quien avisarle. Emitir acá
   * sería hablarle a una sala vacía; el `lock:released` de la expulsión (D8)
   * sí se emite, porque ahí la sala sobrevive al desalojado.
   *
   * La entrada de la compuerta se borra por la misma razón por la que se
   * liberan los locks: el diagrama dejó de existir. Sin esto, la entrada
   * huérfana que D1 de `diagram-freeze` aceptó se quedaría en memoria hasta el
   * reinicio del proceso — fuga en un servidor de larga vida y estado que
   * afirma algo de un diagrama que ya no está. Es exactamente la deuda que D9
   * de `concurrency-ux` vino a cerrar.
   */
  forgetDiagram(diagramId: string): void {
    const locks = this.byDiagram.get(diagramId);
    if (locks) {
      // Deindexar SIEMPRE por el dueño del lock, nunca por el que borra: si no,
      // la clave `${diagramId}:${elementId}` queda stale en `byUser` y la
      // desconexión de ese dueño borraría un lock VIVO de otro.
      for (const [elementId, lock] of locks) this.deindex(lock.holder.userId, diagramId, elementId);
      this.byDiagram.delete(diagramId);
    }
    this.frozen.delete(diagramId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Barrido
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SC-C05. Cota superior de liberación: TTL + intervalo de barrido.
   * Con 15 s y 1 s, nunca más de 16 s. Es el número que el test asserta.
   */
  private sweep(): void {
    const now = Date.now();
    let swept = 0;
    for (const [diagramId, locks] of this.byDiagram) {
      for (const [elementId, lock] of locks) {
        if (lock.expiresAt > now) continue;
        locks.delete(elementId);
        this.deindex(lock.holder.userId, diagramId, elementId);
        this.onRelease?.(diagramId, elementId, 'expired');
        swept++;
      }
      if (locks.size === 0) this.byDiagram.delete(diagramId);
    }
    if (swept > 0) this.log.debug(`Vencidos ${swept} bloqueo(s)`);
  }

  // ───────────────────────────────────────────────────────────────────────────

  private locksOf(diagramId: string): Map<string, Lock> {
    let m = this.byDiagram.get(diagramId);
    if (!m) {
      m = new Map();
      this.byDiagram.set(diagramId, m);
    }
    return m;
  }

  private index(userId: string, diagramId: string, elementId: string) {
    let s = this.byUser.get(userId);
    if (!s) {
      s = new Set();
      this.byUser.set(userId, s);
    }
    s.add(`${diagramId}:${elementId}`);
  }

  private deindex(userId: string, diagramId: string, elementId: string) {
    const s = this.byUser.get(userId);
    if (!s) return;
    s.delete(`${diagramId}:${elementId}`);
    if (s.size === 0) this.byUser.delete(userId);
  }
}

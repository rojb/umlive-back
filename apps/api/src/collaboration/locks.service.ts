import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LockHolder } from '@umlive/contracts';

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

@Injectable()
export class LocksService implements OnModuleDestroy {
  private readonly log = new Logger(LocksService.name);

  /** diagramId → (elementId → Lock) */
  private readonly byDiagram = new Map<string, Map<string, Lock>>();

  /** Índice inverso userId → Set<`${diagramId}:${elementId}`>, para soltar en O(k) al desconectar. */
  private readonly byUser = new Map<string, Set<string>>();

  private readonly ttlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  /**
   * Callback que el gateway registra para difundir liberaciones. El servicio
   * no conoce el socket: mantenerlo así lo hace testeable sin levantar red.
   */
  private onRelease?: (diagramId: string, elementId: string, cause: string) => void;

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

  setReleaseListener(fn: (diagramId: string, elementId: string, cause: string) => void) {
    this.onRelease = fn;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Adquisición
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * SC-C01 / SC-C02 / SC-C03.
   *
   * Node corre una sola tarea por vez, así que este método es atómico respecto
   * de otras llamadas: no hay await adentro. Eso resuelve la carrera de SC-C03
   * sin sincronización explícita — y es la razón por la que NO debe volverse
   * async sin repensarlo.
   */
  acquire(diagramId: string, elementId: string, holder: LockHolder): LockOutcome {
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

    const expiresAt = now + this.ttlMs;
    locks.set(elementId, { elementId, holder, expiresAt });
    this.index(holder.userId, diagramId, elementId);
    return { ok: true, expiresAt };
  }

  /**
   * Adquisición atómica de varios (SC-C14: borrar exige clase + relaciones).
   * Si falla uno, no queda tomado ninguno — nada de estados a medias.
   */
  acquireAll(diagramId: string, elementIds: string[], holder: LockHolder): LockOutcome {
    const taken: string[] = [];
    for (const id of elementIds) {
      const r = this.acquire(diagramId, id, holder);
      if (!r.ok) {
        for (const t of taken) this.release(diagramId, t, holder.userId, 'released');
        return r;
      }
      taken.push(id);
    }
    return { ok: true, expiresAt: Date.now() + this.ttlMs };
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
   * Lo llama el pipeline de operaciones ANTES de tocar la base (SC-C08). Un
   * elemento libre se considera escribible: pedir el lock es responsabilidad
   * del cliente, pero no tenerlo no habilita a otro a pisarlo — porque si otro
   * lo tuviera, este chequeo fallaría.
   */
  canWrite(diagramId: string, elementIds: string[], userId: string): LockOutcome {
    for (const id of elementIds) {
      const holder = this.holderOf(diagramId, id);
      if (holder && holder.userId !== userId) return { ok: false, holder };
    }
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

  release(diagramId: string, elementId: string, userId: string, cause = 'released'): boolean {
    const locks = this.byDiagram.get(diagramId);
    const lock = locks?.get(elementId);
    if (!lock || lock.holder.userId !== userId) return false;
    locks!.delete(elementId);
    this.deindex(userId, diagramId, elementId);
    this.onRelease?.(diagramId, elementId, cause);
    return true;
  }

  /** SC-C06. Al cerrarse el socket, sin esperar el TTL. */
  releaseAllForUser(userId: string, cause = 'disconnected'): void {
    const keys = this.byUser.get(userId);
    if (!keys) return;
    for (const key of [...keys]) {
      const sep = key.indexOf(':');
      const diagramId = key.slice(0, sep);
      const elementId = key.slice(sep + 1);
      this.byDiagram.get(diagramId)?.delete(elementId);
      this.onRelease?.(diagramId, elementId, cause);
    }
    this.byUser.delete(userId);
  }

  /**
   * SC-C18. Congelar suelta TODO lo del diagrama, de todos los usuarios.
   * Se llama antes de difundir `diagram:frozen`.
   */
  releaseAllInDiagram(diagramId: string, cause = 'frozen'): void {
    const locks = this.byDiagram.get(diagramId);
    if (!locks) return;
    for (const [elementId, lock] of locks) {
      this.deindex(lock.holder.userId, diagramId, elementId);
      this.onRelease?.(diagramId, elementId, cause);
    }
    locks.clear();
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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActorKind, DiagramSync, OperationCommitted, OperationType, PayloadFor } from '@umlive/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DiagramContentService } from '../uml/diagram-content.service';

/**
 * `diagram:join` → `diagram:sync` (reconnect-and-presence/design.md §D3-D6).
 * Elige delta o estado completo según el hueco entre `lastVersion` y
 * `current_version`, sin materializar una sola fila de `diagram_snapshots`
 * (design.md §D5): mientras las 28 rutas HTTP sigan abiertas, una fila
 * escrita ahí afirmaría una correspondencia versión↔estado que puede ser
 * falsa, sin log con qué reconciliarla — la misma razón por la que D8 de
 * `collaboration-gateway` rechazó materializar el snapshot v0.
 *
 * Inyecta `PrismaService` porque el gateway NO lo hace (la barrera de D4/D8
 * de `collaboration-gateway`, `operations-pipeline`) — este archivo es la
 * única costura de lectura del log en esta rebanada.
 */
@Injectable()
export class ReconnectService {
  private readonly log = new Logger(ReconnectService.name);
  private readonly maxDelta: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly content: DiagramContentService,
    config: ConfigService,
  ) {
    // Mismo patrón que `LOCK_TTL_MS` (`locks.service.ts:52`): configuración,
    // no constante. El umbral es el punto donde el delta deja de ser más
    // barato que el estado completo — errarle degrada a "lo que ya hacía la
    // rebanada 1", no rompe nada (design.md §D6).
    this.maxDelta = Number(config.get('RECONNECT_MAX_DELTA') ?? 200);
  }

  /**
   * INV-RC-1 (design.md §D3): el llamador YA hizo `socket.join(room)` ANTES
   * de invocar esto, y `current_version` se lee ACÁ ANTES de leer filas del
   * log. Toda operación confirmada es entonces, o bien anterior a esta
   * lectura de versión (y está en el delta/snapshot), o bien posterior al
   * join (y llega por difusión al cliente, que la buferea hasta que el sync
   * aterriza). Si esto se invoca antes del join, se abre la ventana de
   * pérdida de SC-C24 — precondición de uso, no verificable en el tipo.
   */
  async sync(diagramId: string, lastVersion: number): Promise<DiagramSync> {
    const { currentVersion } = await this.prisma.diagram.findUniqueOrThrow({
      where: { id: diagramId },
      select: { currentVersion: true },
    });
    const current = Number(currentVersion);

    // Rama elegida por el HUECO, antes de consultar una sola fila (design.md
    // §D4 — contradicción #6 de la propuesta: `DATA-MODEL.md` §4.2 acota con
    // `LIMIT $max_delta` sin comparar el hueco, lo que produce un delta
    // truncado en silencio. Acá se decide antes).
    if (lastVersion <= 0) {
      // Reproducir la historia entera para construir algo que una consulta
      // entrega directo no tiene sentido — la rebanada 1 queda contenida
      // como caso particular, no reemplazada.
      return this.snapshot(diagramId, current);
    }
    if (lastVersion > current) {
      // Cliente que afirma saber más que el servidor (base reseteada,
      // diagrama recreado) — único de los cinco caminos que indica que algo
      // está mal.
      this.log.warn(`diagram:join con lastVersion (${lastVersion}) mayor a current_version (${current}) para ${diagramId} — cae a snapshot`);
      return this.snapshot(diagramId, current);
    }

    const gap = current - lastVersion;
    if (gap === 0) {
      return { mode: 'delta', fromVersion: lastVersion, toVersion: lastVersion, operations: [] };
    }
    if (gap > this.maxDelta) {
      return this.snapshot(diagramId, current);
    }

    // `take: maxDelta + 1` es diagnóstico, NUNCA un recorte silencioso: bajo
    // INV-RC-1, cualquier fila por encima de `gap` (que ya sabíamos <=
    // maxDelta al elegir esta rama) fue confirmada DESPUÉS de leer la
    // versión de arriba, o sea después del join, o sea ya llega al cliente
    // por difusión. El `warn` es una señal de que el umbral quedó chico, no
    // de que se perdió algo.
    const rows = await this.prisma.diagramOperation.findMany({
      where: { diagramId, version: { gt: lastVersion } },
      orderBy: { version: 'asc' },
      take: this.maxDelta + 1,
    });
    if (rows.length === this.maxDelta + 1) {
      this.log.warn(`delta al tope (${rows.length}) — commits concurrentes durante el sync de ${diagramId}`);
    }

    // `toVersion` sale de la ÚLTIMA FILA del delta, nunca de una segunda
    // lectura de `current_version` — eso lo hace verdadero por construcción
    // (design.md §D3).
    const toVersion = rows.length > 0 ? Number(rows.at(-1)!.version) : lastVersion;

    return {
      mode: 'delta',
      fromVersion: lastVersion,
      toVersion,
      operations: rows.map((row) => toCommitted(row)),
    };
  }

  /**
   * `version` MUST ser la leída ANTES de `getDiagramContent` (design.md §D5):
   * hay dos versiones disponibles (`current_version` leída acá arriba y
   * `state.diagram.currentVersion`, que también selecciona `getDiagramContent`)
   * y elegir la de adentro pierde operaciones en silencio si hay commits
   * concurrentes entre las dos lecturas. Errar hacia abajo (la de antes)
   * produce entrega al menos una vez — recuperable; errar hacia arriba
   * produce pérdida — no recuperable.
   *
   * `DiagramContent.diagram.currentVersion` viaja dentro de `state` y NO es
   * la autoridad. La autoridad es `DiagramSync.version`, el parámetro de acá.
   */
  private async snapshot(diagramId: string, version: number): Promise<DiagramSync> {
    const state = await this.content.getDiagramContent(diagramId);
    return { mode: 'snapshot', version, state, operations: [] };
  }
}

/**
 * Fila de `diagram_operations` → `OperationCommitted` — único lugar de esta
 * rebanada donde el cast a `PayloadFor<T>` y el `Number(bigint)` del borde
 * ocurren (design.md §D4, contradicción #11 de la propuesta: `payload` es
 * `Json` en el schema). Mismo patrón que `toCommitted` de
 * `operations.service.ts` — sólido porque la rebanada 2 escribe el payload
 * autoritativo (su D5); el aislamiento es para que el día que deje de serlo
 * haya un solo archivo que mirar.
 */
function toCommitted(row: {
  opId: string;
  diagramId: string;
  version: bigint;
  type: string;
  payload: Prisma.JsonValue;
  actorId: string | null;
  actorKind: string;
  aiTurnId: string | null;
  createdAt: Date;
}): OperationCommitted {
  const type = row.type as OperationType;
  return {
    opId: row.opId,
    diagramId: row.diagramId,
    version: Number(row.version),
    type,
    payload: row.payload as PayloadFor<typeof type>,
    actorId: row.actorId,
    actorKind: row.actorKind as ActorKind,
    aiTurnId: row.aiTurnId ?? undefined,
    committedAt: row.createdAt.toISOString(),
  };
}

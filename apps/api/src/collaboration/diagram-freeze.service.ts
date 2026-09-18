import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { DiagramFreezeInfo, DiagramSummary } from '@umlive/contracts';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { DIAGRAM_SUMMARY_SELECT, toDiagramSummary } from '../projects/diagram-summary';
import { CollaborationGateway } from './collaboration.gateway';
import { LocksService } from './locks.service';

/**
 * Congelado y descongelado de un diagrama completo (`diagram-freeze` D2, D3,
 * D5, D6).
 *
 * Es **estado de acceso, no contenido del modelo**: consume versión propia,
 * no entra a `diagram_operations` y no pasa por el pipeline — si fuera un
 * `OperationType`, la rama `423` rechazaría el propio descongelado y un
 * diagrama congelado no podría volver a abrirse nunca (propuesta, pregunta 3).
 *
 * Tres piezas, y el orden entre ellas es load-bearing:
 *
 *   1. una transacción CORTA que escribe las tres columnas juntas, con la
 *      idempotencia en el `WHERE` y la hora tomada DESPUÉS del `FOR UPDATE`;
 *   2. un paso SÍNCRONO después del `COMMIT`: la compuerta se cierra (y con
 *      ella se sueltan todos los locks, en un solo paso) y DESPUÉS se difunde
 *      `diagram:frozen`;
 *   3. una cola serial por `diagramId` que envuelve las dos anteriores.
 *
 * La autoridad de ESCRITURA sigue siendo la rama `423` de
 * `element-lock-enforcement`, que lee la base. La compuerta solo gobierna la
 * ADQUISICIÓN de locks.
 *
 * **Ampliado por `concurrency-ux` (D7):** el `DiagramSummary` que devuelven
 * `freeze`/`unfreeze` sale del mapper COMPARTIDO de
 * `projects/diagram-summary.ts`, importado **como archivo** y nunca como
 * módulo (mismo patrón que `diagram-scope.ts`): `CollaborationModule` ya
 * importa `ProjectsModule` en un solo sentido, y un módulo compartido acá
 * cerraría el ciclo que D1 de `diagram-freeze` resolvió mudando las rutas.
 * Como la transacción acaba de escribir las tres columnas, la fila releída
 * dentro de la misma transacción es la que produce el `freeze` correcto.
 */
@Injectable()
export class DiagramFreezeService implements OnModuleInit {
  private readonly log = new Logger(DiagramFreezeService.name);

  /**
   * Cola serial por diagrama (D5). El `FOR UPDATE` ordena los dos `COMMIT`,
   * pero **no ordena sus continuaciones en Node**: salen de dos conexiones
   * distintas. Con un congelado y un descongelado casi simultáneos (dos
   * pestañas del host) las continuaciones pueden invertirse y dejar la
   * compuerta cerrada con la base en `UNLOCKED`, los dos botones con
   * `count = 0` y sin forma de salir hasta reiniciar.
   *
   * `fn` incluye la transacción Y el paso posterior, así que el cambio N+1 no
   * arranca hasta que el N difundió. Alternativa rechazada: reconciliar la
   * compuerta cuando `count = 0` releyendo la fila — cura el estado recién en
   * el clic siguiente, y los clientes igual ven la inversión.
   */
  private readonly tail = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: LocksService,
    private readonly gateway: CollaborationGateway,
  ) {}

  /**
   * Hidratación de la compuerta al arrancar (D6), **antes de que el servidor
   * escuche**: Nest espera los `onModuleInit` de los providers antes de
   * `app.listen()`.
   *
   * Hidratar al UNIRSE sería una carrera: una lectura vieja con
   * `LOCKED_BY_HOST`, aplicada después de un descongelado, volvería a cerrar la
   * compuerta con la base en `UNLOCKED`. Al arrancar no hay locks, así que acá
   * no se emite nada — solo se cierra la compuerta de lo que ya estaba
   * congelado en la base.
   */
  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.diagram.findMany({
      where: { lockState: 'LOCKED_BY_HOST', deletedAt: null },
      select: {
        id: true,
        lockedAt: true,
        lockedByUser: { select: { id: true, displayName: true } },
      },
    });

    for (const row of rows) {
      const lockedByUser = row.lockedByUser;
      if (!lockedByUser) {
        // `ck_diagrams_lock_coherent` lo impide; si igual pasara, se cierra la
        // compuerta con un nombre de relleno. Ante la duda, queda cerrado.
        this.log.error(`Diagrama ${row.id} congelado sin host legible — ck_diagrams_lock_coherent debería impedirlo`);
      }
      const info: DiagramFreezeInfo = {
        by: { userId: lockedByUser?.id ?? '', displayName: lockedByUser?.displayName ?? '—' },
        at: (row.lockedAt ?? new Date()).toISOString(),
      };
      this.locks.freeze(row.id, info);
    }

    if (rows.length > 0) this.log.log(`Compuerta de congelado hidratada con ${rows.length} diagrama(s)`);
  }

  /** `POST .../freeze`. Devuelve el `DiagramSummary` con el estado ya aplicado. */
  async freeze(diagramId: string, host: CurrentUserPayload): Promise<DiagramSummary> {
    return this.serial(diagramId, async () => {
      const { count, at, summary } = await this.prisma.$transaction(
        async (tx) => {
          // Lock EXCLUSIVO de la fila (mismo patrón que `operations-pipeline`
          // D7). El driver adapter exige el cast a `uuid`: sin él manda el
          // parámetro como `text` y Postgres responde 42804.
          await tx.$queryRaw`SELECT 1 FROM diagrams WHERE id = ${diagramId}::uuid FOR UPDATE`;

          // La hora se toma DESPUÉS de obtener la fila, en JS, y NO con el
          // `now()` de Postgres dentro del `SET` (D2): PostgreSQL puede
          // calcular la tupla nueva ANTES de esperar el lock de fila, y la
          // hora quedaría anterior a la última operación que retenía la fila.
          // El MISMO valor va a `locked_at` y a `diagram:frozen.at`.
          const at = new Date();
          const { count } = await tx.diagram.updateMany({
            // Idempotencia en el `WHERE`, nunca en el `lockState` que hubiera
            // leído una guarda antes: ese valor puede estar viejo. Cero filas
            // afectadas = ya estaba congelado (o se borró en el medio), y
            // entonces no se suelta nada, no se difunde nada y `locked_at`
            // conserva su valor original.
            where: { id: diagramId, lockState: 'UNLOCKED', deletedAt: null },
            // Las TRES columnas juntas o ninguna (`ck_diagrams_lock_coherent`).
            data: { lockState: 'LOCKED_BY_HOST', lockedBy: host.id, lockedAt: at },
          });
          const row = await tx.diagram.findUniqueOrThrow({
            where: { id: diagramId },
            select: DIAGRAM_SUMMARY_SELECT,
          });
          return { count, at, summary: toDiagramSummary(row) };
        },
        // Mismos números que el pipeline: una transacción patológica que
        // retenga la fila más de 5 s muere con `P2028`, ruidoso y acotado, en
        // vez de colgar el diagrama.
        { timeout: 5000, maxWait: 2000 },
      );

      // Paso posterior al `COMMIT`, en el MISMO tick (D3) y en este orden:
      // `locks.freeze` primero (cierra la compuerta Y suelta todo, lo que emite
      // N `lock:released{cause:'frozen'}` por el oyente del gateway), y
      // `emitFreezeState` después. Un cliente que ve `diagram:frozen` ya tiene
      // el mapa de locks vacío — al revés habría un intervalo con el cartel de
      // congelado y bordes de lock ajenos a la vez, que es el estado que
      // `ck_diagrams_lock_coherent` prohíbe en la base, visible en pantalla.
      if (count > 0) {
        const info: DiagramFreezeInfo = {
          by: { userId: host.id, displayName: host.displayName },
          at: at.toISOString(),
        };
        this.locks.freeze(diagramId, info);
        this.gateway.emitFreezeState(diagramId, 'diagram:frozen', info);
      }

      return summary;
    });
  }

  /** `DELETE .../freeze`. Simétrico a `freeze` (D2, D3). */
  async unfreeze(diagramId: string, host: CurrentUserPayload): Promise<DiagramSummary> {
    return this.serial(diagramId, async () => {
      const { count, at, summary } = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM diagrams WHERE id = ${diagramId}::uuid FOR UPDATE`;
          const at = new Date();
          const { count } = await tx.diagram.updateMany({
            where: { id: diagramId, lockState: 'LOCKED_BY_HOST', deletedAt: null },
            // Descongelar: `'UNLOCKED'`, `null`, `null` — las tres juntas.
            data: { lockState: 'UNLOCKED', lockedBy: null, lockedAt: null },
          });
          const row = await tx.diagram.findUniqueOrThrow({
            where: { id: diagramId },
            select: DIAGRAM_SUMMARY_SELECT,
          });
          return { count, at, summary: toDiagramSummary(row) };
        },
        { timeout: 5000, maxWait: 2000 },
      );

      // La compuerta se ABRE antes de difundir: un cliente que responde a
      // `diagram:unfrozen` con un `lock:request` inmediato recibe el lock.
      if (count > 0) {
        const info: DiagramFreezeInfo = {
          by: { userId: host.id, displayName: host.displayName },
          at: at.toISOString(),
        };
        this.locks.unfreeze(diagramId);
        this.gateway.emitFreezeState(diagramId, 'diagram:unfrozen', info);
      }

      return summary;
    });
  }

  /**
   * Cola serial por `diagramId` (D5). El `.catch` antes de la limpieza es
   * deliberado: la cola NO depende de que `fn` no lance para seguir viva, y
   * sin él una promesa rechazada dejaría un rechazo sin manejar colgado de la
   * limpieza. El error igual sigue viajando al llamador (el controlador lo
   * convierte en un 500).
   */
  private serial<T>(diagramId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tail.get(diagramId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.tail.set(diagramId, next);
    void next
      .catch(() => undefined)
      .then(() => {
        if (this.tail.get(diagramId) === next) this.tail.delete(diagramId);
      });
    return next;
  }
}

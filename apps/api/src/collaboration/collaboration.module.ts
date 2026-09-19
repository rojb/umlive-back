import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UmlModule } from '../uml/uml.module';
import { CollaborationGateway } from './collaboration.gateway';
import { DiagramDeletionController } from './diagram-deletion.controller';
import { DiagramFreezeController } from './diagram-freeze.controller';
import { DiagramFreezeService } from './diagram-freeze.service';
import { LocksService } from './locks.service';
import { MemberRemovalController } from './member-removal.controller';
import { OperationDispatcher } from './operation-dispatch';
import { OperationsService } from './operations.service';
import { ReconnectService } from './reconnect.service';

/**
 * Tiempo real y concurrencia — M3 (`collaboration-gateway`, rebanada 1 de 4;
 * `operations-pipeline`, rebanada 2; SPECS.md §4 asigna C.2/C.5/C.6 a M3, no
 * M4).
 *
 * Piezas:
 *   locks.service.ts          exclusión por elemento — hecho (rebanada 1), cableado (rebanada 3);
 *                             su `canWrite()` pasa de PROTOCOLO a EXIGENCIA en la rebanada 4
 *                             (`element-lock-enforcement`: `OperationsService` lo inyecta y lo
 *                             llama como último paso antes de mutar, dentro de la transacción)
 *   operations.service.ts     validación, orden y persistencia del log — hecho (rebanada 2)
 *   operation-dispatch.ts     mapa OperationType → …In(tx), 32 entradas — hecho (rebanada 2)
 *   operation-rejection.ts    traducción de errores → OperationRejected — hecho (rebanada 2);
 *                             desde la rebanada 4 traduce también `DiagramFrozenError`/`ElementLockedError`
 *   lock-targets.ts           traductor total de LOCK_REQUIREMENTS → elementId[] — rebanada 4
 *   reconnect.service.ts      delta/snapshot de `diagram:sync` — hecho (esta rebanada)
 *   presence.ts               color por sala, roster — rebanada 3 (helpers puros)
 *   collaboration.gateway.ts  el WebSocket que las une — modificado esta rebanada (join honra `lastVersion`)
 *   diagram-freeze.service.ts congelar/descongelar (`diagram-freeze`, rebanada 3 de M4): transacción,
 *                             paso posterior, cola serial e hidratación de la compuerta
 *   diagram-freeze.controller.ts las dos rutas del host — en ESTE módulo, no en `projects/`, para no
 *                             cerrar el ciclo Collaboration → Projects (D1 de `diagram-freeze`)
 *   member-removal.controller.ts  quitar a un miembro y desalojarlo (SC-A12) — en ESTE módulo por el
 *                             mismo motivo, con `MembersService` importado del módulo de proyectos y
 *                             SIN `forwardRef` (`concurrency-ux` D8)
 *   diagram-deletion.controller.ts  borrar un diagrama y desalojar la sala (D9) — ídem, con
 *                             `DiagramsService`; el `@Delete` de `projects/diagrams.controller.ts` se fue
 *
 * `AuthModule` por `SocketAuthService`, `ProjectsModule` por
 * `ProjectAccessResolver` (y ahora también por `MembersService`, que
 * `MemberRemovalController` inyecta), `UmlModule` por `DiagramContentService`
 * (design.md §D10 de la rebanada 1, y §D4 de `reconnect-and-presence` para
 * `ReconnectService`) Y por los cuatro services de mutación (`ElementsService`,
 * `RelationshipsService`, `FeaturesService`, `ParametersService`) que
 * `OperationDispatcher` inyecta (contradicción #7 de la propuesta de
 * `operations-pipeline`).
 */
@Module({
  imports: [AuthModule, ProjectsModule, UmlModule],
  controllers: [DiagramFreezeController, MemberRemovalController, DiagramDeletionController],
  providers: [LocksService, CollaborationGateway, OperationsService, OperationDispatcher, ReconnectService, DiagramFreezeService],
  // `LocksService` desde M3. Desde `ai-text-instructions` (rebanada 2/4 de M6,
  // tarea 4.5) también `OperationsService` y `CollaborationGateway`: el turno
  // de IA necesita aplicar su lote por la MISMA puerta que un humano, liberar
  // los locks que tomó y difundir después del `COMMIT`. Nadie importa
  // `AiModule`, así que la dependencia va en un solo sentido y no hay ciclo.
  exports: [LocksService, OperationsService, CollaborationGateway],
})
export class CollaborationModule {}

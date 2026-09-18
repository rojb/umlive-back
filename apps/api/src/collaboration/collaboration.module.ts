import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UmlModule } from '../uml/uml.module';
import { CollaborationGateway } from './collaboration.gateway';
import { LocksService } from './locks.service';
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
 *
 * `AuthModule` por `SocketAuthService`, `ProjectsModule` por
 * `ProjectAccessResolver`, `UmlModule` por `DiagramContentService` (design.md
 * §D10 de la rebanada 1, y §D4 de `reconnect-and-presence` para `ReconnectService`)
 * Y por los cuatro services de mutación (`ElementsService`,
 * `RelationshipsService`, `FeaturesService`, `ParametersService`) que
 * `OperationDispatcher` inyecta (contradicción #7 de la propuesta de
 * `operations-pipeline`).
 */
@Module({
  imports: [AuthModule, ProjectsModule, UmlModule],
  providers: [LocksService, CollaborationGateway, OperationsService, OperationDispatcher, ReconnectService],
  exports: [LocksService],
})
export class CollaborationModule {}

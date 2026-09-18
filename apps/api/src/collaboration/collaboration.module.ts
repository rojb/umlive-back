import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UmlModule } from '../uml/uml.module';
import { CollaborationGateway } from './collaboration.gateway';
import { LocksService } from './locks.service';
import { OperationDispatcher } from './operation-dispatch';
import { OperationsService } from './operations.service';

/**
 * Tiempo real y concurrencia — M3 (`collaboration-gateway`, rebanada 1 de 4;
 * `operations-pipeline`, rebanada 2; SPECS.md §4 asigna C.2/C.5/C.6 a M3, no
 * M4).
 *
 * Piezas:
 *   locks.service.ts          exclusión por elemento — hecho (rebanada 1)
 *   operations.service.ts     validación, orden y persistencia del log — hecho (esta rebanada)
 *   operation-dispatch.ts     mapa OperationType → …In(tx), 32 entradas — hecho (esta rebanada)
 *   operation-rejection.ts    traducción de errores → OperationRejected — hecho (esta rebanada)
 *   presence.service.ts       cursores y selección — rebanada 3
 *   collaboration.gateway.ts  el WebSocket que las une — modificado esta rebanada (handler `op:submit`)
 *
 * `AuthModule` por `SocketAuthService`, `ProjectsModule` por
 * `ProjectAccessResolver`, `UmlModule` por `DiagramContentService` (design.md
 * §D10 de la rebanada 1) Y por los cuatro services de mutación
 * (`ElementsService`, `RelationshipsService`, `FeaturesService`,
 * `ParametersService`) que `OperationDispatcher` inyecta (contradicción #7
 * de la propuesta de `operations-pipeline`).
 */
@Module({
  imports: [AuthModule, ProjectsModule, UmlModule],
  providers: [LocksService, CollaborationGateway, OperationsService, OperationDispatcher],
  exports: [LocksService],
})
export class CollaborationModule {}

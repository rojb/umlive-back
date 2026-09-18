import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { UmlModule } from '../uml/uml.module';
import { CollaborationGateway } from './collaboration.gateway';
import { LocksService } from './locks.service';

/**
 * Tiempo real y concurrencia — M3 (`collaboration-gateway`, rebanada 1 de 4;
 * SPECS.md §4 asigna C.2/C.5/C.6 a M3, no M4).
 *
 * Piezas previstas:
 *   locks.service.ts          exclusión por elemento — hecho
 *   operations.service.ts     validación, orden y persistencia del log — rebanada 3
 *   presence.service.ts       cursores y selección — rebanada 3
 *   collaboration.gateway.ts  el WebSocket que las une — hecho (esta rebanada)
 *
 * `AuthModule` por `SocketAuthService`, `ProjectsModule` por
 * `ProjectAccessResolver`, `UmlModule` por `DiagramContentService`
 * (design.md §D10).
 */
@Module({
  imports: [AuthModule, ProjectsModule, UmlModule],
  providers: [LocksService, CollaborationGateway],
  exports: [LocksService],
})
export class CollaborationModule {}

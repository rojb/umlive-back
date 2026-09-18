import { Module } from '@nestjs/common';
import { DiagramsController } from './diagrams.controller';
import { DiagramsService } from './diagrams.service';
import { ProjectAccessGuard } from './guards/project-access.guard';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { ProjectAccessResolver } from './project-access.resolver';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Un solo módulo para los tres pares (design.md §1): comparten el guard, la
 * resolución de rol y el `ProjectContext` que el guard deja en la petición.
 * `ProjectAccessGuard` se registra acá TAMBIÉN como provider — no solo en
 * `app.module.ts` como `APP_GUARD` — y se exporta para que M2+ lo reutilice
 * sin rediseñar (tasks.md 3.8).
 *
 * `ProjectAccessResolver` (collaboration-gateway/design.md §D2) es la
 * consulta diagrama→proyecto→membresía MUDADA fuera del guard. Se exporta
 * para que `CollaborationGateway` la llame sin duplicar la regla que
 * sostiene el aislamiento de inquilinos.
 */
@Module({
  controllers: [ProjectsController, MembersController, DiagramsController],
  providers: [ProjectsService, MembersService, DiagramsService, ProjectAccessGuard, ProjectAccessResolver],
  exports: [ProjectAccessGuard, ProjectAccessResolver],
})
export class ProjectsModule {}

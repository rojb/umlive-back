import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { DashboardResponse, ProjectDetail, ProjectSummary } from '@umlive/contracts';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectContext } from './guards/project-context.decorator';
import { RequiresProjectAction } from './guards/requires-project-action.decorator';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * FR-A06. Sin `:projectId` en la ruta: `ProjectAccessGuard` pasa de largo
   * (no hay parámetro de proyecto que resolver) y NO lleva
   * `@RequiresProjectAction` — cualquier autenticado la ejecuta, por
   * construcción (design.md §2.4).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateProjectDto): Promise<ProjectSummary> {
    return this.projects.create(user.id, dto);
  }

  /** FR-G04. Lista propia — tampoco lleva `:projectId`. */
  @Get()
  findAll(@CurrentUser() user: CurrentUserPayload): Promise<DashboardResponse> {
    return this.projects.findAllForUser(user.id);
  }

  @Get(':projectId')
  @RequiresProjectAction('project.view')
  findOne(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @ProjectContext() ctx: ProjectContext,
  ): Promise<ProjectDetail> {
    return this.projects.findOne(projectId, ctx.role);
  }
}

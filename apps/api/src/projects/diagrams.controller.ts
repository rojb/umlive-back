import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { DiagramSummary } from '@umlive/contracts';
import { RenameDiagramDto } from './dto/rename-diagram.dto';
import { DiagramsService } from './diagrams.service';
import { RequiresProjectAction } from './guards/requires-project-action.decorator';

/**
 * Crear y renombrar diagramas. **El `@Delete` se fue** (`concurrency-ux` D9):
 * borrar exige desalojar a los que están adentro por socket, y esa ruta vive
 * en `collaboration/diagram-deletion.controller.ts`, con la misma URL y la
 * misma acción de autorización. Con dos handlers para la misma ruta, el que
 * Express registró primero gana y el otro queda muerto sin que nada avise.
 */
@Controller('projects/:projectId/diagrams')
export class DiagramsController {
  constructor(private readonly diagrams: DiagramsService) {}

  @Post()
  @RequiresProjectAction('diagram.create')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: RenameDiagramDto,
  ): Promise<DiagramSummary> {
    return this.diagrams.create(projectId, dto);
  }

  @Patch(':diagramId')
  @RequiresProjectAction('diagram.rename')
  rename(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Body() dto: RenameDiagramDto,
  ): Promise<DiagramSummary> {
    return this.diagrams.rename(diagramId, dto);
  }
}

import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { DiagramSummary } from '@umlive/contracts';
import { RenameDiagramDto } from './dto/rename-diagram.dto';
import { DiagramsService } from './diagrams.service';
import { RequiresProjectAction } from './guards/requires-project-action.decorator';

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

  @Delete(':diagramId')
  @RequiresProjectAction('diagram.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('diagramId', ParseUUIDPipe) diagramId: string): Promise<void> {
    return this.diagrams.softDelete(diagramId);
  }
}

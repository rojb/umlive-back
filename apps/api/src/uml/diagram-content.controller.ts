import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { DiagramContent } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { DiagramContentService } from './diagram-content.service';

/**
 * Mismo prefijo que `DiagramsController` (`projects/`), en otro módulo
 * (design.md §8, desviación deliberada respecto de la propuesta):
 * `DiagramsService` es ciclo de vida (crear/renombrar/borrar suave); el
 * contenido es el modelo UML. NestJS admite dos controllers con el mismo
 * prefijo mientras no colisionen método+ruta — `GET :diagramId` no colisiona
 * con el `POST`/`PATCH`/`DELETE` ya existentes en `DiagramsController`.
 */
@Controller('projects/:projectId/diagrams')
export class DiagramContentController {
  constructor(private readonly content: DiagramContentService) {}

  @Get(':diagramId')
  @RequiresProjectAction('diagram.view')
  get(@Param('diagramId', ParseUUIDPipe) diagramId: string): Promise<DiagramContent> {
    return this.content.getDiagramContent(diagramId);
  }
}

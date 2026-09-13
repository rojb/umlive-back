import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { ElementLayoutView, UmlElementView } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { CreateElementDto } from './dto/create-element.dto';
import { MoveElementDto } from './dto/move-element.dto';
import { RenameElementDto } from './dto/rename-element.dto';
import { ResizeElementDto } from './dto/resize-element.dto';
import { SetElementAbstractDto } from './dto/set-element-abstract.dto';
import { ElementsService } from './elements.service';

/**
 * Rutas planas por UUID de elemento (design.md §2). `:projectId`/`:diagramId`
 * los valida `ProjectAccessGuard` (global); `:elementId` lo valida
 * `assertElementInDiagram` dentro del servicio, en la misma transacción que
 * la escritura (design.md §1). El cuerpo NUNCA lleva el verbo ni el tipo del
 * objetivo — eso vive en el método HTTP y en esta ruta.
 */
@Controller('projects/:projectId/diagrams/:diagramId/elements')
export class ElementsController {
  constructor(private readonly elements: ElementsService) {}

  @Post()
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('diagramId', ParseUUIDPipe) diagramId: string, @Body() dto: CreateElementDto): Promise<UmlElementView> {
    return this.elements.createElement(diagramId, dto);
  }

  @Patch(':elementId/name')
  @RequiresProjectAction('diagram.edit')
  rename(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: RenameElementDto,
  ): Promise<UmlElementView> {
    return this.elements.renameElement(diagramId, elementId, dto);
  }

  @Patch(':elementId/abstract')
  @RequiresProjectAction('diagram.edit')
  setAbstract(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: SetElementAbstractDto,
  ): Promise<UmlElementView> {
    return this.elements.setElementAbstract(diagramId, elementId, dto);
  }

  @Patch(':elementId/position')
  @RequiresProjectAction('diagram.edit')
  move(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: MoveElementDto,
  ): Promise<ElementLayoutView> {
    return this.elements.moveElement(diagramId, elementId, dto);
  }

  @Patch(':elementId/size')
  @RequiresProjectAction('diagram.edit')
  resize(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: ResizeElementDto,
  ): Promise<ElementLayoutView> {
    return this.elements.resizeElement(diagramId, elementId, dto);
  }

  @Delete(':elementId')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
  ): Promise<void> {
    return this.elements.deleteElement(diagramId, elementId);
  }
}

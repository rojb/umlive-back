import { Injectable } from '@nestjs/common';
import type { ElementLayoutView, UmlElementView } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { assertElementInDiagram } from './diagram-scope';
import type { CreateElementDto } from './dto/create-element.dto';
import type { MoveElementDto } from './dto/move-element.dto';
import type { RenameElementDto } from './dto/rename-element.dto';
import type { ResizeElementDto } from './dto/resize-element.dto';
import type { SetElementAbstractDto } from './dto/set-element-abstract.dto';
import { toElementView, toLayoutView } from './uml-mappers';
import { handleUniqueViolation } from './uml-errors';

/**
 * `createElement`, `renameElement`, `setElementAbstract`, `moveElement`,
 * `resizeElement`, `deleteElement` (design.md §2, §12; tasks.md 3.2).
 *
 * `moveElement`/`resizeElement` son DOS funciones, no un `updateLayout`
 * (design.md §2.1): el cliente ya sabe cuál gesto ocurrió y no hay que
 * reconstruir la intención desde un diff.
 */
@Injectable()
export class ElementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `uml_elements` + `element_layouts` en UNA transacción — un `UmlElement`
   * sin fila de layout es un elemento que el lienzo no puede ubicar
   * (design.md §2.1, spec "Alta de clasificador con miembros ordenados").
   */
  async createElement(diagramId: string, dto: CreateElementDto): Promise<UmlElementView> {
    try {
      const element = await this.prisma.$transaction(async (tx) => {
        const created = await tx.umlElement.create({
          data: {
            diagramId,
            parentId: dto.parentId,
            kind: dto.kind,
            name: dto.name,
            isAbstract: dto.isAbstract ?? false,
            stereotype: dto.stereotype ?? null,
            body: dto.body ?? null,
          },
        });
        await tx.elementLayout.create({
          data: { elementId: created.id, x: dto.x, y: dto.y, width: dto.width, height: dto.height },
        });
        return created;
      });
      return toElementView(element);
    } catch (err) {
      handleUniqueViolation(err, dto.name ?? '');
    }
  }

  async renameElement(diagramId: string, elementId: string, dto: RenameElementDto): Promise<UmlElementView> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await assertElementInDiagram(tx, elementId, diagramId);
        const updated = await tx.umlElement.update({ where: { id: elementId }, data: { name: dto.name } });
        return toElementView(updated);
      });
    } catch (err) {
      handleUniqueViolation(err, dto.name);
    }
  }

  async setElementAbstract(diagramId: string, elementId: string, dto: SetElementAbstractDto): Promise<UmlElementView> {
    return this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);
      const updated = await tx.umlElement.update({ where: { id: elementId }, data: { isAbstract: dto.isAbstract } });
      return toElementView(updated);
    });
  }

  async moveElement(diagramId: string, elementId: string, dto: MoveElementDto): Promise<ElementLayoutView> {
    return this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);
      const layout = await tx.elementLayout.update({ where: { elementId }, data: { x: dto.x, y: dto.y } });
      return toLayoutView(layout);
    });
  }

  async resizeElement(diagramId: string, elementId: string, dto: ResizeElementDto): Promise<ElementLayoutView> {
    return this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);
      const layout = await tx.elementLayout.update({
        where: { elementId },
        data: { width: dto.width, height: dto.height },
      });
      return toLayoutView(layout);
    });
  }

  /** `onDelete: Cascade` en `schema.prisma` se encarga de layout, features, parámetros, literales e hijos. */
  async deleteElement(diagramId: string, elementId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);
      await tx.umlElement.delete({ where: { id: elementId } });
    });
  }
}

import { ConflictException, Injectable } from '@nestjs/common';
import { UML_ERROR, type ElementLayoutView, type IncidentRelationshipView, type UmlElementView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertElementInDiagram } from './diagram-scope';
import type { CreateElementDto } from './dto/create-element.dto';
import type { MoveElementDto } from './dto/move-element.dto';
import type { RenameElementDto } from './dto/rename-element.dto';
import type { ResizeElementDto } from './dto/resize-element.dto';
import type { SetElementAbstractDto } from './dto/set-element-abstract.dto';
import { toElementView, toLayoutView } from './uml-mappers';
import { handleUniqueViolation } from './uml-errors';

type Tx = Prisma.TransactionClient;

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

  /**
   * `onDelete: Cascade` en `schema.prisma` se encarga de layout, features,
   * parámetros, literales e hijos. Pero `sourceElement`/`targetElement` de
   * `uml_relationships` y `element` de `uml_relationship_ends` son
   * `Restrict` (FR-C07, comentario de `schema.prisma:450-454`): borrar una
   * clase con relaciones incidentes revienta `P2003` sin comprobación previa
   * (design.md D6, tasks.md 3.1).
   *
   * Comprobación previa AUTORITATIVA, dentro de la misma transacción que el
   * `delete()`: si hay ≥1 relación incidente, `409 { code, count,
   * relationships }` sin borrar nada. **Nunca una cascada manual** — el
   * bloque de `DATA-MODEL.md:895-906` arranca con "the service has already
   * verified in-memory locks": es M4 bajo FR-C07, no esta unidad (design.md
   * D6 lo rechaza explícitamente).
   *
   * El `catch` de `P2003` de abajo es solo red de CARRERA (no la fuente del
   * `409`): si entre la comprobación previa y el `DELETE` alguien más crea
   * una relación incidente, la base rechaza el borrado igual, se reconsulta
   * una vez, y se responde `409` si ahora sí aparece algo. Si la relectura
   * sigue vacía, se relanza el error tal cual — un `P2003` sin incidentes
   * visibles es un bug real, no algo para disfrazar de `409` genérico.
   */
  async deleteElement(diagramId: string, elementId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await assertElementInDiagram(tx, elementId, diagramId);

        const incidents = await this.findIncidentRelationships(tx, elementId);
        if (incidents.length > 0) {
          throw new ConflictException({
            code: UML_ERROR.ELEMENT_HAS_RELATIONSHIPS,
            count: incidents.length,
            relationships: incidents,
          });
        }

        await tx.umlElement.delete({ where: { id: elementId } });
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        const incidents = await this.findIncidentRelationships(this.prisma, elementId);
        if (incidents.length > 0) {
          throw new ConflictException({
            code: UML_ERROR.ELEMENT_HAS_RELATIONSHIPS,
            count: incidents.length,
            relationships: incidents,
          });
        }
      }
      throw err;
    }
  }

  /**
   * Relaciones incidentes por `sourceElementId OR targetElementId OR
   * ends.elementId`, unificadas por `relationshipId` (D6). La unificación es
   * por construcción, no por un `Set`/`distinct` manual: la consulta filtra
   * `UmlRelationship` (no `UmlRelationshipEnd`), así que cada relación
   * aparece como máximo una fila sin importar cuántas de las tres
   * condiciones cumpla a la vez (p. ej. una `ASSOCIATION` cumple `source`/
   * `target` Y `ends.elementId` para el mismo `elementId`). Orden
   * `createdAt` (design.md D6).
   */
  private async findIncidentRelationships(tx: Tx, elementId: string): Promise<IncidentRelationshipView[]> {
    const incidents = await tx.umlRelationship.findMany({
      where: {
        OR: [{ sourceElementId: elementId }, { targetElementId: elementId }, { ends: { some: { elementId } } }],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        sourceElement: { select: { id: true, name: true } },
        targetElement: { select: { id: true, name: true } },
      },
    });

    return incidents.map((r) => {
      const other = r.sourceElementId === elementId ? r.targetElement : r.sourceElement;
      return {
        relationshipId: r.id,
        kind: r.kind,
        name: r.name,
        otherElementId: other.id,
        otherElementName: other.name,
      };
    });
  }
}

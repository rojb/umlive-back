import { ConflictException, Injectable } from '@nestjs/common';
import {
  normalizeStereotype,
  StereotypeTooLongError,
  UML_ERROR,
  type ElementLayoutView,
  type IncidentRelationshipView,
  type UmlElementView,
} from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertElementInDiagram } from './diagram-scope';
import { collectSubtreeIds } from './element-subtree';
import type { CreateElementDto } from './dto/create-element.dto';
import type { MoveElementDto } from './dto/move-element.dto';
import type { RenameElementDto } from './dto/rename-element.dto';
import type { ResizeElementDto } from './dto/resize-element.dto';
import type { SetElementAbstractDto } from './dto/set-element-abstract.dto';
import type { SetElementBodyDto } from './dto/set-element-body.dto';
import type { SetElementParentDto } from './dto/set-element-parent.dto';
import type { SetElementStereotypeDto } from './dto/set-element-stereotype.dto';
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

  /**
   * `uml-validation` fase 1 (design.md D1, D3, D4; tasks.md 1.6). Orden fijo
   * DENTRO de la misma transacción que el `UPDATE`, nunca antes de abrirla
   * (spec "Package como contenedor"): pertenencia al diagrama (elemento y
   * padre propuesto) → regla de padre por `kind` DEL HIJO (D4, no del padre)
   * → `409 invalid_parent_kind` si falla → guarda de ciclo de contención
   * (`collectSubtreeIds`, D1) → `409 containment_cycle` → `UPDATE`,
   * envuelto en `handleUniqueViolation` con el nombre del elemento MOVIDO
   * (no el del contenedor destino) — mover `Order` a un paquete que ya
   * tiene un `Order` es el `element_name_taken` de siempre por una ruta
   * nueva, no un caso distinto.
   */
  async setElementParent(diagramId: string, elementId: string, dto: SetElementParentDto): Promise<UmlElementView> {
    let movedName = '';
    try {
      return await this.prisma.$transaction(async (tx) => {
        await assertElementInDiagram(tx, elementId, diagramId);
        const child = await tx.umlElement.findUniqueOrThrow({ where: { id: elementId }, select: { kind: true, name: true } });
        movedName = child.name ?? '';

        if (dto.parentId !== null) {
          await assertElementInDiagram(tx, dto.parentId, diagramId);
          const parent = await tx.umlElement.findUniqueOrThrow({ where: { id: dto.parentId }, select: { kind: true } });

          // D4: la regla se decide por el `kind` del HIJO, no del padre.
          // `COMMENT` admite cualquier no-`COMMENT` (o `null`); los otros
          // seis admiten solo `PACKAGE` (o `null`).
          const parentAllowed = child.kind === 'COMMENT' ? parent.kind !== 'COMMENT' : parent.kind === 'PACKAGE';
          if (!parentAllowed) {
            throw new ConflictException({ code: UML_ERROR.INVALID_PARENT_KIND, parentKind: parent.kind });
          }

          // El root (`elementId`) se incluye en `collectSubtreeIds` (D1) —
          // cubre el autolazo (`parentId === elementId`) con el mismo
          // rechazo que un ciclo más largo.
          const subtreeIds = await collectSubtreeIds(tx, elementId);
          if (subtreeIds.includes(dto.parentId)) {
            throw new ConflictException({ code: UML_ERROR.CONTAINMENT_CYCLE });
          }
        }

        const updated = await tx.umlElement.update({ where: { id: elementId }, data: { parentId: dto.parentId } });
        return toElementView(updated);
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      handleUniqueViolation(err, movedName);
    }
  }

  /**
   * `uml-validation` fase 1 (design.md D10; tasks.md 1.7). `normalizeStereotype`
   * es la MISMA función pura que usa `setRelationshipStereotype` — ninguna
   * de las dos reimplementa la normalización.
   */
  async setElementStereotype(diagramId: string, elementId: string, dto: SetElementStereotypeDto): Promise<UmlElementView> {
    return this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);

      let stereotype: string | null;
      try {
        stereotype = normalizeStereotype(dto.stereotype);
      } catch (err) {
        if (err instanceof StereotypeTooLongError) {
          throw new ConflictException({ code: UML_ERROR.STEREOTYPE_INVALID });
        }
        throw err;
      }

      const updated = await tx.umlElement.update({ where: { id: elementId }, data: { stereotype } });
      return toElementView(updated);
    });
  }

  /**
   * `uml-validation` fase 1 (spec "Package como contenedor — tres
   * mutaciones"; tasks.md 1.7). Un cuerpo en una clase no es un comentario
   * UML — `409`, no `400`: depende del `kind` persistido, no de la forma
   * del cuerpo (mismo criterio que `invalid_parent_kind`).
   */
  async setElementBody(diagramId: string, elementId: string, dto: SetElementBodyDto): Promise<UmlElementView> {
    return this.prisma.$transaction(async (tx) => {
      await assertElementInDiagram(tx, elementId, diagramId);
      const element = await tx.umlElement.findUniqueOrThrow({ where: { id: elementId }, select: { kind: true } });
      if (element.kind !== 'COMMENT') {
        throw new ConflictException({ code: UML_ERROR.BODY_REQUIRES_COMMENT });
      }

      const updated = await tx.umlElement.update({ where: { id: elementId }, data: { body: dto.body } });
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
   * `delete()`: si hay ≥1 relación incidente **en el elemento o en
   * cualquiera de sus descendientes por `parent_id`**, `409 { code, count,
   * relationships }` sin borrar nada. **Nunca una cascada manual** — el
   * bloque de `DATA-MODEL.md:895-906` arranca con "the service has already
   * verified in-memory locks": es M4 bajo FR-C07, no esta unidad (design.md
   * D6 lo rechaza explícitamente).
   *
   * **Corrección de `uml-validation` (Hallazgo 1, design.md D2, tasks.md
   * 0.2)** — la bomba: la comprobación previa miraba SOLO el elemento
   * suelto. `parent_id` es `CASCADE`; las FK de relación son `RESTRICT`.
   * Borrar un `PACKAGE` que contiene una clase con relaciones: el
   * pre-chequeo del elemento suelto encontraba cero incidencias → `DELETE`
   * → Postgres cascadeaba a los hijos → `RESTRICT` → `23503` → la red de
   * `P2003` relistaba incidencias **del paquete**, volvía vacía, y
   * relanzaba → `500`. Ahora la comprobación (y su red de `P2003`) recorren
   * `collectSubtreeIds(tx, elementId)` — el elemento y TODO su subárbol.
   *
   * El `catch` de `P2003` de abajo es solo red de CARRERA (no la fuente del
   * `409`): si entre la comprobación previa y el `DELETE` alguien más crea
   * una relación incidente, la base rechaza el borrado igual, se reconsulta
   * una vez **sobre el mismo subárbol**, y se responde `409` si ahora sí
   * aparece algo. Si la relectura sigue vacía, se relanza el error tal cual
   * — un `P2003` sin incidentes visibles es un bug real, no algo para
   * disfrazar de `409` genérico.
   */
  async deleteElement(diagramId: string, elementId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await assertElementInDiagram(tx, elementId, diagramId);

        const subtreeIds = await collectSubtreeIds(tx, elementId);
        const incidents = await this.findIncidentRelationships(tx, subtreeIds);
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
        const subtreeIds = await collectSubtreeIds(this.prisma, elementId);
        const incidents = await this.findIncidentRelationships(this.prisma, subtreeIds);
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
   * Relaciones incidentes sobre CUALQUIER elemento de `elementIds` (el
   * subárbol completo desde `uml-validation`, antes solo el elemento
   * suelto), por `sourceElementId OR targetElementId OR ends.elementId`,
   * unificadas por `relationshipId` (D6). La unificación es por
   * construcción, no por un `Set`/`distinct` manual: la consulta filtra
   * `UmlRelationship` (no `UmlRelationshipEnd`), así que cada relación
   * aparece como máximo una fila sin importar cuántas de las tres
   * condiciones cumpla a la vez, e incluso si ambas puntas caen dentro del
   * mismo subárbol (relación interna al paquete — design.md D2). Orden
   * `createdAt` (design.md D6).
   *
   * `viaElementId`/`viaElementName` (design.md D2): qué elemento del
   * subárbol sostiene la relación — `sourceElementId` si está en el
   * subárbol, si no `targetElementId` (garantizado que al menos uno lo está
   * por la cláusula `OR` de arriba, y `ends.elementId` es espejo de
   * source/target, nunca aporta un tercer elemento). `otherElementName` se
   * calcula RELATIVO a `viaElementId`, no al elemento borrado.
   */
  private async findIncidentRelationships(tx: Tx, elementIds: string[]): Promise<IncidentRelationshipView[]> {
    const subtreeIds = new Set(elementIds);
    const incidents = await tx.umlRelationship.findMany({
      where: {
        OR: [
          { sourceElementId: { in: elementIds } },
          { targetElementId: { in: elementIds } },
          { ends: { some: { elementId: { in: elementIds } } } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        sourceElement: { select: { id: true, name: true } },
        targetElement: { select: { id: true, name: true } },
      },
    });

    return incidents.map((r) => {
      const viaIsSource = subtreeIds.has(r.sourceElementId);
      const via = viaIsSource ? r.sourceElement : r.targetElement;
      const other = viaIsSource ? r.targetElement : r.sourceElement;
      return {
        relationshipId: r.id,
        kind: r.kind,
        name: r.name,
        viaElementId: via.id,
        viaElementName: via.name,
        otherElementId: other.id,
        otherElementName: other.name,
      };
    });
  }
}

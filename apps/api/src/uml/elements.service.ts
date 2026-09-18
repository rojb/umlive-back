import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  normalizeStereotype,
  StereotypeTooLongError,
  UML_ERROR,
  type ElementLayoutView,
  type IncidentRelationshipView,
  type UmlElementView,
} from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
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

/**
 * Guarda pura de `createElement` (design.md D2 regla 4 de `operations-pipeline`,
 * mismo precedente que `assertEndsMatchKind` de `relationships.service.ts`):
 * sin acceso a base, así que se extrae para que el envoltorio público Y el
 * handler del despachador de operaciones la llamen los dos, ANTES de abrir
 * la transacción. Una combinación `kind`/`name`/`body`/`isAbstract`
 * malformada es un `400` de PETICIÓN, no un estado en carrera (verify-report
 * W-5): sin esto, `COMMENT` sin `body` (`ck_element_named`) y `PACKAGE` con
 * `isAbstract: true` (`ck_element_abstract`) llegaban a Postgres como
 * `P2039` sin resolvedor y salían `500`.
 */
export function validateElementCreatePayload(dto: Pick<CreateElementDto, 'kind' | 'name' | 'body' | 'isAbstract'>): void {
  if (dto.kind === 'COMMENT' ? !dto.body?.trim() : !dto.name?.trim()) {
    throw new BadRequestException();
  }
  if (dto.isAbstract && dto.kind !== 'CLASS' && dto.kind !== 'INTERFACE') {
    throw new BadRequestException();
  }
}

/**
 * Segunda guarda pura de `createElement`, mismo criterio que la de arriba
 * (design.md D2 regla 4): `normalizeStereotype` no toca base, así que se
 * resuelve fuera del lock — D10, misma normalización que las dos rutas
 * PATCH de estereotipo.
 */
export function resolveElementCreateStereotype(raw: string | undefined): string | null {
  try {
    return normalizeStereotype(raw ?? null);
  } catch (err) {
    if (err instanceof StereotypeTooLongError) {
      throw new ConflictException({ code: UML_ERROR.STEREOTYPE_INVALID });
    }
    throw err;
  }
}

/**
 * Cuerpos transaccionales de las nueve mutaciones de elemento. **Nota fechada
 * 2026-09-18 (`frontend-cutover`, tarea 4.4).** Los envoltorios públicos que
 * exponía esta clase (`createElement`, `renameElement`, `setElementAbstract`,
 * `setElementParent`, `setElementStereotype`, `setElementBody`, `moveElement`,
 * `resizeElement`, `deleteElement`) se retiraron: sus únicos llamadores eran
 * las rutas HTTP que la Fase 4 borró. Lo que queda son los cuerpos `…In(tx)`,
 * que invoca `OperationDispatcher` (`apps/api/src/collaboration/`), más las
 * dos guardas puras exportadas (`validateElementCreatePayload`,
 * `resolveElementCreateStereotype`).
 *
 * `moveElement`/`resizeElement` son DOS funciones, no un `updateLayout`
 * (design.md §2.1): el cliente ya sabe cuál gesto ocurrió y no hay que
 * reconstruir la intención desde un diff.
 */
@Injectable()
export class ElementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cuerpo transaccional mudado (`operations-pipeline/design.md` D2) — el
   * despachador de operaciones (`operation-dispatch.ts`) lo invoca tal cual,
   * después de llamar a las mismas dos guardas puras que el envoltorio de
   * arriba. `stereotype` ya viene resuelto: es pura y no toca base, así que
   * no hace falta recalcularla dentro del lock.
   */
  async createElementIn(tx: Tx, diagramId: string, dto: CreateElementDto, stereotype: string | null) {
    if (dto.parentId !== null) {
      await assertElementInDiagram(tx, dto.parentId, diagramId);
      const parent = await tx.umlElement.findUniqueOrThrow({ where: { id: dto.parentId }, select: { kind: true } });

      // D4: la regla se decide por el `kind` del HIJO, no del padre —
      // idéntica a `setElementParent`.
      const parentAllowed = dto.kind === 'COMMENT' ? parent.kind !== 'COMMENT' : parent.kind === 'PACKAGE';
      if (!parentAllowed) {
        throw new ConflictException({ code: UML_ERROR.INVALID_PARENT_KIND, parentKind: parent.kind });
      }
    }

    const created = await tx.umlElement.create({
      data: {
        diagramId,
        parentId: dto.parentId,
        kind: dto.kind,
        name: dto.name,
        isAbstract: dto.isAbstract ?? false,
        stereotype,
        body: dto.body ?? null,
      },
    });
    await tx.elementLayout.create({
      data: { elementId: created.id, x: dto.x, y: dto.y, width: dto.width, height: dto.height },
    });
    return created;
  }

  async renameElementIn(tx: Tx, diagramId: string, elementId: string, dto: RenameElementDto): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { name: dto.name } });
    return toElementView(updated);
  }

  async setElementAbstractIn(tx: Tx, diagramId: string, elementId: string, dto: SetElementAbstractDto): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { isAbstract: dto.isAbstract } });
    return toElementView(updated);
  }

  async setElementParentIn(tx: Tx, diagramId: string, elementId: string, dto: SetElementParentDto, moved?: { name: string }): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const child = await tx.umlElement.findUniqueOrThrow({ where: { id: elementId }, select: { kind: true, name: true } });
    if (moved) moved.name = child.name ?? '';

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
      const subtreeIds = await collectSubtreeIds(tx, elementId, diagramId);
      if (subtreeIds.includes(dto.parentId)) {
        throw new ConflictException({ code: UML_ERROR.CONTAINMENT_CYCLE });
      }
    }

    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { parentId: dto.parentId } });
    return toElementView(updated);
  }

  async setElementStereotypeIn(tx: Tx, diagramId: string, elementId: string, dto: SetElementStereotypeDto): Promise<UmlElementView> {
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
  }

  async setElementBodyIn(tx: Tx, diagramId: string, elementId: string, dto: SetElementBodyDto): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const element = await tx.umlElement.findUniqueOrThrow({ where: { id: elementId }, select: { kind: true } });
    if (element.kind !== 'COMMENT') {
      throw new ConflictException({ code: UML_ERROR.BODY_REQUIRES_COMMENT });
    }

    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { body: dto.body } });
    return toElementView(updated);
  }

  async moveElementIn(tx: Tx, diagramId: string, elementId: string, dto: MoveElementDto): Promise<ElementLayoutView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const layout = await tx.elementLayout.update({ where: { elementId }, data: { x: dto.x, y: dto.y } });
    return toLayoutView(layout);
  }

  async resizeElementIn(tx: Tx, diagramId: string, elementId: string, dto: ResizeElementDto): Promise<ElementLayoutView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const layout = await tx.elementLayout.update({
      where: { elementId },
      data: { width: dto.width, height: dto.height },
    });
    return toLayoutView(layout);
  }

  async deleteElementIn(tx: Tx, diagramId: string, elementId: string): Promise<void> {
    await assertElementInDiagram(tx, elementId, diagramId);

    const subtreeIds = await collectSubtreeIds(tx, elementId, diagramId);
    const incidents = await this.findIncidentRelationships(tx, subtreeIds);
    if (incidents.length > 0) {
      throw new ConflictException({
        code: UML_ERROR.ELEMENT_HAS_RELATIONSHIPS,
        count: incidents.length,
        relationships: incidents,
      });
    }

    await tx.umlElement.delete({ where: { id: elementId } });
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
   *
   * **Cuarto término, agregado por `association-class` (design.md D4):**
   * `{ associationClassId: { in: elementIds } }` — una clase asociación NO
   * es ninguno de los dos extremos (`ck_assoc_class_not_endpoint` lo
   * garantiza), así que sin este término borrarla daría `500`, no `409`. El
   * discriminante `role` distingue los dos casos: `'ENDPOINT'` reusa el
   * cálculo de siempre; `'ASSOCIATION_CLASS'` calcula `otherElementId`/
   * `otherElementName` como el extremo `source` de la asociación — la clase
   * no está en ninguna punta, así que "el otro extremo relativo al elemento
   * borrado" no tiene significado para ella.
   */
  private async findIncidentRelationships(tx: Tx, elementIds: string[]): Promise<IncidentRelationshipView[]> {
    const subtreeIds = new Set(elementIds);
    const incidents = await tx.umlRelationship.findMany({
      where: {
        OR: [
          { sourceElementId: { in: elementIds } },
          { targetElementId: { in: elementIds } },
          { ends: { some: { elementId: { in: elementIds } } } },
          { associationClassId: { in: elementIds } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        sourceElement: { select: { id: true, name: true } },
        targetElement: { select: { id: true, name: true } },
        associationClass: { select: { id: true, name: true } },
      },
    });

    return incidents.map((r) => {
      const viaIsSource = subtreeIds.has(r.sourceElementId);
      const viaIsTarget = !viaIsSource && subtreeIds.has(r.targetElementId);

      if (viaIsSource || viaIsTarget) {
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
          role: 'ENDPOINT',
        };
      }

      // Solo llega acá si NINGUNO de los tres primeros términos del `OR`
      // matcheó — por construcción, el cuarto sí lo hizo: `r.associationClass`
      // existe.
      const associationClass = r.associationClass!;
      return {
        relationshipId: r.id,
        kind: r.kind,
        name: r.name,
        viaElementId: associationClass.id,
        viaElementName: associationClass.name,
        otherElementId: r.sourceElement.id,
        otherElementName: r.sourceElement.name,
        role: 'ASSOCIATION_CLASS',
      };
    });
  }
}

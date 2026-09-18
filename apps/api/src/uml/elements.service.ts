import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  normalizeStereotype,
  StereotypeTooLongError,
  UML_ERROR,
  type DeleteClosure,
  type ElementLayoutView,
  type IncidentRelationshipView,
  type UmlElementView,
} from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
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
  private readonly log = new Logger(ElementsService.name);

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

  /**
   * Borrado por la LISTA EXACTA del cierre verificado (`hierarchical-delete`
   * D5, SC-C14/C15), y devuelve ese mismo cierre como payload autoritativo.
   *
   * **Nota fechada 2026-09-18 (`hierarchical-delete`, tarea 4.4).** El
   * envoltorio público `deleteElement` de esta clase ya NO EXISTE: lo retiró
   * `frontend-cutover` (tarea 4.4 de aquella rebanada) junto con las 33 rutas
   * HTTP de mutación. Lo confirma la cabecera de esta clase y
   * `rg "deleteElement\(" apps/api/src` — el único camino de borrado es este
   * cuerpo `…In(tx)` vía `OperationDispatcher`, que SIEMPRE pasa por locks.
   *
   * Tres cambios respecto de la versión de M2, todos en D5/D7.3:
   *
   *  1. **Se fue la comprobación previa de rol `ENDPOINT`.** Con los locks
   *     tomados y las relaciones borradas en la misma transacción, ese `409`
   *     ya no protege nada: bloquearía todo borrado jerárquico. Lo que queda es
   *     el `409` de `ASSOCIATION_CLASS`, y solo cuando la asociación que liga la
   *     clase SOBREVIVE fuera del cierre.
   *  2. **Las relaciones se borran por `id: { in: closure.relationshipIds }`**,
   *     nunca por el predicado `source = $id OR target = $id` de
   *     `DATA-MODEL.md:925-926`. El predicado se lleva también la relación que
   *     NO se verificó, así que el `RESTRICT` nunca salta y SC-C15 no se puede
   *     disparar.
   *  3. **Los descendientes se van por `CASCADE` de `parent_id`**, no por una
   *     lista: se borra la raíz y la base propaga.
   *
   * El `catch` de `P2003` es una RED DE CARRERA, no el caso esperado: con el
   * cierre recalculado desde la base dentro del `FOR UPDATE`, un `P2003` acá
   * significa que el servicio OMITIÓ un id de la lista. Por eso lleva
   * `Logger.warn` (antes era silencioso) y por eso se relanza tal cual: el
   * traductor de `operation-rejection.ts` lo convierte en
   * `CONSTRAINT_VIOLATION`, la transacción revierte y ninguna fila cambia.
   */
  async deleteElementIn(tx: Tx, diagramId: string, rootId: string, closure: DeleteClosure): Promise<DeleteClosure> {
    await assertElementInDiagram(tx, rootId, diagramId);

    // 1. `409` de clase asociación, PRECISADO (D7.3, confirmado 2026-09-17):
    // SOLO si la asociación que liga la clase NO está en el cierre. Si cae
    // dentro (porque uno de sus extremos se borra), la FK se va con la
    // asociación y la clase se borra sin problema. Sin esta precisión, ningún
    // paquete que contuviera una clase asociación se podría borrar nunca.
    const linking = await this.findLinkingAssociationClasses(tx, diagramId, closure);
    if (linking.length > 0) {
      throw new ConflictException({
        code: UML_ERROR.ELEMENT_HAS_RELATIONSHIPS,
        count: linking.length,
        relationships: linking,
      });
    }

    // 2. Relaciones por la lista EXACTA de ids verificados. `ends` y
    // `relationship_layouts` se van por `CASCADE`.
    await tx.umlRelationship.deleteMany({
      where: { diagramId, id: { in: closure.relationshipIds } },
    });

    // 3. La raíz. Los descendientes se van por el `CASCADE` de `parent_id`; sus
    // `features`/`parameters`/`enum_literals`/`layouts` por los suyos.
    try {
      await tx.umlElement.delete({ where: { id: rootId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        // Red de carrera, NO el caso esperado: es un id OMITIDO del cierre.
        this.log.warn(
          `P2003 al borrar ${rootId} en ${diagramId}: el cierre (${closure.ids.length} elementos, ${closure.relationshipIds.length} relaciones) omitió una relación incidente`,
        );
      }
      throw err;
    }

    return closure;
  }

  /**
   * Relaciones que LIGAN como clase asociación a algún elemento del cierre y
   * que NO están en el cierre (`hierarchical-delete` D7.3) — el único caso que
   * sigue respondiendo `409 element_has_relationships`.
   *
   * Una clase asociación NO es ninguno de los dos extremos
   * (`ck_assoc_class_not_endpoint` lo garantiza), así que sin este término
   * borrarla tiraría `P2003`/`500` en vez de un `409` con nombre.
   *
   * El filtro es `associationClassId ∈ cierre.ids` **y** `id ∉
   * cierre.relationshipIds`. Si la asociación que liga cae dentro del cierre
   * porque uno de sus extremos se está borrando, la FK se va con ella y no hay
   * nada que proteger: rechazar ahí haría imposible borrar cualquier paquete
   * con una clase asociación adentro. El filtro se hace en JS, no en el
   * `where`, para no depender de la semántica de un `notIn` vacío en el
   * adaptador.
   *
   * `role: 'ASSOCIATION_CLASS'` se conserva: el cliente lo usa para NO decir
   * «borrá la asociación primero» (lo correcto es desligarla). Orden
   * `createdAt`, igual que la lista que reemplaza.
   */
  private async findLinkingAssociationClasses(tx: Tx, diagramId: string, closure: DeleteClosure): Promise<IncidentRelationshipView[]> {
    const incidents = await tx.umlRelationship.findMany({
      where: { diagramId, associationClassId: { in: closure.ids } },
      orderBy: { createdAt: 'asc' },
      include: {
        sourceElement: { select: { id: true, name: true } },
        associationClass: { select: { id: true, name: true } },
      },
    });

    const insideClosure = new Set(closure.relationshipIds);
    return incidents
      .filter((r) => !insideClosure.has(r.id))
      .map((r) => {
        // `associationClass` no puede ser `null`: la consulta filtró por ese
        // campo, así que toda fila que llega acá lo tiene.
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

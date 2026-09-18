import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
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
import { handleCheckViolation, handleUniqueViolation, resolveForeignKeyViolation } from './uml-errors';

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
 * `createElement`, `renameElement`, `setElementAbstract`, `setElementParent`,
 * `setElementStereotype`, `setElementBody`, `moveElement`, `resizeElement`,
 * `deleteElement` (design.md §2, §12; tasks.md 3.2; `uml-validation` fase 1
 * agrega las tres de `set*`).
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
   *
   * **Corrección de `uml-validation` (verify-report CRITICAL-1).** Esta era
   * la ÚNICA ruta que persistía `parentId`/`stereotype` sin ninguna de las
   * guardas que `setElementParent`/`setElementStereotype` (fase 1 de esta
   * misma rebanada) ya aplican: sin `assertElementInDiagram` sobre el padre
   * (un elemento de OTRO diagrama, y por lo tanto de otro proyecto, entraba
   * como padre), sin la regla D4 de padre por `kind` del hijo, y sin
   * `normalizeStereotype`/tope de 64. Ahora corre el MISMO chequeo que
   * `setElementParent`, dentro de la misma transacción que el `create` —
   * nunca antes de abrirla, mismo criterio que el resto del módulo. No hace
   * falta la guarda de ciclo de contención (`collectSubtreeIds`, D1/D3): un
   * elemento recién creado no tiene descendientes todavía, así que no puede
   * ser su propio ancestro.
   */
  async createElement(diagramId: string, dto: CreateElementDto): Promise<UmlElementView> {
    validateElementCreatePayload(dto);
    const stereotype = resolveElementCreateStereotype(dto.stereotype);

    try {
      const element = await this.prisma.$transaction((tx) => this.createElementIn(tx, diagramId, dto, stereotype));
      return toElementView(element);
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      handleUniqueViolation(err, dto.name ?? '');
    }
  }

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

  async renameElement(diagramId: string, elementId: string, dto: RenameElementDto): Promise<UmlElementView> {
    try {
      return await this.prisma.$transaction((tx) => this.renameElementIn(tx, diagramId, elementId, dto));
    } catch (err) {
      handleUniqueViolation(err, dto.name);
    }
  }

  async renameElementIn(tx: Tx, diagramId: string, elementId: string, dto: RenameElementDto): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { name: dto.name } });
    return toElementView(updated);
  }

  async setElementAbstract(diagramId: string, elementId: string, dto: SetElementAbstractDto): Promise<UmlElementView> {
    return this.prisma.$transaction((tx) => this.setElementAbstractIn(tx, diagramId, elementId, dto));
  }

  async setElementAbstractIn(tx: Tx, diagramId: string, elementId: string, dto: SetElementAbstractDto): Promise<UmlElementView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const updated = await tx.umlElement.update({ where: { id: elementId }, data: { isAbstract: dto.isAbstract } });
    return toElementView(updated);
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
    // Nota fechada 2026-09-18 (verify-report W-5). Antes de la extracción de
    // `operations-pipeline` (`14fd124`), `movedName` era una variable de
    // CIERRE (`let movedName = ''` en este mismo scope, asignada dentro del
    // callback de `$transaction`, leída acá en el `catch` — las dos partes
    // compartían función). La extracción D2 separa el cuerpo en
    // `setElementParentIn(tx, …)`: ese callback ya NO es un closure de este
    // método, así que `movedName` no puede seguir siendo una variable local
    // de acá. La solución NO es la relectura post-rollback que hubo entre
    // `14fd124` y esta corrección (una consulta extra en TODO camino de
    // error, con riesgo de enmascarar el error original si esa relectura
    // fallara) — es pasar un receptor mutable que `setElementParentIn`
    // rellena en el mismo punto donde el cuerpo original hacía la
    // asignación. El cuerpo de la transacción queda así, de nuevo, línea por
    // línea idéntico a `14fd124~1` salvo esa única asignación condicional.
    const moved = { name: '' };
    try {
      return await this.prisma.$transaction((tx) => this.setElementParentIn(tx, diagramId, elementId, dto, moved));
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // W-3 (verify-report): la red de carrera de `ck_element_not_own_parent`
      // (D3, `uml-errors.ts`) llega como `P2039`, no `P2002` —
      // `handleUniqueViolation` sola nunca la reconocía (`resolveUniqueViolation`
      // solo mira `P2002`) y la CHECK quedaba muerta, relanzando como `500`
      // en el caso (raro, pero real) de que dos `PATCH /parent` concurrentes
      // pasaran las dos comprobaciones. `handleCheckViolation` es `never` —
      // si `err` es `P2039` SIEMPRE termina acá (mapeado a `409
      // containment_cycle`, o relanzado tal cual si no lo reconoce);
      // `handleUniqueViolation` de abajo queda para el resto (`P2002` de
      // `element_name_taken`, y cualquier otro error, que relanza igual).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2039') {
        handleCheckViolation(err);
      }
      handleUniqueViolation(err, moved.name);
    }
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

  /**
   * `uml-validation` fase 1 (design.md D10; tasks.md 1.7). `normalizeStereotype`
   * es la MISMA función pura que usa `setRelationshipStereotype` — ninguna
   * de las dos reimplementa la normalización.
   */
  async setElementStereotype(diagramId: string, elementId: string, dto: SetElementStereotypeDto): Promise<UmlElementView> {
    return this.prisma.$transaction((tx) => this.setElementStereotypeIn(tx, diagramId, elementId, dto));
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

  /**
   * `uml-validation` fase 1 (spec "Package como contenedor — tres
   * mutaciones"; tasks.md 1.7). Un cuerpo en una clase no es un comentario
   * UML — `409`, no `400`: depende del `kind` persistido, no de la forma
   * del cuerpo (mismo criterio que `invalid_parent_kind`).
   */
  async setElementBody(diagramId: string, elementId: string, dto: SetElementBodyDto): Promise<UmlElementView> {
    return this.prisma.$transaction((tx) => this.setElementBodyIn(tx, diagramId, elementId, dto));
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

  async moveElement(diagramId: string, elementId: string, dto: MoveElementDto): Promise<ElementLayoutView> {
    return this.prisma.$transaction((tx) => this.moveElementIn(tx, diagramId, elementId, dto));
  }

  async moveElementIn(tx: Tx, diagramId: string, elementId: string, dto: MoveElementDto): Promise<ElementLayoutView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const layout = await tx.elementLayout.update({ where: { elementId }, data: { x: dto.x, y: dto.y } });
    return toLayoutView(layout);
  }

  async resizeElement(diagramId: string, elementId: string, dto: ResizeElementDto): Promise<ElementLayoutView> {
    return this.prisma.$transaction((tx) => this.resizeElementIn(tx, diagramId, elementId, dto));
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
      await this.prisma.$transaction((tx) => this.deleteElementIn(tx, diagramId, elementId));
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        const subtreeIds = await collectSubtreeIds(this.prisma, elementId, diagramId);
        const incidents = await this.findIncidentRelationships(this.prisma, subtreeIds);
        if (incidents.length > 0) {
          throw new ConflictException({
            code: UML_ERROR.ELEMENT_HAS_RELATIONSHIPS,
            count: incidents.length,
            relationships: incidents,
          });
        }
        // FR-B10 (`association-class`, D4, AC-B16): la relectura vino vacía
        // por carrera — alguien ligó la clase COMO clase asociación entre la
        // comprobación previa y el `DELETE`. `resolveForeignKeyViolation`
        // reconoce `uml_relationships_association_class_id_fkey` (la única FK
        // de este archivo con un resolvedor propio, design.md D3) y responde
        // `409`, nunca `500` — sin lista de incidentes porque la relectura no
        // encontró ninguno que enumerar.
        const fkCode = resolveForeignKeyViolation(err);
        if (fkCode) {
          throw new ConflictException({ code: fkCode, count: 0, relationships: [] });
        }
      }
      throw err;
    }
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

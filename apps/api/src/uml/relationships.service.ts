import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  normalizeStereotype,
  StereotypeTooLongError,
  UML_ERROR,
  type RelationshipKind,
  type RelationshipLayoutView,
  type UmlRelationshipEndView,
  type UmlRelationshipView,
} from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { assertElementInDiagram, assertRelationshipInDiagram, loadLinkableClass } from './diagram-scope';
import type { CreateRelationshipDto } from './dto/create-relationship.dto';
import type { RenameRelationshipDto } from './dto/rename-relationship.dto';
import type { RerouteRelationshipEndDto } from './dto/reroute-relationship-end.dto';
import type { SetAssociationClassDto } from './dto/set-association-class.dto';
import type { SetEndAggregationDto } from './dto/set-end-aggregation.dto';
import type { SetEndMultiplicityDto } from './dto/set-end-multiplicity.dto';
import type { SetEndNavigabilityDto } from './dto/set-end-navigability.dto';
import type { SetEndRoleNameDto } from './dto/set-end-role-name.dto';
import type { SetRelationshipAnchorsDto } from './dto/set-relationship-anchors.dto';
import type { SetRelationshipStereotypeDto } from './dto/set-relationship-stereotype.dto';
import type { SetRelationshipWaypointsDto } from './dto/set-relationship-waypoints.dto';
import { handleCheckViolation, resolveUniqueViolation } from './uml-errors';
import { toRelationshipEndView, toRelationshipLayoutView, toRelationshipView } from './uml-mappers';

/**
 * Respuesta de `createRelationship` y de los dos reroutes (design.md §4,
 * flujo "Crear una relación" / "Reencaminar un extremo"). `ends` viene
 * vacío para los cuatro tipos sin filas de extremo (D4) — no es un caso de
 * error, es la forma normal de la respuesta para esos tipos.
 */
export interface RelationshipMutationResult {
  relationship: UmlRelationshipView;
  ends: UmlRelationshipEndView[];
  layout: RelationshipLayoutView;
}

/**
 * Guarda pura de `createRelationship` (`operations-pipeline/design.md` D2
 * regla 4 — la ÚNICA excepción declarada: sin acceso a base, así que se
 * extrae para que el envoltorio público Y el handler del despachador de
 * operaciones la llamen los dos, ANTES de abrir la transacción). Una
 * combinación `kind`/`ends` malformada es un `400` de PETICIÓN, no un estado
 * en carrera que amerite una fila en `CHECK_CONSTRAINT_TO_UML_ERROR`.
 */
export function assertEndsMatchKind(kind: RelationshipKind, ends: CreateRelationshipDto['ends']): void {
  if (ends && kind !== 'ASSOCIATION') {
    throw new BadRequestException();
  }
}

/**
 * Las trece mutaciones de relación (design.md §1-§4 de `uml-relationships`;
 * tasks.md fase 2; `uml-validation`/`association-class` agregan
 * `setRelationshipStereotype`/`setAssociationClass`).
 * `writeEndpoint` es el único escritor del par duplicado
 * `uml_relationships.{source|target}_element_id` /
 * `uml_relationship_ends.element_id` (D3) — `createRelationship` y los dos
 * reroutes son sus únicos llamadores.
 */
@Injectable()
export class RelationshipsService {
  private readonly log = new Logger(RelationshipsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `if (kind === 'ASSOCIATION')` es la ÚNICA rama por tipo de todo el
   * backend (D4) — los otros cuatro tipos quedan completamente descritos
   * por `sourceElementId`/`targetElementId` + `kind`, sin fila de extremo.
   */
  async createRelationship(diagramId: string, dto: CreateRelationshipDto): Promise<RelationshipMutationResult> {
    // Sin código de dominio propio a propósito (design.md D4, §6: "cuatro
    // códigos nuevos, no cinco") — ninguna CHECK puede expresar esta regla,
    // es una petición malformada para el `kind` declarado.
    assertEndsMatchKind(dto.kind, dto.ends);

    try {
      return await this.prisma.$transaction((tx) => this.createRelationshipIn(tx, diagramId, dto));
    } catch (err) {
      handleCheckViolation(err);
    }
  }

  async createRelationshipIn(tx: Tx, diagramId: string, dto: CreateRelationshipDto): Promise<RelationshipMutationResult> {
    // `in: [s, t]` deduplica en la base cuando `s === t` — un
    // `findMany` siempre trae como máximo tantas filas como IDs
    // DISTINTOS se pidieron, nunca la longitud cruda del arreglo. SC-B12
    // exige que `source === target` en una `GENERALIZATION` LLEGUE al
    // `CHECK` (409), no que se corte acá con un 404 espurio — comparar
    // contra `2` a secas (como sugiere el pseudo-código de design.md §4)
    // rompe ese caso. Se compara contra la cardinalidad de IDs distintos.
    const distinctIds = new Set([dto.sourceElementId, dto.targetElementId]);
    const classifiers = await tx.umlElement.findMany({
      where: { id: { in: [...distinctIds] }, diagramId },
      select: { id: true },
    });
    if (classifiers.length !== distinctIds.size) throw new NotFoundException();

    const relationship = await tx.umlRelationship.create({
      data: {
        diagramId,
        kind: dto.kind,
        sourceElementId: dto.sourceElementId,
        targetElementId: dto.targetElementId,
        name: dto.name ?? null,
      },
    });

    const ends: UmlRelationshipEndView[] = [];
    if (dto.kind === 'ASSOCIATION' && dto.ends) {
      const [end0, end1] = dto.ends;
      const endPairs: Array<[0 | 1, (typeof dto.ends)[number]]> = [
        [0, end0],
        [1, end1],
      ];
      for (const [endIndex, end] of endPairs) {
        const created = await tx.umlRelationshipEnd.create({
          data: {
            relationshipId: relationship.id,
            endIndex,
            elementId: endIndex === 0 ? dto.sourceElementId : dto.targetElementId,
            roleName: end.roleName ?? null,
            lowerBound: end.lowerBound,
            // Normaliza "sin definir" → `null`, mismo criterio que
            // `setEndMultiplicity` (D2): ambos casos de SC-B09 llegan a
            // `ck_composite_multiplicity` como el mismo NULL.
            upperBound: end.upperBound ?? null,
            isNavigable: end.isNavigable,
            aggregation: end.aggregation,
          },
        });
        ends.push(toRelationshipEndView(created));
      }
    }

    // `RelationshipLayout.waypoints` tiene `@default("[]")` y
    // `sourceAnchor`/`targetAnchor` son nullable sin default — se omiten
    // acá a propósito: `CreateRelationshipRequest` no lleva geometría
    // (D7, el cliente la fija después con las dos mutaciones de layout).
    const layout = await tx.relationshipLayout.create({ data: { relationshipId: relationship.id } });

    return {
      relationship: toRelationshipView(relationship),
      ends,
      layout: toRelationshipLayoutView(layout),
    };
  }

  async deleteRelationship(diagramId: string, relationshipId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.deleteRelationshipIn(tx, diagramId, relationshipId));
  }

  async deleteRelationshipIn(tx: Tx, diagramId: string, relationshipId: string): Promise<void> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    await tx.umlRelationship.delete({ where: { id: relationshipId } });
  }

  async renameRelationship(diagramId: string, relationshipId: string, dto: RenameRelationshipDto): Promise<UmlRelationshipView> {
    return this.prisma.$transaction((tx) => this.renameRelationshipIn(tx, diagramId, relationshipId, dto));
  }

  async renameRelationshipIn(tx: Tx, diagramId: string, relationshipId: string, dto: RenameRelationshipDto): Promise<UmlRelationshipView> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    const updated = await tx.umlRelationship.update({ where: { id: relationshipId }, data: { name: dto.name } });
    return toRelationshipView(updated);
  }

  /**
   * `uml-validation` fase 1 (design.md D10, "Hallazgo nuevo — la propuesta
   * se olvidó de una ruta"; tasks.md 1.8). `normalizeStereotype` es la
   * MISMA función pura que usa `ElementsService.setElementStereotype` —
   * ninguna de las dos reimplementa la normalización.
   */
  async setRelationshipStereotype(diagramId: string, relationshipId: string, dto: SetRelationshipStereotypeDto): Promise<UmlRelationshipView> {
    return this.prisma.$transaction((tx) => this.setRelationshipStereotypeIn(tx, diagramId, relationshipId, dto));
  }

  async setRelationshipStereotypeIn(tx: Tx, diagramId: string, relationshipId: string, dto: SetRelationshipStereotypeDto): Promise<UmlRelationshipView> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);

    let stereotype: string | null;
    try {
      stereotype = normalizeStereotype(dto.stereotype);
    } catch (err) {
      if (err instanceof StereotypeTooLongError) {
        throw new ConflictException({ code: UML_ERROR.STEREOTYPE_INVALID });
      }
      throw err;
    }

    const updated = await tx.umlRelationship.update({ where: { id: relationshipId }, data: { stereotype } });
    return toRelationshipView(updated);
  }

  /**
   * FR-B10 (`association-class`, D1 + D5; tasks.md 2.2). Ligar
   * (`dto.elementId` no nulo) y desligar (`null`) son la MISMA mutación con
   * carga útil nullable (D5) — mismo precedente que `setEndRoleName`.
   *
   * **Ligar**: `loadLinkableClass` (D2, `diagram-scope.ts`) valida existencia
   * en el diagrama (`404`) y `kind === 'CLASS'` (`409`); que la clase no sea
   * uno de los dos extremos de la relación lo garantiza
   * `ck_assoc_class_not_endpoint` (`CHECK`, capturado como `P2039` abajo) —
   * no se pre-chequea en el servicio, mismo criterio D2 de
   * `uml-relationships` (un solo punto de aplicación). D1, transferencia de
   * `xmi_id`: si la relación YA trae uno, se conserva y el de la clase se
   * descarta; si no, se adopta el de la clase. La clase SIEMPRE queda con
   * `xmi_id: null` tras ligar — es la regla de D1, no un efecto condicional
   * de si traía uno o no.
   *
   * **Desligar** (`elementId: null`): solo `UPDATE association_class_id =
   * NULL`. El `xmi_id` de la relación NO se toca (la identidad se queda en
   * ella, D1); la clase ya nació sin `xmi_id` propio al ligarse, así que
   * "vuelve a nacer sin identidad XMI" es automático — no requiere otro
   * `UPDATE`.
   */
  async setAssociationClass(diagramId: string, relationshipId: string, dto: SetAssociationClassDto): Promise<UmlRelationshipView> {
    try {
      return await this.prisma.$transaction((tx) => this.setAssociationClassIn(tx, diagramId, relationshipId, dto));
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      // W-1 (verify-report): carrera del lado del ligado — la clase se borra
      // ENTRE `loadLinkableClass` (la ve) y el `UPDATE xmi_id: null` de acá
      // arriba, que queda bloqueado por el lock de fila del `DELETE`
      // concurrente. `design.md` D2 asumía que esa carrera salía como
      // `P2003` (FK `Restrict`, igual que en `deleteElement`), pero el
      // `UPDATE` (no un `INSERT`/otro `UPDATE` que sí dispare la FK) sobre
      // una fila que ya no existe nunca llega a evaluar la constraint:
      // Prisma reporta `P2025` ("Record to update not found") ANTES. Mismo
      // criterio 404 que `loadLinkableClass`/AC-B09 — para cuando la
      // transacción termina, la clase elegida ya no existe, ni distinto de
      // pedir una de otro diagrama: un recurso ajeno es un oráculo, nunca un
      // `409`/`500`. Forzado real: `psql` retiene el `DELETE` de la clase sin
      // commit, el `PATCH` de ligado queda bloqueado en el `UPDATE`, el
      // commit del `DELETE` lo libera con `P2025`.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException();
      }
      // D3: dos formas de Prisma en juego acá — `P2002` (índice único, ya
      // ligada a otra asociación) y `P2039` (los dos `CHECK` nuevos). Ninguna
      // de las dos pasa por `handleUniqueViolation`/`handleCheckViolation`
      // solas: la primera espera un `conflictingName` que este endpoint no
      // tiene (el cuerpo del 409 no lo lleva, spec AC-B05); la segunda ya es
      // exactamente lo que necesitamos para P2039.
      const uniqueCode = resolveUniqueViolation(err);
      if (uniqueCode) throw new ConflictException({ code: uniqueCode });
      handleCheckViolation(err);
    }
  }

  async setAssociationClassIn(tx: Tx, diagramId: string, relationshipId: string, dto: SetAssociationClassDto): Promise<UmlRelationshipView> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);

    if (dto.elementId === null) {
      const updated = await tx.umlRelationship.update({
        where: { id: relationshipId },
        data: { associationClassId: null },
      });
      return toRelationshipView(updated);
    }

    const cls = await loadLinkableClass(tx, dto.elementId, diagramId);
    const current = await tx.umlRelationship.findUniqueOrThrow({
      where: { id: relationshipId },
      select: { xmiId: true },
    });

    // D1: la clase SIEMPRE queda sin `xmi_id` propio tras ligar.
    await tx.umlElement.update({ where: { id: cls.id }, data: { xmiId: null } });

    // D1: se registra el descarte cuando las DOS filas traían `xmi_id`
    // propio — es la única rama con pérdida real de identidad (verify-report
    // W-6; `design.md:52`, "ese descarte se registra"). Cuando solo una de
    // las dos traía uno, no hay descarte: se transfiere sin pérdida.
    if (current.xmiId && cls.xmiId) {
      this.log.warn(
        `xmi_id descartado al ligar clase asociación: relación ${relationshipId} conserva '${current.xmiId}', clase ${cls.id} traía '${cls.xmiId}' (design.md D1)`,
      );
    }

    const updated = await tx.umlRelationship.update({
      where: { id: relationshipId },
      data: {
        associationClassId: dto.elementId,
        // D1: prevalece el `xmi_id` de la relación si ya traía uno;
        // si no, se transfiere el de la clase; si ninguna traía, null.
        xmiId: current.xmiId ?? cls.xmiId ?? null,
      },
    });
    return toRelationshipView(updated);
  }

  /** El `id` de la relación nunca se regenera (FR-B06) — solo se reescribe el extremo `source`. */
  async rerouteRelationshipSource(diagramId: string, relationshipId: string, dto: RerouteRelationshipEndDto): Promise<RelationshipMutationResult> {
    return this.rerouteEnd(diagramId, relationshipId, 0, dto);
  }

  async rerouteRelationshipTarget(diagramId: string, relationshipId: string, dto: RerouteRelationshipEndDto): Promise<RelationshipMutationResult> {
    return this.rerouteEnd(diagramId, relationshipId, 1, dto);
  }

  private async rerouteEnd(
    diagramId: string,
    relationshipId: string,
    endIndex: 0 | 1,
    dto: RerouteRelationshipEndDto,
  ): Promise<RelationshipMutationResult> {
    try {
      return await this.prisma.$transaction((tx) => this.rerouteEndIn(tx, diagramId, relationshipId, endIndex, dto));
    } catch (err) {
      handleCheckViolation(err);
    }
  }

  /**
   * Cuerpo transaccional mudado. Cubre `rerouteRelationshipSource`
   * (`endIndex: 0`) Y `rerouteRelationshipTarget` (`endIndex: 1`) — es el
   * único cuerpo de los 12 sitios `$transaction` de este archivo que
   * corresponde a DOS funciones públicas (design.md D1).
   */
  async rerouteEndIn(tx: Tx, diagramId: string, relationshipId: string, endIndex: 0 | 1, dto: RerouteRelationshipEndDto): Promise<RelationshipMutationResult> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    await assertElementInDiagram(tx, dto.elementId, diagramId);

    await this.writeEndpoint(tx, relationshipId, endIndex, dto.elementId);

    // `anchor` viaja en el cuerpo del reroute (D7) — solo se toca si
    // vino en la petición; `undefined` es "no tocar", `null` es "limpiar".
    if (dto.anchor !== undefined) {
      await tx.relationshipLayout.update({
        where: { relationshipId },
        data: endIndex === 0 ? { sourceAnchor: dto.anchor } : { targetAnchor: dto.anchor },
      });
    }

    const [relationship, ends, layout] = await Promise.all([
      tx.umlRelationship.findUniqueOrThrow({ where: { id: relationshipId } }),
      tx.umlRelationshipEnd.findMany({ where: { relationshipId }, orderBy: { endIndex: 'asc' } }),
      tx.relationshipLayout.findUniqueOrThrow({ where: { relationshipId } }),
    ]);

    return {
      relationship: toRelationshipView(relationship),
      ends: ends.map(toRelationshipEndView),
      layout: toRelationshipLayoutView(layout),
    };
  }

  /**
   * Único escritor del par duplicado (D3). `updateMany` en las dos tablas:
   * "cero filas" en `uml_relationship_ends` es un no-op legítimo para los
   * cuatro tipos sin extremos (D4), no un `P2025`. Cuando SÍ tocó una fila,
   * relee las dos dentro de la misma transacción y compara — si difieren,
   * lanza (rollback → `500`): no hay constraint que sustituya esta
   * relectura, porque ninguna FK compuesta ata las dos columnas.
   */
  private async writeEndpoint(tx: Tx, relationshipId: string, endIndex: 0 | 1, elementId: string): Promise<void> {
    if (endIndex === 0) {
      await tx.umlRelationship.updateMany({ where: { id: relationshipId }, data: { sourceElementId: elementId } });
    } else {
      await tx.umlRelationship.updateMany({ where: { id: relationshipId }, data: { targetElementId: elementId } });
    }

    const endUpdate = await tx.umlRelationshipEnd.updateMany({
      where: { relationshipId, endIndex },
      data: { elementId },
    });
    if (endUpdate.count === 0) return; // no-op legítimo — los 4 tipos sin extremos (D4)

    const [relationship, end] = await Promise.all([
      tx.umlRelationship.findUniqueOrThrow({ where: { id: relationshipId } }),
      tx.umlRelationshipEnd.findFirstOrThrow({ where: { relationshipId, endIndex } }),
    ]);
    const mirrored = endIndex === 0 ? relationship.sourceElementId : relationship.targetElementId;
    if (mirrored !== end.elementId) {
      throw new Error(`writeEndpoint: uml_relationships/uml_relationship_ends desincronizados para ${relationshipId} endIndex=${endIndex}`);
    }
  }

  /**
   * Común a las cuatro mutaciones de extremo (design.md §3, D4): carga la
   * fila `(relationshipId, endIndex)` DENTRO del diagrama y responde `404`
   * sin ramificar por `kind` si no existe — es el caso de los cuatro tipos
   * sin extremos, y la ausencia de la fila ES la respuesta.
   */
  private async loadEnd(tx: Tx, diagramId: string, relationshipId: string, endIndex: number) {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    const row = await tx.umlRelationshipEnd.findFirst({ where: { relationshipId, endIndex } });
    if (!row) throw new NotFoundException();
    return row;
  }

  async setEndRoleName(
    diagramId: string,
    relationshipId: string,
    endIndex: number,
    dto: SetEndRoleNameDto,
  ): Promise<UmlRelationshipEndView> {
    return this.prisma.$transaction((tx) => this.setEndRoleNameIn(tx, diagramId, relationshipId, endIndex, dto));
  }

  async setEndRoleNameIn(tx: Tx, diagramId: string, relationshipId: string, endIndex: number, dto: SetEndRoleNameDto): Promise<UmlRelationshipEndView> {
    const end = await this.loadEnd(tx, diagramId, relationshipId, endIndex);
    const updated = await tx.umlRelationshipEnd.update({ where: { id: end.id }, data: { roleName: dto.roleName } });
    return toRelationshipEndView(updated);
  }

  /** `upperBound` normaliza "sin definir" → `null`, mismo criterio que `createRelationship` (D2). */
  async setEndMultiplicity(
    diagramId: string,
    relationshipId: string,
    endIndex: number,
    dto: SetEndMultiplicityDto,
  ): Promise<UmlRelationshipEndView> {
    try {
      return await this.prisma.$transaction((tx) => this.setEndMultiplicityIn(tx, diagramId, relationshipId, endIndex, dto));
    } catch (err) {
      handleCheckViolation(err);
    }
  }

  async setEndMultiplicityIn(tx: Tx, diagramId: string, relationshipId: string, endIndex: number, dto: SetEndMultiplicityDto): Promise<UmlRelationshipEndView> {
    const end = await this.loadEnd(tx, diagramId, relationshipId, endIndex);
    const updated = await tx.umlRelationshipEnd.update({
      where: { id: end.id },
      data: { lowerBound: dto.lowerBound, upperBound: dto.upperBound ?? null },
    });
    return toRelationshipEndView(updated);
  }

  async setEndNavigability(
    diagramId: string,
    relationshipId: string,
    endIndex: number,
    dto: SetEndNavigabilityDto,
  ): Promise<UmlRelationshipEndView> {
    return this.prisma.$transaction((tx) => this.setEndNavigabilityIn(tx, diagramId, relationshipId, endIndex, dto));
  }

  async setEndNavigabilityIn(tx: Tx, diagramId: string, relationshipId: string, endIndex: number, dto: SetEndNavigabilityDto): Promise<UmlRelationshipEndView> {
    const end = await this.loadEnd(tx, diagramId, relationshipId, endIndex);
    const updated = await tx.umlRelationshipEnd.update({ where: { id: end.id }, data: { isNavigable: dto.isNavigable } });
    return toRelationshipEndView(updated);
  }

  /** Sin `upperBound` en el DTO (D2) — la CHECK es el único punto de aplicación de SC-B09. */
  async setEndAggregation(
    diagramId: string,
    relationshipId: string,
    endIndex: number,
    dto: SetEndAggregationDto,
  ): Promise<UmlRelationshipEndView> {
    try {
      return await this.prisma.$transaction((tx) => this.setEndAggregationIn(tx, diagramId, relationshipId, endIndex, dto));
    } catch (err) {
      handleCheckViolation(err);
    }
  }

  async setEndAggregationIn(tx: Tx, diagramId: string, relationshipId: string, endIndex: number, dto: SetEndAggregationDto): Promise<UmlRelationshipEndView> {
    const end = await this.loadEnd(tx, diagramId, relationshipId, endIndex);
    const updated = await tx.umlRelationshipEnd.update({ where: { id: end.id }, data: { aggregation: dto.aggregation } });
    return toRelationshipEndView(updated);
  }

  /** `ck_waypoints_array` solo exige un arreglo — la forma `{x, y}` ya la garantizó el DTO (D7). */
  async setRelationshipWaypoints(
    diagramId: string,
    relationshipId: string,
    dto: SetRelationshipWaypointsDto,
  ): Promise<RelationshipLayoutView> {
    return this.prisma.$transaction((tx) => this.setRelationshipWaypointsIn(tx, diagramId, relationshipId, dto));
  }

  async setRelationshipWaypointsIn(tx: Tx, diagramId: string, relationshipId: string, dto: SetRelationshipWaypointsDto): Promise<RelationshipLayoutView> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    const updated = await tx.relationshipLayout.update({
      where: { relationshipId },
      // Cast necesario: Prisma tipa `waypoints` (columna `Json`) contra su
      // propio `InputJsonValue`, que una interfaz de `@umlive/contracts`
      // no puede implementar estructuralmente. La forma real (`{x,y}[]`)
      // ya la garantizó `WaypointDto` antes de llegar acá (D7).
      data: { waypoints: dto.waypoints as unknown as Prisma.InputJsonValue },
    });
    return toRelationshipLayoutView(updated);
  }

  /** Texto libre sin interpretar (D7) — el servidor nunca lee ni valida el formato del ancla. */
  async setRelationshipAnchors(
    diagramId: string,
    relationshipId: string,
    dto: SetRelationshipAnchorsDto,
  ): Promise<RelationshipLayoutView> {
    return this.prisma.$transaction((tx) => this.setRelationshipAnchorsIn(tx, diagramId, relationshipId, dto));
  }

  async setRelationshipAnchorsIn(tx: Tx, diagramId: string, relationshipId: string, dto: SetRelationshipAnchorsDto): Promise<RelationshipLayoutView> {
    await assertRelationshipInDiagram(tx, relationshipId, diagramId);
    const updated = await tx.relationshipLayout.update({
      where: { relationshipId },
      data: { sourceAnchor: dto.sourceAnchor, targetAnchor: dto.targetAnchor },
    });
    return toRelationshipLayoutView(updated);
  }
}

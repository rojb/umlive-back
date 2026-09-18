import { Injectable } from '@nestjs/common';
import type { UmlFeatureView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { assertElementInDiagram, assertFeatureInDiagram } from './diagram-scope';
import type { AddFeatureDto } from './dto/add-feature.dto';
import type { ReorderFeaturesDto } from './dto/reorder-features.dto';
import type { UpdateFeatureDto } from './dto/update-feature.dto';
import { toFeatureView } from './uml-mappers';

/**
 * Cuerpos transaccionales de las cuatro mutaciones de miembro de clasificador.
 * **Nota fechada 2026-09-18 (`frontend-cutover`, tarea 4.4).** Los envoltorios
 * públicos (`addFeature`, `updateFeature`, `removeFeature`, `reorderFeatures`)
 * se retiraron con las rutas HTTP que los llamaban; lo que queda son los
 * cuerpos `…In(tx)` que invoca `OperationDispatcher`.
 */
@Injectable()
export class FeaturesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `position` la asigna el servicio: creciente y persistente **por dueño**
   * (no por `kind` — el índice `(ownerId, kind, position)` es de lectura,
   * no de numeración separada; spec "Alta de clasificador con miembros
   * ordenados").
   */
  async addFeatureIn(tx: Tx, diagramId: string, elementId: string, dto: AddFeatureDto): Promise<UmlFeatureView> {
    await assertElementInDiagram(tx, elementId, diagramId);
    const agg = await tx.umlFeature.aggregate({ where: { ownerId: elementId }, _max: { position: true } });
    const position = (agg._max.position ?? -1) + 1;
    const created = await tx.umlFeature.create({
      data: {
        ownerId: elementId,
        kind: dto.kind,
        name: dto.name,
        visibility: dto.visibility,
        typeElementId: dto.typeElementId ?? null,
        typeName: dto.typeName ?? null,
        lowerBound: dto.lowerBound ?? 1,
        upperBound: dto.upperBound === undefined ? 1 : dto.upperBound,
        isStatic: dto.isStatic ?? false,
        isReadonly: dto.isReadonly ?? false,
        isDerived: dto.isDerived ?? false,
        isAbstract: dto.isAbstract ?? false,
        isQuery: dto.isQuery ?? false,
        defaultValue: dto.defaultValue ?? null,
        position,
      },
    });
    return toFeatureView(created);
  }

  async updateFeatureIn(tx: Tx, diagramId: string, featureId: string, dto: UpdateFeatureDto): Promise<UmlFeatureView> {
    await assertFeatureInDiagram(tx, featureId, diagramId);
    const updated = await tx.umlFeature.update({
      where: { id: featureId },
      data: {
        name: dto.name,
        visibility: dto.visibility,
        typeElementId: dto.typeElementId,
        typeName: dto.typeName,
        lowerBound: dto.lowerBound,
        upperBound: dto.upperBound,
        isStatic: dto.isStatic,
        isReadonly: dto.isReadonly,
        isDerived: dto.isDerived,
        isAbstract: dto.isAbstract,
        isQuery: dto.isQuery,
        defaultValue: dto.defaultValue,
      },
    });
    return toFeatureView(updated);
  }

  async removeFeatureIn(tx: Tx, diagramId: string, featureId: string): Promise<void> {
    await assertFeatureInDiagram(tx, featureId, diagramId);
    await tx.umlFeature.delete({ where: { id: featureId } });
  }

  /**
   * Una sola sentencia `VALUES`, SIN fase de desplazamiento (design.md §5,
   * "no sobreingenierizar las otras tres colecciones"): `uml_features` solo
   * tiene `@@index([ownerId, kind, position])`, no único. El `WHERE
   * ... AND owner_id = $1` filtra por dueño — un id ajeno en la lista
   * simplemente no toca ninguna fila, no hace falta la guarda de conjunto
   * que sí necesita `reorderParameters`.
   */
  async reorderFeatureIn(tx: Tx, diagramId: string, elementId: string, dto: ReorderFeaturesDto): Promise<UmlFeatureView[]> {
    await assertElementInDiagram(tx, elementId, diagramId);
    if (dto.orderedFeatureIds.length > 0) {
      // `::int` explícito en `idx`: forzado contra la base real (hallazgo
      // de esta unidad de trabajo, ver `ParametersService.reorderParameters`)
      // — sin el cast, `@prisma/adapter-pg` manda el parámetro como `text`
      // y Postgres rechaza el `UPDATE` con 42804 antes de tocar una fila.
      const values = dto.orderedFeatureIds.map((id, idx) => Prisma.sql`(${id}::uuid, ${idx}::int)`);
      await tx.$executeRaw`
        UPDATE uml_features f SET position = v.pos
        FROM (VALUES ${Prisma.join(values)}) AS v(id, pos)
        WHERE f.id = v.id AND f.owner_id = ${elementId}::uuid
      `;
    }
    const rows = await tx.umlFeature.findMany({
      where: { ownerId: elementId },
      orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    });
    return rows.map((r) => toFeatureView(r));
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { UML_ERROR, type UmlEnumLiteralView, type UmlParameterView } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/tx.type';
import { assertElementInDiagram, assertFeatureInDiagram, assertLiteralInDiagram, assertParameterInDiagram } from './diagram-scope';
import type { AddEnumLiteralDto } from './dto/add-enum-literal.dto';
import type { AddParameterDto } from './dto/add-parameter.dto';
import type { ReorderEnumLiteralsDto } from './dto/reorder-enum-literals.dto';
import type { ReorderParametersDto } from './dto/reorder-parameters.dto';
import type { UpdateParameterDto } from './dto/update-parameter.dto';
import { toLiteralView, toParameterView } from './uml-mappers';

/**
 * Cuerpos transaccionales de parámetros y literales de enum.
 * **Nota fechada 2026-09-18 (`frontend-cutover`, tarea 4.4).** Los envoltorios
 * públicos (`addParameter`, `updateParameter`, `removeParameter`,
 * `reorderParameters`, `addEnumLiteral`, `removeEnumLiteral`,
 * `reorderEnumLiterals`) se retiraron con las rutas HTTP que los llamaban; lo
 * que queda son los cuerpos `…In(tx)` que invoca `OperationDispatcher`.
 */
@Injectable()
export class ParametersService {
  constructor(private readonly prisma: PrismaService) {}

  async addParameterIn(tx: Tx, diagramId: string, operationId: string, dto: AddParameterDto): Promise<UmlParameterView> {
    await assertFeatureInDiagram(tx, operationId, diagramId);
    const agg = await tx.umlParameter.aggregate({ where: { operationId }, _max: { position: true } });
    const position = (agg._max.position ?? -1) + 1;
    const created = await tx.umlParameter.create({
      data: {
        operationId,
        name: dto.name,
        direction: dto.direction,
        typeElementId: dto.typeElementId ?? null,
        typeName: dto.typeName ?? null,
        defaultValue: dto.defaultValue ?? null,
        position,
      },
    });
    return toParameterView(created);
  }

  async updateParameterIn(tx: Tx, diagramId: string, parameterId: string, dto: UpdateParameterDto): Promise<UmlParameterView> {
    await assertParameterInDiagram(tx, parameterId, diagramId);
    const updated = await tx.umlParameter.update({
      where: { id: parameterId },
      data: {
        name: dto.name,
        direction: dto.direction,
        typeElementId: dto.typeElementId,
        typeName: dto.typeName,
        defaultValue: dto.defaultValue,
      },
    });
    return toParameterView(updated);
  }

  async removeParameterIn(tx: Tx, diagramId: string, parameterId: string): Promise<void> {
    await assertParameterInDiagram(tx, parameterId, diagramId);
    await tx.umlParameter.delete({ where: { id: parameterId } });
  }

  /**
   * Desplazamiento en dos fases con guarda de conjunto PRIMERO (design.md §5,
   * tasks.md 4.3). La guarda corre ANTES de tocar una sola fila: si el
   * conjunto recibido no es exactamente el conjunto real (misma
   * cardinalidad, sin faltantes, sin ajenos, sin repetidos), lanza dentro de
   * la misma transacción — Prisma hace rollback de lo que sea que la
   * transacción haya tocado hasta ahí, que es nada.
   *
   * Sin esta guarda, una lista incompleta deja filas varadas en `+K` de
   * forma permanente y el daño es silencioso y acumulativo (design.md §5).
   */
  async reorderParameterIn(tx: Tx, diagramId: string, operationId: string, dto: ReorderParametersDto): Promise<UmlParameterView[]> {
    await assertFeatureInDiagram(tx, operationId, diagramId);

    const existing = await tx.umlParameter.findMany({ where: { operationId }, select: { id: true } });
    const existingIds = new Set(existing.map((p) => p.id));
    const receivedIds = dto.orderedParameterIds;
    const receivedSet = new Set(receivedIds);

    const sameCardinality = receivedIds.length === existingIds.size;
    const noDuplicates = receivedSet.size === receivedIds.length;
    const exactSameSet = receivedSet.size === existingIds.size && [...receivedSet].every((id) => existingIds.has(id));

    if (!sameCardinality || !noDuplicates || !exactSameSet) {
      throw new BadRequestException({ code: UML_ERROR.PARAMETER_SET_MISMATCH });
    }

    // Fase 1 — desplazar por K = max(position) + 1, un solo statement, sin
    // consulta previa aparte de la de la guarda (design.md §5). K > max
    // garantiza que {p + K} no colisiona con ninguna fila vieja, sea cual
    // sea el orden de proceso dentro de la sentencia.
    await tx.$executeRaw`
      UPDATE uml_parameters SET position = position + k.off
      FROM (SELECT max(position) + 1 AS off FROM uml_parameters WHERE operation_id = ${operationId}::uuid) k
      WHERE operation_id = ${operationId}::uuid
    `;

    // Fase 2 — posiciones finales 0..n-1 desde el orden recibido.
    //
    // `::int` en `idx` no es cosmético: forzado contra la base real, sin
    // el cast el driver adapter (`@prisma/adapter-pg`, sin motor Rust)
    // manda el parámetro como `text` y Postgres responde 42804 ("column
    // position is of type integer but expression is of type text") — el
    // `UPDATE` entero revienta como 500 antes de tocar una fila. Hallazgo
    // de esta unidad de trabajo, no anticipado por design.md §5 (su
    // pseudo-SQL usa literales, no parámetros vía driver adapter).
    if (receivedIds.length > 0) {
      const values = receivedIds.map((id, idx) => Prisma.sql`(${id}::uuid, ${idx}::int)`);
      await tx.$executeRaw`
        UPDATE uml_parameters p SET position = v.pos
        FROM (VALUES ${Prisma.join(values)}) AS v(id, pos)
        WHERE p.id = v.id AND p.operation_id = ${operationId}::uuid
      `;
    }

    const rows = await tx.umlParameter.findMany({ where: { operationId }, orderBy: { position: 'asc' } });
    return rows.map((r) => toParameterView(r));
  }

  async addLiteralIn(tx: Tx, diagramId: string, enumId: string, dto: AddEnumLiteralDto): Promise<UmlEnumLiteralView> {
    await assertElementInDiagram(tx, enumId, diagramId);
    const agg = await tx.umlEnumLiteral.aggregate({ where: { enumerationId: enumId }, _max: { position: true } });
    const position = (agg._max.position ?? -1) + 1;
    const created = await tx.umlEnumLiteral.create({
      data: { enumerationId: enumId, name: dto.name, position },
    });
    return toLiteralView(created);
  }

  async removeLiteralIn(tx: Tx, diagramId: string, literalId: string): Promise<void> {
    await assertLiteralInDiagram(tx, literalId, diagramId);
    await tx.umlEnumLiteral.delete({ where: { id: literalId } });
  }

  /** Una sola sentencia `VALUES`, sin guarda de conjunto: `@@unique([enumerationId, name])` es por nombre, no por posición (design.md §5). */
  async reorderLiteralIn(tx: Tx, diagramId: string, enumId: string, dto: ReorderEnumLiteralsDto): Promise<UmlEnumLiteralView[]> {
    await assertElementInDiagram(tx, enumId, diagramId);
    if (dto.orderedLiteralIds.length > 0) {
      // `::int` explícito en `idx` — ver el comentario de `reorderParameters`
      // sobre por qué el driver adapter lo manda como `text` sin el cast.
      const values = dto.orderedLiteralIds.map((id, idx) => Prisma.sql`(${id}::uuid, ${idx}::int)`);
      await tx.$executeRaw`
        UPDATE uml_enum_literals l SET position = v.pos
        FROM (VALUES ${Prisma.join(values)}) AS v(id, pos)
        WHERE l.id = v.id AND l.enumeration_id = ${enumId}::uuid
      `;
    }
    const rows = await tx.umlEnumLiteral.findMany({ where: { enumerationId: enumId }, orderBy: { position: 'asc' } });
    return rows.map((r) => toLiteralView(r));
  }
}

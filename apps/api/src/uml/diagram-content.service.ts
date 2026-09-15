import { Injectable } from '@nestjs/common';
import type { DiagramContent } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import {
  toDiagramSummary,
  toElementView,
  toFeatureView,
  toLayoutView,
  toLiteralView,
  toParameterView,
  toRelationshipEndView,
  toRelationshipLayoutView,
  toRelationshipView,
} from './uml-mappers';

/**
 * `GET /api/projects/:projectId/diagrams/:diagramId` (design.md §8; tasks.md
 * 4.4, ampliado por tasks.md 3.2). M3 reusa este service para el snapshot
 * `version = 0` — sin dependencias de las rutas de mutación (design.md §12).
 *
 * Nueve consultas planas, cada una filtrada por relación hasta `diagramId` —
 * NUNCA por una lista de ids acumulada entre consultas. `features` viene
 * ordenada por `(ownerId, kind, position)`, `parameters` por
 * `(operationId, position)` y `relationshipEnds` por `(relationshipId,
 * endIndex)` — el orden es parte del contrato. `relationshipEnds` solo trae
 * las de `ASSOCIATION` (D4): las otras cuatro relaciones no tienen fila de
 * extremo, así que la consulta no necesita filtrar por `kind` — la ausencia
 * de filas ES el filtro.
 */
@Injectable()
export class DiagramContentService {
  constructor(private readonly prisma: PrismaService) {}

  async getDiagramContent(diagramId: string): Promise<DiagramContent> {
    const [
      diagram,
      elements,
      features,
      parameters,
      enumLiterals,
      layouts,
      relationships,
      relationshipEnds,
      relationshipLayouts,
    ] = await Promise.all([
      this.prisma.diagram.findUniqueOrThrow({
        where: { id: diagramId },
        select: { id: true, name: true, lockState: true, currentVersion: true, createdAt: true, updatedAt: true },
      }),
      // `orderBy` en las cuatro colecciones sin orden natural — agregado
      // 2026-09-14. PostgreSQL NO garantiza orden sin `ORDER BY`, y el
      // comentario de cabecera ya afirmaba que "el orden es parte del
      // contrato". Hoy no rompe nada porque el cliente indexa por id, pero lo
      // necesitan DOS consumidores futuros: el exportador XMI (un documento
      // que cambia de orden entre corridas hace fallar el ida y vuelta de
      // forma intermitente — el peor modo de falla: pasa en la demo, falla en
      // la corrección) y el snapshot `version = 0` de M3 (dos clientes que
      // sincronizan tienen que recibir lo mismo). Se arregla una vez acá en
      // vez de dos veces en cada consumidor. Es aditivo: no cambia qué filas
      // vuelven, solo las vuelve deterministas.
      this.prisma.umlElement.findMany({ where: { diagramId }, orderBy: { id: 'asc' } }),
      this.prisma.umlFeature.findMany({
        where: { owner: { diagramId } },
        orderBy: [{ ownerId: 'asc' }, { kind: 'asc' }, { position: 'asc' }],
      }),
      this.prisma.umlParameter.findMany({
        where: { operation: { owner: { diagramId } } },
        orderBy: [{ operationId: 'asc' }, { position: 'asc' }],
      }),
      this.prisma.umlEnumLiteral.findMany({
        where: { enumeration: { diagramId } },
        orderBy: [{ enumerationId: 'asc' }, { position: 'asc' }],
      }),
      this.prisma.elementLayout.findMany({ where: { element: { diagramId } }, orderBy: { elementId: 'asc' } }),
      this.prisma.umlRelationship.findMany({ where: { diagramId }, orderBy: { id: 'asc' } }),
      this.prisma.umlRelationshipEnd.findMany({
        where: { relationship: { diagramId } },
        orderBy: [{ relationshipId: 'asc' }, { endIndex: 'asc' }],
      }),
      this.prisma.relationshipLayout.findMany({ where: { relationship: { diagramId } }, orderBy: { relationshipId: 'asc' } }),
    ]);

    return {
      diagram: toDiagramSummary(diagram),
      elements: elements.map((e) => toElementView(e)),
      features: features.map((f) => toFeatureView(f)),
      parameters: parameters.map((p) => toParameterView(p)),
      enumLiterals: enumLiterals.map((l) => toLiteralView(l)),
      layouts: layouts.map((l) => toLayoutView(l)),
      relationships: relationships.map((r) => toRelationshipView(r)),
      relationshipEnds: relationshipEnds.map((e) => toRelationshipEndView(e)),
      relationshipLayouts: relationshipLayouts.map((l) => toRelationshipLayoutView(l)),
    };
  }
}

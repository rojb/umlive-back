import { Injectable } from '@nestjs/common';
import type { DiagramContent } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { toDiagramSummary, toElementView, toFeatureView, toLayoutView, toLiteralView, toParameterView } from './uml-mappers';

/**
 * `GET /api/projects/:projectId/diagrams/:diagramId` (design.md §8; tasks.md
 * 4.4). M3 reusa este service para el snapshot `version = 0` — sin
 * dependencias de las rutas de mutación (design.md §12).
 *
 * Cinco consultas planas, cada una filtrada por relación hasta `diagramId` —
 * NUNCA por una lista de ids acumulada entre consultas. `features` viene
 * ordenada por `(ownerId, kind, position)` y `parameters` por
 * `(operationId, position)` — el orden es parte del contrato.
 */
@Injectable()
export class DiagramContentService {
  constructor(private readonly prisma: PrismaService) {}

  async getDiagramContent(diagramId: string): Promise<DiagramContent> {
    const [diagram, elements, features, parameters, enumLiterals, layouts] = await Promise.all([
      this.prisma.diagram.findUniqueOrThrow({
        where: { id: diagramId },
        select: { id: true, name: true, lockState: true, currentVersion: true, createdAt: true, updatedAt: true },
      }),
      this.prisma.umlElement.findMany({ where: { diagramId } }),
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
      this.prisma.elementLayout.findMany({ where: { element: { diagramId } } }),
    ]);

    return {
      diagram: toDiagramSummary(diagram),
      elements: elements.map((e) => toElementView(e)),
      features: features.map((f) => toFeatureView(f)),
      parameters: parameters.map((p) => toParameterView(p)),
      enumLiterals: enumLiterals.map((l) => toLiteralView(l)),
      layouts: layouts.map((l) => toLayoutView(l)),
    };
  }
}

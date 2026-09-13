import { Injectable } from '@nestjs/common';
import type { DiagramSummary } from '@umlive/contracts';
import type { DiagramLockState } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { RenameDiagramDto } from './dto/rename-diagram.dto';

interface DiagramRow {
  id: string;
  name: string;
  lockState: DiagramLockState;
  currentVersion: bigint;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DiagramsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-A09. `lockState: UNLOCKED` y `currentVersion: 0` salen de los
   * `@default` de `schema.prisma` — no hace falta pasarlos a mano. Sin
   * DTO propio: el body es `{ name }`, igual que renombrar, así que
   * reutiliza `RenameDiagramDto` (tasks.md 3.1 solo pide tres DTOs).
   */
  async create(projectId: string, dto: RenameDiagramDto): Promise<DiagramSummary> {
    const diagram = await this.prisma.diagram.create({
      data: { projectId, name: dto.name },
    });
    return this.toSummary(diagram);
  }

  /** Solo `name` es editable en esta rebanada (design.md §6). */
  async rename(diagramId: string, dto: RenameDiagramDto): Promise<DiagramSummary> {
    const diagram = await this.prisma.diagram.update({
      where: { id: diagramId },
      data: { name: dto.name },
    });
    return this.toSummary(diagram);
  }

  /**
   * Borrado suave. Sin endpoint de restauración ni tarea de purga en esta
   * rebanada (propuesta, contradicción 4): `ix_diagrams_project_active`
   * filtra `deletedAt: null` en toda lectura.
   */
  async softDelete(diagramId: string): Promise<void> {
    await this.prisma.diagram.update({
      where: { id: diagramId },
      data: { deletedAt: new Date() },
    });
  }

  private toSummary(d: DiagramRow): DiagramSummary {
    return {
      id: d.id,
      name: d.name,
      lockState: d.lockState,
      currentVersion: Number(d.currentVersion),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }
}

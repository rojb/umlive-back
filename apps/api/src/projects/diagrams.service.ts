import { Injectable } from '@nestjs/common';
import type { DiagramSummary } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DIAGRAM_SUMMARY_SELECT, toDiagramSummary } from './diagram-summary';
import type { RenameDiagramDto } from './dto/rename-diagram.dto';

@Injectable()
export class DiagramsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-A09. `lockState: UNLOCKED` y `currentVersion: 0` salen de los
   * `@default` de `schema.prisma` — no hace falta pasarlos a mano. Sin
   * DTO propio: el body es `{ name }`, igual que renombrar, así que
   * reutiliza `RenameDiagramDto` (tasks.md 3.1 solo pide tres DTOs).
   *
   * `select: DIAGRAM_SUMMARY_SELECT` explícito (no la fila entera): el mapper
   * compartido deriva `freeze` de `lockedAt`/`lockedByUser`, y sin el `select`
   * Prisma no trae la relación. `create` no puede completarlas — un diagrama
   * recién creado está `UNLOCKED` — pero la proyección es la misma que en
   * `rename` para que haya UNA sola forma de la vista.
   */
  async create(projectId: string, dto: RenameDiagramDto): Promise<DiagramSummary> {
    const diagram = await this.prisma.diagram.create({
      data: { projectId, name: dto.name },
      select: DIAGRAM_SUMMARY_SELECT,
    });
    return toDiagramSummary(diagram);
  }

  /** Solo `name` es editable en esta rebanada (design.md §6). */
  async rename(diagramId: string, dto: RenameDiagramDto): Promise<DiagramSummary> {
    const diagram = await this.prisma.diagram.update({
      where: { id: diagramId },
      data: { name: dto.name },
      select: DIAGRAM_SUMMARY_SELECT,
    });
    return toDiagramSummary(diagram);
  }

  /**
   * Borrado suave. Sin endpoint de restauración ni tarea de purga en esta
   * rebanada (propuesta, contradicción 4): `ix_diagrams_project_active`
   * filtra `deletedAt: null` en toda lectura.
   *
   * `join-codes/design.md` §2.5: revoca en la MISMA transacción los códigos
   * activos del diagrama — dejarlo vivo sería una puerta abierta que el
   * host ya no ve en B1. La redención re-chequea `diagram.deletedAt`
   * defensivamente, pero esto es lo que hace que la fila diga la verdad.
   */
  async softDelete(diagramId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.diagram.update({
        where: { id: diagramId },
        data: { deletedAt: new Date() },
      }),
      this.prisma.diagramJoinCode.updateMany({
        where: { diagramId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }
}

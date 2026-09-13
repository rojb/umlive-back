import { ForbiddenException, Injectable } from '@nestjs/common';
import { PROJECT_ERROR } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * MUST rechazar con `403 cannot_remove_host` si `userId` es la fila HOST,
   * sin tocar la fila (design.md §3.1) — quitar al host sería transferir la
   * propiedad (FR-A17), fuera de alcance. `uq_project_single_host` +
   * `trg_members_host_is_owner` son el backstop de base; esto es la ruta de
   * usuario que evita llegar a necesitarlo.
   */
  async remove(projectId: string, userId: string): Promise<void> {
    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!membership) return; // ya no es miembro: DELETE idempotente, sin fila que tocar.

    if (membership.role === 'HOST') {
      throw new ForbiddenException({ code: PROJECT_ERROR.CANNOT_REMOVE_HOST });
    }

    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });

    // M3: cuando exista collaboration.gateway.ts, cerrar acá el socket de
    // este usuario en este proyecto y llamar a
    // locks.releaseAllForUserInDiagrams(userId, diagramIdsDelProyecto).
    // NO usar releaseAllForUser(userId): alcance global, le soltaría los
    // locks de otros proyectos donde userId sigue siendo miembro
    // (design.md §4, LocksService.releaseAllForUser).
  }
}

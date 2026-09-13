import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PROJECT_ERROR, type ProjectMemberView } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AddMemberDto } from './dto/add-member.dto';

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-A08. Solo por email — `404 user_not_found` es una exposición aceptada
   * y declarada (design.md §7.2): la alternativa (`201` sin agregar a nadie)
   * le miente al host. El nuevo miembro siempre entra como `PARTICIPANT`;
   * no hay forma de agregar un segundo `HOST` desde acá.
   */
  async add(projectId: string, dto: AddMemberDto): Promise<ProjectMemberView> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, displayName: true, avatarUrl: true },
    });
    if (!user) {
      throw new NotFoundException({ code: PROJECT_ERROR.USER_NOT_FOUND });
    }

    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (existing) {
      throw new ConflictException({ code: PROJECT_ERROR.ALREADY_MEMBER });
    }

    const member = await this.prisma.projectMember.create({
      data: { projectId, userId: user.id, role: 'PARTICIPANT' },
    });

    return {
      user: { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl },
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    };
  }

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

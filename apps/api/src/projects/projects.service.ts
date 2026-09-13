import { Injectable } from '@nestjs/common';
import type { DashboardResponse, ProjectDetail, ProjectRole, ProjectSummary, UserRef } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateProjectDto } from './dto/create-project.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-A06. Transacción interactiva (no la forma en arreglo de
   * `$transaction`, que no permite encadenar el id generado del primer
   * `create` al segundo): la fila `projects` y la fila `project_members`
   * HOST se escriben juntas o ninguna. `trg_projects_host_is_owner` +
   * `trg_members_host_is_owner` (diferidos) respaldan esto al `COMMIT`
   * (design.md §3.2/§3.3).
   */
  async create(ownerId: string, dto: CreateProjectDto): Promise<ProjectSummary> {
    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: { ownerId, name: dto.name, description: dto.description ?? null },
        include: { owner: { select: { id: true, displayName: true, avatarUrl: true } } },
      });
      await tx.projectMember.create({
        data: { projectId: created.id, userId: ownerId, role: 'HOST' },
      });
      return created;
    });

    const owner = this.toUserRef(project.owner);
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      role: 'HOST',
      owner,
      diagramCount: 0,
      memberCount: 1,
      members: [owner],
      diagramNames: [],
      lastActivityAt: project.updatedAt.toISOString(),
    };
  }

  /**
   * FR-G04. Tres consultas, ninguna en un bucle (design.md §5): membresías
   * del usuario, diagramas activos de esos proyectos (conteo + nombres +
   * `lastActivityAt` en una sola pasada) y miembros de esos proyectos
   * (avatares). El agrupado por `projectId` y el recorte a 3 avatares se
   * hacen acá, en JS, sobre resultados ya acotados.
   */
  async findAllForUser(userId: string): Promise<DashboardResponse> {
    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, project: { deletedAt: null } },
      select: {
        role: true,
        project: {
          select: {
            id: true,
            name: true,
            description: true,
            updatedAt: true,
            owner: { select: { id: true, displayName: true, avatarUrl: true } },
          },
        },
      },
    });

    if (memberships.length === 0) return { owned: [], joined: [] };

    const projectIds = memberships.map((m) => m.project.id);

    const [diagrams, members] = await Promise.all([
      this.prisma.diagram.findMany({
        where: { projectId: { in: projectIds }, deletedAt: null },
        select: { projectId: true, name: true, updatedAt: true },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          projectId: true,
          user: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
    ]);

    const diagramsByProject = new Map<string, typeof diagrams>();
    for (const d of diagrams) {
      const list = diagramsByProject.get(d.projectId);
      if (list) list.push(d);
      else diagramsByProject.set(d.projectId, [d]);
    }

    const membersByProject = new Map<string, typeof members>();
    for (const m of members) {
      const list = membersByProject.get(m.projectId);
      if (list) list.push(m);
      else membersByProject.set(m.projectId, [m]);
    }

    const owned: ProjectSummary[] = [];
    const joined: ProjectSummary[] = [];

    for (const membership of memberships) {
      const p = membership.project;
      const projectDiagrams = diagramsByProject.get(p.id) ?? [];
      const projectMembers = membersByProject.get(p.id) ?? [];

      let lastActivityAt = p.updatedAt;
      for (const d of projectDiagrams) {
        if (d.updatedAt > lastActivityAt) lastActivityAt = d.updatedAt;
      }

      const summary: ProjectSummary = {
        id: p.id,
        name: p.name,
        description: p.description,
        role: membership.role,
        owner: this.toUserRef(p.owner),
        diagramCount: projectDiagrams.length,
        memberCount: projectMembers.length,
        members: projectMembers.slice(0, 3).map((m) => this.toUserRef(m.user)),
        diagramNames: projectDiagrams.map((d) => d.name),
        lastActivityAt: lastActivityAt.toISOString(),
      };

      (membership.role === 'HOST' ? owned : joined).push(summary);
    }

    return { owned, joined };
  }

  /**
   * `project.view` — fila agregada a la matriz, no está en FR-A13 (design.md
   * §2.4). `role` llega resuelto por `ProjectAccessGuard`, no se vuelve a
   * calcular acá.
   */
  async findOne(projectId: string, role: ProjectRole): Promise<ProjectDetail> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        description: true,
        updatedAt: true,
        owner: { select: { id: true, displayName: true, avatarUrl: true } },
        members: {
          select: {
            role: true,
            joinedAt: true,
            user: { select: { id: true, displayName: true, avatarUrl: true } },
          },
        },
        diagrams: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            lockState: true,
            currentVersion: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    let lastActivityAt = project.updatedAt;
    for (const d of project.diagrams) {
      if (d.updatedAt > lastActivityAt) lastActivityAt = d.updatedAt;
    }

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      role,
      owner: this.toUserRef(project.owner),
      diagramCount: project.diagrams.length,
      memberCount: project.members.length,
      diagramNames: project.diagrams.map((d) => d.name),
      lastActivityAt: lastActivityAt.toISOString(),
      members: project.members.map((m) => ({
        user: this.toUserRef(m.user),
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
      diagrams: project.diagrams.map((d) => ({
        id: d.id,
        name: d.name,
        lockState: d.lockState,
        currentVersion: Number(d.currentVersion),
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      })),
    };
  }

  private toUserRef(user: { id: string; displayName: string; avatarUrl: string | null }): UserRef {
    return { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl };
  }
}

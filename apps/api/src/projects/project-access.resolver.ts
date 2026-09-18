import { Injectable } from '@nestjs/common';
import { can, type ProjectAction, PROJECT_ERROR, type ProjectErrorCode } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { ProjectContext } from './guards/project-context.decorator';

/** Forma, no versión: Postgres acepta cualquier UUID válido como `uuid`, y acá solo interesa no llegar a la base con basura. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProjectAccessResult =
  | { ok: true; context: ProjectContext }
  | { ok: false; reason: 'bad_request' | ProjectErrorCode };

export interface ProjectAccessInput {
  userId: string;
  projectId?: string;
  diagramId?: string;
  action: ProjectAction;
}

/**
 * Provider plano (design.md §D2, tasks.md 1.1). La consulta diagrama→
 * proyecto→membresía→`can()` MUDADA acá desde `ProjectAccessGuard`
 * (`project-access.guard.ts:84-132`, previo a esta rebanada). El guard
 * conserva control de flujo, excepciones, códigos de error y el log de
 * "ruta sin acción declarada" — todo eso es metadata de handler HTTP, no
 * dato. Este resolver NUNCA lanza: dentro de un middleware de Socket.IO una
 * excepción HTTP no se traduce a nada útil (design.md §D2, alternativa
 * rechazada (a)). Devuelve una unión discriminada; el llamador decide cómo
 * traducirla (excepción HTTP en el guard, `connect_error` en el gateway).
 */
@Injectable()
export class ProjectAccessResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolveAccess(input: ProjectAccessInput): Promise<ProjectAccessResult> {
    const { userId, action } = input;
    let { projectId, diagramId } = input;

    if (projectId && !UUID_SHAPE.test(projectId)) {
      return { ok: false, reason: 'bad_request' };
    }
    if (diagramId && !UUID_SHAPE.test(diagramId)) {
      return { ok: false, reason: 'bad_request' };
    }

    let diagram: ProjectContext['diagram'];

    if (diagramId) {
      const found = await this.prisma.diagram.findUnique({
        where: { id: diagramId },
        select: { id: true, projectId: true, deletedAt: true, lockState: true },
      });
      // Inexistente, borrado, o de un proyecto distinto al esperado: mismo
      // código. No confirmar cuál de las tres cosas pasó (design.md §7.2).
      if (!found || found.deletedAt || (projectId && found.projectId !== projectId)) {
        return { ok: false, reason: PROJECT_ERROR.DIAGRAM_NOT_FOUND };
      }
      projectId = found.projectId;
      diagram = { id: found.id, projectId: found.projectId, lockState: found.lockState };
    }

    if (!projectId) {
      // Ni `projectId` ni `diagramId` resolubles: el llamador (guard o
      // gateway) no debería haber llegado acá. Fallo cerrado igual.
      return { ok: false, reason: 'bad_request' };
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    if (!project || project.deletedAt) {
      return { ok: false, reason: PROJECT_ERROR.PROJECT_NOT_FOUND };
    }

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    // No-miembro y miembro-con-rol-insuficiente responden IGUAL (design.md
    // §7.2, SC-A12 respaldo): un id es un UUIDv4 no enumerable.
    if (!membership || !can(membership.role, action)) {
      return { ok: false, reason: PROJECT_ERROR.INSUFFICIENT_ROLE };
    }

    return { ok: true, context: { projectId, role: membership.role, diagram } };
  }
}

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { ProjectRole } from '@umlive/contracts';
import type { DiagramLockState } from '../../generated/prisma/enums';
import type { Request } from 'express';

/**
 * Lo que `ProjectAccessGuard` deja resuelto en `req.projectContext` (design.md
 * §2.3). El service lo lee con `@ProjectContext()` en vez de volver a
 * consultar `project_members` — la consulta de `diagramId → projectId` no es
 * extra, está mudada del service al guard.
 */
export interface ProjectContext {
  projectId: string;
  role: ProjectRole;
  diagram?: { id: string; projectId: string; lockState: DiagramLockState };
}

interface RequestWithProjectContext extends Request {
  projectContext?: ProjectContext;
}

export const ProjectContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ProjectContext => {
    const req = ctx.switchToHttp().getRequest<RequestWithProjectContext>();
    // No-null-assertion deliberada: si este decorador se usa en una ruta que
    // `ProjectAccessGuard` no protegió (sin `projectId`/`diagramId` en la
    // ruta), es un error de programación en esta rebanada, no un caso a
    // manejar en runtime.
    return req.projectContext as ProjectContext;
  },
);

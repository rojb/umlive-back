import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type ProjectAction, PROJECT_ERROR } from '@umlive/contracts';
import type { Request } from 'express';
import type { CurrentUserPayload } from '../../auth/current-user.decorator';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProjectContext } from './project-context.decorator';
import { PROJECT_ACTION_KEY } from './requires-project-action.decorator';

interface RequestWithProjectContext extends Request {
  user?: CurrentUserPayload;
  projectContext?: ProjectContext;
}

/** Forma, no versión: Postgres acepta cualquier UUID válido como `uuid`, y acá solo interesa no llegar a la base con basura. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `APP_GUARD` global, registrado SEGUNDO en `app.module.ts` — DESPUÉS de
 * `JwtAuthGuard` (design.md §2.2). El modo de falla que importa: una ruta
 * nueva con `projectId`/`diagramId` en los params y sin `@RequiresProjectAction`
 * responde `403` y loguea el handler, en vez de dejar pasar.
 *
 * `PrismaModule` es `@Global()`, así que este guard inyecta `PrismaService`
 * desde el inyector raíz sin que `ProjectsModule` lo importe explícitamente.
 *
 * **Nota de orden de ejecución (desviación respecto a la lectura literal de
 * design.md §7.1):** los guards de Nest corren ANTES que los pipes de
 * parámetro — `ParseUUIDPipe` en el controller todavía no validó `:projectId`
 * / `:diagramId` cuando este guard se ejecuta. Confiar solo en el pipe
 * dejaría un uuid malformado llegar a una consulta de Prisma antes de que el
 * pipe alcance a rechazarlo con `400`. Por eso el guard valida la FORMA acá
 * también, con el mismo resultado (`400`, sin tocar la base) que pide la
 * spec — `ParseUUIDPipe` en el controller queda como segunda barrera, no
 * como la única.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  private readonly logger = new Logger(ProjectAccessGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithProjectContext>();
    // Los params de ruta de Express tipan `string | string[]` en general
    // (por rutas con comodines), pero un segmento `:projectId`/`:diagramId`
    // simple SIEMPRE llega como string. Se afirma acá para no propagar el
    // tipo unión a todo el resto del método.
    const projectIdParam = request.params.projectId as string | undefined;
    const diagramIdParam = request.params.diagramId as string | undefined;

    // Ni `projectId` ni `diagramId` en la ruta: no es una ruta de alcance de
    // proyecto (auth/*, users/me, POST /projects). Pasa sin consultar nada.
    if (!projectIdParam && !diagramIdParam) return true;

    const action = this.reflector.getAllAndOverride<ProjectAction | undefined>(PROJECT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!action) {
      const handlerName = `${context.getClass().name}.${context.getHandler().name}`;
      this.logger.error(`ruta de proyecto sin acción declarada: ${handlerName}`);
      throw new ForbiddenException({ code: PROJECT_ERROR.INSUFFICIENT_ROLE });
    }

    if (projectIdParam && !UUID_SHAPE.test(projectIdParam)) {
      throw new BadRequestException();
    }
    if (diagramIdParam && !UUID_SHAPE.test(diagramIdParam)) {
      throw new BadRequestException();
    }

    let projectId: string;
    let diagram: ProjectContext['diagram'];

    if (diagramIdParam) {
      const found = await this.prisma.diagram.findUnique({
        where: { id: diagramIdParam },
        select: { id: true, projectId: true, deletedAt: true, lockState: true },
      });
      // Inexistente, borrado, o de un proyecto distinto al de la ruta: mismo
      // código. No confirmar cuál de las tres cosas pasó (design.md §7.2).
      if (!found || found.deletedAt || (projectIdParam && found.projectId !== projectIdParam)) {
        throw new NotFoundException({ code: PROJECT_ERROR.DIAGRAM_NOT_FOUND });
      }
      projectId = found.projectId;
      diagram = { id: found.id, projectId: found.projectId, lockState: found.lockState };
    } else {
      // biome-ignore lint/style/noNonNullAssertion: projectIdParam truthy por el guard de arriba
      projectId = projectIdParam!;
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, deletedAt: true },
    });
    if (!project || project.deletedAt) {
      throw new NotFoundException({ code: PROJECT_ERROR.PROJECT_NOT_FOUND });
    }

    // Este guard corre después de `JwtAuthGuard` (orden fijo en app.module.ts):
    // en toda ruta no pública que llega hasta acá, `req.user` ya existe.
    const userId = (request.user as CurrentUserPayload).id;

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    // No-miembro y miembro-con-rol-insuficiente responden IGUAL (design.md
    // §7.2, SC-A12 respaldo): un projectId es un UUIDv4 no enumerable, a
    // diferencia del email en `auth` (SC-A04).
    if (!membership || !can(membership.role, action)) {
      throw new ForbiddenException({ code: PROJECT_ERROR.INSUFFICIENT_ROLE });
    }

    request.projectContext = { projectId, role: membership.role, diagram };
    return true;
  }
}

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
import { type ProjectAction, PROJECT_ERROR } from '@umlive/contracts';
import type { Request } from 'express';
import type { CurrentUserPayload } from '../../auth/current-user.decorator';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator';
import { ProjectAccessResolver } from '../project-access.resolver';
import type { ProjectContext } from './project-context.decorator';
import { PROJECT_ACTION_KEY } from './requires-project-action.decorator';

interface RequestWithProjectContext extends Request {
  user?: CurrentUserPayload;
  projectContext?: ProjectContext;
}

/**
 * `APP_GUARD` global, registrado SEGUNDO en `app.module.ts` — DESPUÉS de
 * `JwtAuthGuard` (design.md §2.2). El modo de falla que importa: una ruta
 * nueva con `projectId`/`diagramId` en los params y sin `@RequiresProjectAction`
 * responde `403` y loguea el handler, en vez de dejar pasar.
 *
 * La consulta diagrama→proyecto→membresía→`can()` vive en
 * `ProjectAccessResolver` (collaboration-gateway/design.md §D2) — este guard
 * conserva el control de flujo, las excepciones, los códigos de error y el
 * log de "ruta sin acción declarada"; **solo delega la consulta**.
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
    private readonly resolver: ProjectAccessResolver,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    if (context.getType() === 'ws') {
      // Un socket no tiene params de ruta: la autorización de sala se
      // resolvió en el handshake (collaboration-gateway/design.md §D3) y
      // quedó en `socket.data.access`. Acá solo se comprueba su presencia —
      // misma política de fallo cerrado que en HTTP. `switchToHttp().getRequest()`
      // sobre un socket devuelve el `Socket` crudo, sin `.params` — de ahí
      // el `TypeError` que esta rama existe para evitar.
      const client = context.switchToWs().getClient<{ data?: { access?: unknown } }>();
      return client.data?.access !== undefined;
    }

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

    // Este guard corre después de `JwtAuthGuard` (orden fijo en app.module.ts):
    // en toda ruta no pública que llega hasta acá, `req.user` ya existe.
    const userId = (request.user as CurrentUserPayload).id;

    // La consulta (forma UUID, lookup de diagrama/proyecto/membresía,
    // `can()`) vive en el resolver (collaboration-gateway/design.md §D2).
    // Este guard solo traduce el veredicto a excepciones HTTP — mismos
    // códigos y orden que antes de la extracción.
    const result = await this.resolver.resolveAccess({ userId, projectId: projectIdParam, diagramId: diagramIdParam, action });

    if (!result.ok) {
      if (result.reason === 'bad_request') {
        throw new BadRequestException();
      }
      if (result.reason === PROJECT_ERROR.DIAGRAM_NOT_FOUND) {
        throw new NotFoundException({ code: PROJECT_ERROR.DIAGRAM_NOT_FOUND });
      }
      if (result.reason === PROJECT_ERROR.PROJECT_NOT_FOUND) {
        throw new NotFoundException({ code: PROJECT_ERROR.PROJECT_NOT_FOUND });
      }
      // No-miembro y miembro-con-rol-insuficiente responden IGUAL (design.md
      // §7.2, SC-A12 respaldo): un projectId es un UUIDv4 no enumerable, a
      // diferencia del email en `auth` (SC-A04).
      throw new ForbiddenException({ code: PROJECT_ERROR.INSUFFICIENT_ROLE });
    }

    request.projectContext = result.context;
    return true;
  }
}

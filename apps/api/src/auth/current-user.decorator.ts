import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Lo que `JwtStrategy.validate()` deja en `req.user`. Deliberadamente sin
 * rol: la autorización se resuelve por petición contra `project_members` en
 * las rebanadas siguientes, nunca desde el token (design.md §4.1).
 */
export interface CurrentUserPayload {
  id: string;
  /** Id de la fila `refresh_tokens` vigente — lo que SC-A07 revoca salvo éste. */
  sid: string;
  displayName: string;
}

interface RequestWithUser extends Request {
  user: CurrentUserPayload;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    return req.user;
  },
);

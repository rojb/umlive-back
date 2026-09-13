import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/**
 * Registrado como `APP_GUARD` global en `app.module.ts` (design.md §5). El
 * modo de falla que importa no es un endpoint público protegido de más — es
 * un endpoint privado sin `@UseGuards`, y quedan rebanadas enteras por
 * escribir sobre esta base. Con el guard global, olvidarse el decorador
 * CIERRA el endpoint en vez de abrirlo.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

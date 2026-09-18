import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

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

    if (context.getType() === 'ws') {
      // Passport no sirve acá: su extractor lee `request.headers.authorization`
      // y un `Socket` guarda las suyas en `handshake.headers`
      // (collaboration-gateway/design.md §D1). La identidad la dejó el
      // portón del handshake en `socket.data.user` — este guard solo
      // comprueba que esté PRESENTE, no que esté FRESCA. Si además exigiera
      // `exp` vigente, rechazaría `auth:token` — el evento con el que el
      // cliente renueva — y el socket no podría salvarse nunca. El
      // vencimiento lo hace cumplir el barrido del gateway, no este guard.
      const client = context.switchToWs().getClient<{ data?: { user?: unknown } }>();
      return client.data?.user !== undefined;
    }

    return super.canActivate(context);
  }
}

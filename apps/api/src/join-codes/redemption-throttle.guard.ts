import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { JOIN_CODE_ERROR, normalizeJoinCode } from '@umlive/contracts';
import type { Request, Response } from 'express';
import type { CurrentUserPayload } from '../auth/current-user.decorator';
import { RedemptionAttemptsService } from './redemption-attempts.service';

/** FR-A02-adjacent, design.md §5.1 — tabla de cubetas. Actor es la defensa principal, al revés que en `auth`. */
const ACTOR_LIMIT = 10;
const IP_LIMIT = 30;
const CODE_LIMIT = 5;

interface RequestWithUser extends Request {
  user?: CurrentUserPayload;
}

/**
 * Orden fijo: `JwtAuthGuard` (global) → `ProjectAccessGuard` (global, pasa
 * de largo — esta ruta no lleva `:projectId`/`:diagramId`) → este guard, de
 * handler. Cuando corre, `req.user` YA EXISTE (design.md §5.1) — eso es lo
 * que permite llavear por actor. Lee `req.body.code` CRUDO, todavía sin
 * `ValidationPipe` (corre después de los guards), igual que
 * `login-throttle.guard.ts:42`.
 *
 * Comentario deliberado, igual que `LoginThrottleGuard`: este guard SOLO
 * LEE contadores. Quien los ESCRIBE es `RedemptionService`, después de saber
 * si la redención falló — un guard no sabe, y no debe adivinar, si el código
 * era válido.
 */
@Injectable()
export class RedemptionThrottleGuard implements CanActivate {
  constructor(private readonly attempts: RedemptionAttemptsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const res = context.switchToHttp().getResponse<Response>();

    // `JwtAuthGuard` ya corrió y rechazó sin sesión — `req.user` existe acá.
    const actorKey = this.attempts.actorKey((req.user as CurrentUserPayload).id);
    if (this.attempts.countRecent(actorKey) >= ACTOR_LIMIT) {
      this.reject(res, this.attempts.retryAfterSeconds(actorKey));
    }

    const ipKey = this.attempts.ipKey(req.ip ?? 'unknown');
    if (this.attempts.countRecent(ipKey) >= IP_LIMIT) {
      this.reject(res, this.attempts.retryAfterSeconds(ipKey));
    }

    const rawCode = typeof req.body?.code === 'string' ? req.body.code : '';
    const codeKey = this.attempts.codeKey(normalizeJoinCode(rawCode));
    if (this.attempts.countRecent(codeKey) >= CODE_LIMIT) {
      this.reject(res, this.attempts.retryAfterSeconds(codeKey));
    }

    return true;
  }

  private reject(res: Response, retryAfterSeconds: number): never {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException({ code: JOIN_CODE_ERROR.TOO_MANY_ATTEMPTS }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

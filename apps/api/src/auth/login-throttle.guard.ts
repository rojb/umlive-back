import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { AUTH_ERROR } from '@umlive/contracts';
import type { Request, Response } from 'express';
import { LoginAttemptsService } from './login-attempts.service';

/** FR-A02, design.md §2.1 — tabla de cubetas. */
const IP_LIMIT = 30;
const IDENTIFIER_LIMIT = 5;

/**
 * Orden fijo y único para todo intento de login: IP → identificador →
 * verificación de credencial (design.md §2.1). Este guard corre ANTES del
 * controller — Nest ejecuta guards antes que pipes, así que lee `req.body`
 * todavía sin pasar por el `ValidationPipe` global, pero el body ya está
 * parseado por el middleware JSON de Express.
 *
 * Comentario deliberado: este guard SOLO LEE contadores. Quien los ESCRIBE
 * es `AuthService`, después de saber si el intento falló — un guard no sabe,
 * y no debe adivinar, si hubo fallo de credencial (design.md §2.2). Si
 * superara el umbral, corta con `429` antes de que el controller llegue a
 * invocar `verify()`, que es exactamente el punto de FR-A02.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(private readonly attempts: LoginAttemptsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const ipKey = this.attempts.ipKey(req.ip ?? 'unknown');
    if (this.attempts.countRecent(ipKey) >= IP_LIMIT) {
      this.reject(res, this.attempts.retryAfterSeconds(ipKey));
    }

    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const identifierKey = this.attempts.identifierKey(email);
    if (this.attempts.countRecent(identifierKey) >= IDENTIFIER_LIMIT) {
      this.reject(res, this.attempts.retryAfterSeconds(identifierKey));
    }

    return true;
  }

  private reject(res: Response, retryAfterSeconds: number): never {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new HttpException(
      { code: AUTH_ERROR.TOO_MANY_ATTEMPTS },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

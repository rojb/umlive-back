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

/**
 * Throttle de REGISTRO por IP (D4 de
 * `nfr-verification-and-security-hardening/design.md`, PO-2).
 *
 * Cuenta **todo intento de registro**, no solo los fallos: el abuso que se
 * quiere frenar es crear cuentas en masa, y SC-A02 hace del registro un oráculo
 * de emails. Diez intentos por IP cada 15 min dejan registrar gente en una red
 * NAT compartida y le ponen techo a un script.
 *
 * **Rompe a propósito la regla «el guard solo lee»** de `login-throttle.guard.ts`:
 * esa regla existe porque ese guard no conoce el resultado del intento (lo
 * escribe `AuthService` después de verificar credenciales). Acá el resultado no
 * importa — se cuenta todo intento —, así que leer y escribir en el mismo tick
 * es correcto. Contar en el guard incluye los `400` del `ValidationPipe`, que
 * corre después: eso es exactamente lo buscado.
 *
 * El intento rechazado con `429` **no suma**, igual que en el login: si sumara,
 * una IP bloqueada alargaría su propio bloqueo para siempre con cada reintento,
 * y `Retry-After` mentiría.
 */
const REGISTRATION_LIMIT = 10;

@Injectable()
export class RegistrationThrottleGuard implements CanActivate {
  constructor(private readonly attempts: LoginAttemptsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const key = this.attempts.registrationIpKey(req.ip ?? 'unknown');

    if (this.attempts.countRecent(key) >= REGISTRATION_LIMIT) {
      // Sin `registerFailure`: el rechazo no consume cupo.
      res.setHeader('Retry-After', String(this.attempts.retryAfterSeconds(key)));
      throw new HttpException({ code: AUTH_ERROR.TOO_MANY_ATTEMPTS }, HttpStatus.TOO_MANY_REQUESTS);
    }

    // Lectura y escritura sin `await` intermedio: el mismo tick, atómico en el
    // modelo de un solo hilo de Node (igual que `LocksService.acquire`).
    this.attempts.registerFailure(key);
    return true;
  }
}

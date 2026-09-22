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
 * de emails.
 *
 * **El techo pasó de 10 a 30 por IP cada 15 min (2026-09-22).** Diez alcanzaba
 * para una IP doméstica y quedaba corto para el caso que esta aplicación tiene
 * de verdad: un aula entera detrás de una sola NAT universitaria, donde treinta
 * personas registrándose a la vez agotaban el cupo antes de la mitad. Treinta
 * sigue siendo un techo real —ciento veinte cuentas por hora desde un mismo
 * origen— y no cambia nada de lo demás: la ventana, el conteo de todo intento y
 * el no-consumo del rechazo siguen igual. Subirlo debilita el control en la
 * misma proporción en que lo agranda; no se sube «por las dudas».
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
const REGISTRATION_LIMIT = 30;

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

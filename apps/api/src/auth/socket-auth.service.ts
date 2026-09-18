import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { CurrentUserPayload } from './current-user.decorator';
import { JWT_ACCESS_AUDIENCE, JWT_ACCESS_ISSUER } from './jwt-access.constants';

/** Misma forma que `JwtAccessPayload` de `jwt.strategy.ts`, más `exp`. */
interface JwtAccessPayloadWithExp {
  sub: string;
  sid: string;
  name: string;
  iat: number;
  exp: number;
}

export type VerifiedAccessToken = CurrentUserPayload & { exp: number };

/**
 * Verificación del access token para el transporte WebSocket
 * (collaboration-gateway/design.md §D4). Inyecta el `JwtService` que
 * `AuthModule` ya registra (`JwtModule.register({})`, sin secreto propio —
 * cada `signAsync`/`verifyAsync` lo pasa explícito) y verifica con el MISMO
 * secreto, issuer y audience que `JwtStrategy`.
 *
 * **Por qué no Passport**: `JwtStrategy` está cableada a
 * `ExtractJwt.fromAuthHeaderAsBearerToken()`, que lee `request.headers.authorization`.
 * El token del socket viaja en `handshake.auth.token` — no hay `request` real
 * que envolver sin fabricar uno sintético. Verificar directo con `JwtService`
 * es menos piezas para el mismo resultado.
 */
@Injectable()
export class SocketAuthService {
  private readonly accessSecret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
  }

  /**
   * `null` ante cualquier fallo (ausente, mal formado, mal firmado, vencido,
   * issuer/audience distinto) — el llamador (middleware de handshake,
   * handler `auth:token`) decide el código de rechazo. Nunca lanza: dentro de
   * un middleware de Socket.IO una excepción sin capturar no se traduce a un
   * `connect_error` legible.
   */
  async verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
    try {
      const payload = await this.jwt.verifyAsync<JwtAccessPayloadWithExp>(token, {
        secret: this.accessSecret,
        issuer: JWT_ACCESS_ISSUER,
        audience: JWT_ACCESS_AUDIENCE,
      });
      return { id: payload.sub, sid: payload.sid, displayName: payload.name, exp: payload.exp };
    } catch {
      return null;
    }
  }
}

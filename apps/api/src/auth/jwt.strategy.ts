import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { CurrentUserPayload } from './current-user.decorator';
import { JWT_ACCESS_AUDIENCE, JWT_ACCESS_ISSUER } from './jwt-access.constants';

/** Forma exacta firmada por `TokensService.signAccess` (design.md §4.1). */
interface JwtAccessPayload {
  sub: string;
  sid: string;
  name: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? '',
      issuer: JWT_ACCESS_ISSUER,
      audience: JWT_ACCESS_AUDIENCE,
      ignoreExpiration: false,
    });
  }

  /**
   * Sin roles, deliberadamente: la autorización se resuelve por petición
   * contra `project_members` en las rebanadas siguientes, nunca desde acá
   * (design.md §4.1 — INV-2).
   */
  validate(payload: JwtAccessPayload): CurrentUserPayload {
    return { id: payload.sub, sid: payload.sid, displayName: payload.name };
  }
}

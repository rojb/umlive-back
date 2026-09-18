import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JWT_ACCESS_AUDIENCE, JWT_ACCESS_ISSUER } from './jwt-access.constants';

/**
 * Emisión, rotación y revocación de sesión (access + refresh token).
 *
 * Design.md §4. Dos decisiones que no son obvias leyendo el código:
 *
 *   1. `sid` (en el access token) es el `id` de la fila `refresh_tokens`
 *      emitida EN LA MISMA respuesta. Access y refresh se emiten siempre
 *      juntos — nunca por separado — así que `sid` nunca sobrevive a una
 *      rotación que lo dejaría obsoleto. Es lo que permite SC-A07 sin
 *      columna nueva (§8 del diseño).
 *
 *   2. El refresh token ES un JWT (firma + `exp`) Y ADEMÁS su hash sha256 se
 *      guarda en la base (`token_hash`). Las dos mitades hacen falta: la
 *      firma descarta basura y tokens vencidos sin tocar la base; el hash
 *      guarda garantiza que un volcado de la base no entrega tokens usables
 *      y que un token forjado con el secreto filtrado pero un `jti` real
 *      tampoco valida, porque su sha256 no va a coincidir con la fila.
 */

// `ISS`/`AUD` mudados a `jwt-access.constants.ts` (collaboration-gateway/
// design.md §D4) — `SocketAuthService` los importa desde ahí también. Mismos
// valores, un solo lugar.
const ISS = JWT_ACCESS_ISSUER;
const AUD = JWT_ACCESS_AUDIENCE;

/**
 * Convierte un TTL humano ("15m", "30d") o segundos crudos ("900") a
 * segundos. Sin dependencia nueva — `jsonwebtoken` tipa `expiresIn` con un
 * literal de `ms` que no vale la pena importar para esto solo.
 */
function parseTtlSeconds(raw: string): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(raw.trim());
  if (!match) throw new Error(`TTL inválido en la configuración: "${raw}"`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 's') as 's' | 'm' | 'h' | 'd';
  const secondsPerUnit: Record<'s' | 'm' | 'h' | 'd', number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  return value * secondsPerUnit[unit];
}

interface AccessPayload {
  sub: string;
  sid: string;
  name: string;
}

interface RefreshPayload {
  sub: string;
  jti: string;
  typ: 'refresh';
}

export interface IssuedSession {
  accessToken: string;
  /** Segundos hasta el vencimiento del access token — para `AuthSession.expiresIn`. */
  expiresIn: number;
  refreshJwt: string;
  refreshExpiresAt: Date;
}

export type RotateOutcome =
  | { ok: true; session: IssuedSession }
  /** Firma inválida, vencido, `jti` inexistente, o hash que no coincide. */
  | { ok: false; reason: 'invalid' }
  /** El token presentado ya había sido rotado — replay (SC-A06). */
  | { ok: false; reason: 'replay' };

interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class TokensService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.accessSecret = config.get<string>('JWT_ACCESS_SECRET') ?? '';
    this.refreshSecret = config.get<string>('JWT_REFRESH_SECRET') ?? '';
    this.accessTtlSeconds = parseTtlSeconds(config.get<string>('ACCESS_TOKEN_TTL') ?? '15m');
    this.refreshTtlSeconds = parseTtlSeconds(config.get<string>('REFRESH_TOKEN_TTL') ?? '30d');
  }

  /**
   * Emite access + refresh juntos. Se usa en `register`, `login` y en cada
   * rotación — nunca uno sin el otro (design.md §4.1).
   */
  async issue(userId: string, displayName: string, meta?: SessionMeta): Promise<IssuedSession> {
    // El jti se decide ANTES de firmar: la fila y el JWT comparten id.
    const jti = randomUUID();
    const refreshJwt = await this.signRefresh({ sub: userId, jti, typ: 'refresh' });
    const refreshExpiresAt = this.expiryOf(refreshJwt);

    await this.prisma.refreshToken.create({
      data: {
        id: jti,
        userId,
        tokenHash: this.hash(refreshJwt),
        expiresAt: refreshExpiresAt,
        userAgent: meta?.userAgent,
        ipAddress: meta?.ip,
      },
    });

    const accessToken = await this.signAccess({ sub: userId, sid: jti, name: displayName });
    return { accessToken, expiresIn: this.expiresInOf(accessToken), refreshJwt, refreshExpiresAt };
  }

  /**
   * SC-A05 / SC-A06. Ver diagrama de design.md §4.4.
   *
   * Orden de validación: firma/exp → fila por `jti` → hash coincide →
   * `revoked_at` (replay) → `expires_at`. Todo dentro de una transacción para
   * la rotación: `replaced_by` es `@unique`, así que dos renovaciones
   * simultáneas del mismo token colisionan en la base — la ganadora rota, la
   * perdedora recibe `invalid`. No hace falta un bloqueo aplicativo.
   */
  async rotate(refreshJwt: string, meta?: SessionMeta): Promise<RotateOutcome> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshPayload>(refreshJwt, {
        secret: this.refreshSecret,
      });
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    const row = await this.prisma.refreshToken.findUnique({ where: { id: payload.jti } });
    if (!row || row.tokenHash !== this.hash(refreshJwt)) {
      return { ok: false, reason: 'invalid' };
    }

    if (row.revokedAt !== null) {
      // T1 ya había sido rotado: esto es un replay. Revoca la cadena entera,
      // incluida la punta viva, y lo reporta — nunca rota sobre un replay.
      await this.revokeChain(row.id);
      return { ok: false, reason: 'replay' };
    }

    if (row.expiresAt <= new Date()) {
      return { ok: false, reason: 'invalid' };
    }

    const newJti = randomUUID();
    const newRefreshJwt = await this.signRefresh({ sub: row.userId, jti: newJti, typ: 'refresh' });
    const newExpiresAt = this.expiryOf(newRefreshJwt);

    try {
      await this.prisma.$transaction([
        this.prisma.refreshToken.create({
          data: {
            id: newJti,
            userId: row.userId,
            tokenHash: this.hash(newRefreshJwt),
            expiresAt: newExpiresAt,
            userAgent: meta?.userAgent,
            ipAddress: meta?.ip,
          },
        }),
        this.prisma.refreshToken.update({
          where: { id: row.id },
          data: { revokedAt: new Date(), replacedById: newJti },
        }),
      ]);
    } catch {
      // Carrera perdida contra la unicidad de `replaced_by` (SC-A05, nota).
      return { ok: false, reason: 'invalid' };
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
    const accessToken = await this.signAccess({ sub: row.userId, sid: newJti, name: user.displayName });

    return {
      ok: true,
      session: {
        accessToken,
        expiresIn: this.expiresInOf(accessToken),
        refreshJwt: newRefreshJwt,
        refreshExpiresAt: newExpiresAt,
      },
    };
  }

  /**
   * «Revocar la cadena entera» (SC-A06): todos los eslabones alcanzables
   * desde `tokenId`, hacia atrás y hacia adelante por `replaced_by`, hasta la
   * punta viva — NO «todos los tokens del usuario» (design.md §4.4). Con
   * hasta ~2.880 rotaciones posibles en 30 días, recorrer la cadena con un
   * bucle de consultas es inaceptable: se hace en una sola consulta con CTE
   * recursiva. `UNION` (no `UNION ALL`) corta ciclos.
   */
  async revokeChain(tokenId: string): Promise<void> {
    await this.prisma.$queryRaw`
      WITH RECURSIVE chain(id, replaced_by) AS (
        SELECT id, replaced_by FROM refresh_tokens WHERE id = ${tokenId}::uuid
        UNION
        SELECT t.id, t.replaced_by FROM refresh_tokens t, chain c
         WHERE t.replaced_by = c.id OR t.id = c.replaced_by
      )
      UPDATE refresh_tokens SET revoked_at = now()
       WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL
    `;
  }

  /** `POST /api/auth/logout` — solo la sesión actual. */
  async revokeOne(tokenId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * `POST /api/auth/logout-all` y cambio de contraseña (SC-A07). `exceptId`
   * deja viva la sesión actual cuando el cambio de contraseña se dispara
   * desde ella.
   */
  async revokeAllForUser(userId: string, exceptId?: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }

  /** FR-A04 — `count(refresh_tokens WHERE revoked_at IS NULL AND expires_at > now())`. */
  countActiveSessions(userId: string): Promise<number> {
    return this.prisma.refreshToken.count({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private signAccess(payload: AccessPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
      issuer: ISS,
      audience: AUD,
    });
  }

  private signRefresh(payload: RefreshPayload): Promise<string> {
    return this.jwt.signAsync(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshTtlSeconds,
    });
  }

  /** Segundos entre `iat` y `exp` del propio JWT — no se reparsea el TTL a mano. */
  private expiresInOf(token: string): number {
    const decoded = this.jwt.decode<{ iat: number; exp: number }>(token);
    return decoded.exp - decoded.iat;
  }

  private expiryOf(token: string): Date {
    const decoded = this.jwt.decode<{ exp: number }>(token);
    return new Date(decoded.exp * 1000);
  }
}

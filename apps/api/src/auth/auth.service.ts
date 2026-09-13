import {
  ConflictException,
  Injectable,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AUTH_ERROR, type AuthSession, type AuthUser } from '@umlive/contracts';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { ARGON2_PARAMS } from './password.constants.js';
import { TokensService } from './tokens.service.js';

/** Metadatos de la petición que se guardan junto al refresh token. */
interface RequestMeta {
  ip: string;
  userAgent?: string;
}

/** Lo que necesitan `AuthController` y `UsersController` para setear la cookie. */
export interface SessionResult {
  session: AuthSession;
  refreshJwt: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService implements OnModuleInit {
  /**
   * Hash señuelo, precomputado una sola vez con los MISMOS `ARGON2_PARAMS`
   * que los hashes reales. Es la mitad de la defensa de SC-A04 (design.md
   * §2.3): si el usuario no existe, se verifica igual contra este hash en
   * vez de cortar temprano, para que el costo de Argon2id sea el mismo en
   * los dos caminos.
   */
  private decoyHash!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly attempts: LoginAttemptsService,
  ) {}

  async onModuleInit() {
    const randomPassword = randomBytes(32).toString('base64');
    this.decoyHash = await hash(randomPassword, ARGON2_PARAMS);
  }

  /** SC-A01, SC-A02. La unicidad la impone la columna `citext`, no una comparación acá. */
  async register(dto: RegisterDto, meta: RequestMeta): Promise<SessionResult> {
    const passwordHash = await hash(dto.password, ARGON2_PARAMS);

    let user;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          displayName: dto.displayName,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: AUTH_ERROR.EMAIL_TAKEN });
      }
      throw err;
    }

    const issued = await this.tokens.issue(user.id, user.displayName, meta);
    return {
      session: {
        user: this.toAuthUser(user),
        accessToken: issued.accessToken,
        expiresIn: issued.expiresIn,
      },
      refreshJwt: issued.refreshJwt,
      refreshExpiresAt: issued.refreshExpiresAt,
    };
  }

  /**
   * SC-A04. Login inválido — sea cuenta inexistente o contraseña incorrecta —
   * DEBE responder idéntico en cuerpo, código y tiempo (±50 ms). La técnica
   * completa está en design.md §2.3/§2.4; acá lo que importa es la forma del
   * código, no solo el resultado.
   */
  async login(dto: LoginDto, meta: RequestMeta): Promise<SessionResult> {
    const ipKey = this.attempts.ipKey(meta.ip);
    const identifierKey = this.attempts.identifierKey(dto.email);

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // ─────────────────────────────────────────────────────────────────────
    // NO agregar un `if (!user) throw ...` ACÁ. Es el atajo más natural del
    // mundo — "si no hay usuario, ¿para qué seguir?" — y es exactamente el
    // que reabre SC-A04: cortar antes de este punto le ahorra al servidor el
    // costo completo de Argon2id (~decenas de ms) solo cuando la cuenta no
    // existe, y esa diferencia de tiempo ES la fuga. Por eso hay un único
    // `verify`, contra `user?.passwordHash ?? decoyHash` en los dos casos, y
    // los dos caminos terminan en el mismo `throw` de abajo. Si en algún
    // momento hace falta "optimizar" este método, este comentario es la
    // única razón escrita de por qué ese corte no está — no hay test que lo
    // atrape (design.md §2.4).
    // ─────────────────────────────────────────────────────────────────────
    const hashToVerify = user?.passwordHash ?? this.decoyHash;
    const valid = await verify(hashToVerify, dto.password);

    if (!user || !valid) {
      this.attempts.registerFailure(ipKey);
      this.attempts.registerFailure(identifierKey);
      throw new UnauthorizedException({ code: AUTH_ERROR.INVALID_CREDENTIALS });
    }

    // Login correcto: reinicia SOLO la cubeta de identificador (design.md
    // §2.1, tabla) — la de IP sigue viva, porque un acierto de un
    // identificador no dice nada sobre el resto del tráfico de esa IP.
    this.attempts.reset(identifierKey);

    const issued = await this.tokens.issue(user.id, user.displayName, meta);
    return {
      session: {
        user: this.toAuthUser(user),
        accessToken: issued.accessToken,
        expiresIn: issued.expiresIn,
      },
      refreshJwt: issued.refreshJwt,
      refreshExpiresAt: issued.refreshExpiresAt,
    };
  }

  /** SC-A05 / SC-A06. Delegado casi entero a `TokensService.rotate` — ver design.md §4.4. */
  async refresh(refreshJwt: string, meta: RequestMeta) {
    return this.tokens.rotate(refreshJwt, meta);
  }

  /** FR-A03 — solo la sesión actual. */
  logout(sid: string): Promise<void> {
    return this.tokens.revokeOne(sid);
  }

  /** FR-A03 — todas las sesiones vigentes del usuario. */
  logoutAll(userId: string): Promise<void> {
    return this.tokens.revokeAllForUser(userId);
  }

  private toAuthUser(user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    locale: string;
    createdAt: Date;
  }): AuthUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      locale: user.locale,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

import { ForbiddenException, Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { AUTH_ERROR, type AuthUser, type MeResponse } from '@umlive/contracts';
import { ARGON2_PARAMS } from '../auth/password.constants.js';
import { TokensService } from '../auth/tokens.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { UpdateMeDto } from './dto/update-me.dto.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  /** FR-A04 — `activeSessionCount` viene de `refresh_tokens`, no de un contador propio. */
  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const activeSessionCount = await this.tokens.countActiveSessions(userId);
    return { ...this.toAuthUser(user), activeSessionCount };
  }

  /** INV-2 — el DTO ya es la lista blanca; acá no hay nada que decidir de más. */
  async update(userId: string, dto: UpdateMeDto): Promise<AuthUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
        ...(dto.avatarUrl !== undefined ? { avatarUrl: dto.avatarUrl } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
      },
    });
    return this.toAuthUser(user);
  }

  /**
   * SC-A07 / SC-A08. La actual se verifica ANTES de cualquier escritura: si
   * falla, `403` y CERO filas cambian — ni `users` ni `refresh_tokens`
   * (design.md §5). Si pasa, nuevo hash + revocar todo salvo `sid` en una
   * transacción; `sid` es la sesión desde la que se pidió el cambio.
   */
  async changePassword(userId: string, sid: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const currentOk = await verify(user.passwordHash, dto.currentPassword);
    if (!currentOk) {
      throw new ForbiddenException({ code: AUTH_ERROR.WRONG_PASSWORD });
    }

    const newHash = await hash(dto.newPassword, ARGON2_PARAMS);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null, id: { not: sid } },
        data: { revokedAt: new Date() },
      }),
    ]);
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

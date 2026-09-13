import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AuthSession, RefreshResponse } from '@umlive/contracts';
import { AUTH_ERROR } from '@umlive/contracts';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CurrentUser, type CurrentUserPayload } from './current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginThrottleGuard } from './login-throttle.guard';
import { Public } from './public.decorator';

/** Nombre y atributos fijos de la cookie de refresh (design.md §4.3). */
const COOKIE_NAME = 'umlive_rt';

function baseCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // WebKit descarta cookies `Secure` sobre `http://localhost` — condicionar
    // por entorno evita romper el login en desarrollo bajo Safari.
    secure: process.env.NODE_ENV === 'production',
    path: '/api/auth',
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: RegisterDto,
  ): Promise<AuthSession> {
    const result = await this.auth.register(dto, this.metaOf(req));
    this.setRefreshCookie(res, result.refreshJwt, false, result.refreshExpiresAt);
    return result.session;
  }

  /**
   * `LoginThrottleGuard` corre antes que este handler y antes que
   * `AuthService.login` — orden fijo IP → identificador → credencial
   * (design.md §2.1).
   */
  @Public()
  @UseGuards(LoginThrottleGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginDto,
  ): Promise<AuthSession> {
    const result = await this.auth.login(dto, this.metaOf(req));
    this.setRefreshCookie(res, result.refreshJwt, dto.rememberMe ?? false, result.refreshExpiresAt);
    return result.session;
  }

  /** SC-A05 / SC-A06. Sin body: el refresh token viaja solo por cookie. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponse> {
    const presented: string | undefined = req.cookies?.[COOKIE_NAME];
    if (!presented) {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException({ code: AUTH_ERROR.SESSION_EXPIRED });
    }

    const outcome = await this.auth.refresh(presented, this.metaOf(req));
    if (!outcome.ok) {
      // Inválido o replay: en los dos casos la cookie queda muerta del lado
      // del cliente. El replay ya revocó la cadena entera del lado del
      // servidor (TokensService.rotate → revokeChain, SC-A06).
      this.clearRefreshCookie(res);
      throw new UnauthorizedException({ code: AUTH_ERROR.SESSION_EXPIRED });
    }

    // `rememberMe` no viaja en el refresh: se conserva reseteando `maxAge`
    // solo si la cookie entrante ya tenía uno (heurística simple: si el
    // cliente mandó `Cookie` con el flag de persistencia, seguimos igual).
    // Ante la duda, y para no alargar sesiones que el usuario quiso que
    // fueran de pestaña, se emite como cookie de sesión salvo que ya hubiera
    // `maxAge` — Express no expone eso en el request, así que se mantiene la
    // política más simple y explícita: renovar SIEMPRE como cookie de
    // sesión. El límite real de vida sigue siendo `expires_at` en la base.
    this.setRefreshCookie(res, outcome.session.refreshJwt, false, outcome.session.refreshExpiresAt);
    return { accessToken: outcome.session.accessToken, expiresIn: outcome.session.expiresIn };
  }

  /** FR-A03 — revoca solo la sesión actual. */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user.sid);
    this.clearRefreshCookie(res);
  }

  /** FR-A03 — revoca todas las sesiones vigentes del usuario. */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.id);
    this.clearRefreshCookie(res);
  }

  private metaOf(req: Request): { ip: string; userAgent?: string } {
    return { ip: req.ip ?? 'unknown', userAgent: req.headers['user-agent'] };
  }

  private setRefreshCookie(res: Response, token: string, rememberMe: boolean, expiresAt: Date): void {
    res.cookie(COOKIE_NAME, token, {
      ...baseCookieOptions(),
      // Ausente si no hay "Mantener sesión": cookie de sesión, no persistente
      // (design.md §4.3). El vencimiento real en la base es siempre
      // `expires_at`, independiente de este eje.
      ...(rememberMe ? { maxAge: Math.max(0, expiresAt.getTime() - Date.now()) } : {}),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(COOKIE_NAME, baseCookieOptions());
  }
}

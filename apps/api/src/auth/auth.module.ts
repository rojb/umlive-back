import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { JwtStrategy } from './jwt.strategy.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';
import { TokensService } from './tokens.service.js';

/**
 * `JwtAuthGuard` y `@CurrentUser()` se exportan para que las rebanadas
 * siguientes (M2..M7) puedan proteger sus propios endpoints sin reimportar
 * la lógica de sesión (design.md §5).
 */
@Module({
  imports: [PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokensService,
    LoginAttemptsService,
    LoginThrottleGuard,
    JwtStrategy,
    JwtAuthGuard,
  ],
  exports: [JwtAuthGuard, TokensService, LoginAttemptsService],
})
export class AuthModule {}

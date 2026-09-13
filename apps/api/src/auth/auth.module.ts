import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { LoginAttemptsService } from './login-attempts.service';
import { LoginThrottleGuard } from './login-throttle.guard';
import { TokensService } from './tokens.service';

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

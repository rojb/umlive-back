import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { LoginAttemptsService } from './login-attempts.service';
import { LoginThrottleGuard } from './login-throttle.guard';
import { SocketAuthService } from './socket-auth.service';
import { TokensService } from './tokens.service';

/**
 * `JwtAuthGuard` y `@CurrentUser()` se exportan para que las rebanadas
 * siguientes (M2..M7) puedan proteger sus propios endpoints sin reimportar
 * la lógica de sesión (design.md §5).
 *
 * `SocketAuthService` (collaboration-gateway/design.md §D4) se agrega y
 * exporta para que `CollaborationGateway` verifique el access token del
 * handshake sin reimplementar la verificación.
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
    SocketAuthService,
  ],
  exports: [JwtAuthGuard, TokensService, LoginAttemptsService, SocketAuthService],
})
export class AuthModule {}

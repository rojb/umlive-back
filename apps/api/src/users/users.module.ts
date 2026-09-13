import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Depende de `AuthModule` por `TokensService` (conteo de sesiones activas y
 * revocación en el cambio de contraseña) — no se duplica esa lógica acá.
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}

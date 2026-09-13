import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

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

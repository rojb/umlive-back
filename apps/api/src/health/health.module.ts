import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * `PrismaModule` es `@Global`, así que `PrismaService` se inyecta sin importarlo.
 * Sin providers propios: el controlador solo consulta la base.
 */
@Module({ controllers: [HealthController] })
export class HealthModule {}

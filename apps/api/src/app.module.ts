import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { fileURLToPath } from 'node:url';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { UsersModule } from './users/users.module.js';

/**
 * Estructura por módulos de funcionalidad — la que documenta NestJS.
 * Sin capas domain/application/infrastructure, sin puertos y adaptadores,
 * sin clases de caso de uso (PRD §9, excluido por restricción).
 *
 * Los módulos se van descomentando a medida que se implementan, en el orden
 * de hitos de PRD §10.
 */

/**
 * Anclado a este archivo, no a `process.cwd()`: el `.env` vive en `apps/api/`
 * y se debe encontrar igual arranque desde donde arranque. Compilado queda en
 * `dist/app.module.js`, así que `../.env` es `apps/api/.env`.
 */
const envFilePath = fileURLToPath(new URL('../.env', import.meta.url));

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath }),
    PrismaModule,
    AuthModule,
    UsersModule,
    // M1  ProjectsModule, DiagramsModule
    // M3  CollaborationModule
    // M5  InteropModule, CodegenModule
    // M6  AiModule
  ],
  providers: [
    // Guard de autenticación global (design.md §5): toda ruta requiere sesión
    // válida salvo la decorada con `@Public()`. Un endpoint nuevo sin
    // decorador queda protegido por defecto, no expuesto.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { fileURLToPath } from 'node:url';
import { PrismaModule } from './prisma/prisma.module.js';

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
    // M1  AuthModule, UsersModule, ProjectsModule, DiagramsModule
    // M3  CollaborationModule
    // M5  InteropModule, CodegenModule
    // M6  AiModule
  ],
})
export class AppModule {}

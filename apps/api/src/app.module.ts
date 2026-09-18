import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'node:path';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { CollaborationModule } from './collaboration/collaboration.module';
import { JoinCodesModule } from './join-codes/join-codes.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectAccessGuard } from './projects/guards/project-access.guard';
import { ProjectsModule } from './projects/projects.module';
import { UmlModule } from './uml/uml.module';
import { UsersModule } from './users/users.module';

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
const envFilePath = join(__dirname, '..', '.env');

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    JoinCodesModule,
    // M2 — contrato + cimientos (uml-classifiers, fase 1+2). Sin rutas
    // todavía: fase 3/4 registra los controllers dentro de este módulo.
    UmlModule,
    // M3 — transporte WebSocket, gate de membresía, snapshot v0
    // (collaboration-gateway, rebanada 1 de 4).
    CollaborationModule,
    // M5  InteropModule, CodegenModule
    // M6  AiModule
  ],
  providers: [
    // Guard de autenticación global (design.md §5): toda ruta requiere sesión
    // válida salvo la decorada con `@Public()`. Un endpoint nuevo sin
    // decorador queda protegido por defecto, no expuesto.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Segundo APP_GUARD, DESPUÉS de JwtAuthGuard — orden obligatorio (design.md
    // §2.2, tasks.md 2.3). Nest ejecuta los guards globales en el orden en que
    // aparecen en este arreglo. Si ProjectAccessGuard quedara antes,
    // `req.user` todavía no existiría cuando intenta resolver la membresía
    // del solicitante contra `project_members`, y reventaría en TODA ruta de
    // proyecto, autenticada o no. Con JwtAuthGuard primero, cuando
    // ProjectAccessGuard corre, `req.user` ya está poblado (o la petición ya
    // fue rechazada con 401 antes de llegar acá).
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
export class AppModule {}

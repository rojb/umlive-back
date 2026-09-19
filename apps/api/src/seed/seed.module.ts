import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { InteropModule } from '../interop/interop.module';
import { XmiImportService } from '../interop/xmi-import.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SeedBlocksService } from './seed-blocks';

/**
 * Contexto de Nest mínimo para el seed — `seed-data-and-demo-script` D1.
 *
 * **No es `AppModule`.** `createApplicationContext(AppModule)` instanciaría el
 * gateway, el barrido de locks, `AI_ENV` y la redención de códigos; esta última
 * exige `AUTH_THROTTLE_PEPPER` (`redemption-attempts.service.ts`), así que el
 * seed pediría secretos que no usa. Este módulo replica solo lo que `AppModule`
 * hace global (`ConfigModule` + `PrismaModule`) y suma `InteropModule`:
 *
 *   ConfigModule.forRoot({ isGlobal, envFilePath })  →  process.env + ConfigService
 *   PrismaModule  (@Global)                          →  PrismaService
 *   InteropModule                                    →  admisión + import de XMI
 *
 * `XmiImportService` NO está exportado por `InteropModule` (la interfaz no lo
 * necesita fuera del módulo), así que se registra acá como proveedor propio.
 * Sus dos dependencias —`PrismaService` (global) y `XmiAdmissionService`
 * (exportado por `InteropModule`)— se resuelven igual. Si faltara alguna, Nest
 * falla al arrancar, que es justo lo que se quiere.
 *
 * Queda en `src/seed/`, así que `nest build` lo emite en `dist/seed/`
 * (`nest-cli.json`). `__dirname` en runtime es `dist/seed`, de ahí los dos `..`
 * hasta `apps/api/.env`.
 */
const envFilePath = join(__dirname, '..', '..', '.env');

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath }), PrismaModule, InteropModule],
  providers: [SeedBlocksService, XmiImportService],
})
export class SeedModule {}

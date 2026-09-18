import { Module } from '@nestjs/common';
import { UmlModule } from '../uml/uml.module';
import { CodegenController } from './codegen.controller';
import { CodegenService } from './codegen.service';

/**
 * M5 — Generación de código (rebanada 3/4, tarea 2.9). Estructura por defecto de
 * NestJS (PRD §9): controller + service + funciones puras. Sin hexagonal, sin
 * puertos ni adaptadores, sin clases de caso de uso.
 *
 * `imports: [UmlModule]` es el único acoplamiento: `CodegenService` inyecta
 * `ValidationService` (la compuerta, D1) y `DiagramContentService` (la lectura,
 * D1), los dos exportados por `UmlModule`. `PrismaService` NO se importa acá
 * porque `PrismaModule` es `@Global()`.
 *
 * Lo que NO está acá, y por qué: los emisores (`emitters/*`), el ZIP (`zip.ts`) y
 * `build-ir.ts` son funciones puras —no son providers y no necesitan serlo—. Eso
 * es deliberado y es la forma más barata de que sigan siendo puras: nada que no
 * esté inyectado puede leer el reloj, el azar o el locale.
 */
@Module({
  imports: [UmlModule],
  controllers: [CodegenController],
  providers: [CodegenService],
})
export class CodegenModule {}

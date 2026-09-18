import { Module } from '@nestjs/common';
import { UmlModule } from '../uml/uml.module';
import { XmiExportController } from './xmi-export.controller';
import { XmiExportService } from './xmi-export.service';
import { XsdValidatorService } from './xsd-validator.service';

/**
 * M5 — Intercambio XMI (rebanada 1 de 4, Unidad 1). Estructura por defecto de
 * NestJS (PRD §9): controller + services + funciones puras. Sin hexagonal, sin
 * puertos ni adaptadores, sin clases de caso de uso.
 *
 * `imports: [UmlModule]` es el único acoplamiento: `XmiExportService` inyecta
 * `DiagramContentService`, que `UmlModule` exporta. `PrismaService` NO se
 * importa acá porque `PrismaModule` es `@Global()`.
 *
 * Lo que todavía NO está en este módulo, y por qué (queda para las otras
 * unidades de la rebanada): el bloque de extensión EA (`ea-extension.ts`),
 * los XSD vendorizados bajo `src/interop/xsd/` y `XsdValidatorService`
 * (Unidad 3, D6/D7). Hasta entonces el reporte declara
 * `eaExtensionIncluded: false` — un hecho sobre los bytes, no sobre lo pedido
 * — y la compuerta G1 es la única activa.
 *
 * ── Unidad 3 (tareas 3.1–3.6) ─────────────────────────────────────────────
 * Lo de arriba ya NO vale: la extensión EA vive en `ea-extension.ts`, los
 * XSD en `src/interop/xsd/` (con el glob de `assets` de `nest-cli.json`,
 * D7/Trampa de empaquetado) y `XsdValidatorService` (G2, fail-closed) es
 * provider de ESTE módulo. `XmiExportService` lo inyecta y corre G2 al final
 * del pipeline, después de G1.
 */
@Module({
  imports: [UmlModule],
  controllers: [XmiExportController],
  providers: [XmiExportService, XsdValidatorService],
  exports: [XmiExportService],
})
export class InteropModule {}

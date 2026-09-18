import { Module } from '@nestjs/common';
import { UmlModule } from '../uml/uml.module';
import { XmiAdmissionService } from './xmi-admission';
import { XmiExportController } from './xmi-export.controller';
import { XmiExportService } from './xmi-export.service';
import { XmiImportController } from './xmi-import.controller';
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
 *
 * ── `xmi-import` (M5, rebanada 2 de 4 — Fase 1, tarea 1.7) ────────────────
 * `XmiAdmissionService` es el nivel A de la admisión (tamaño, prólogo,
 * `windows-1252`, buena formación, namespace por URI) y el lugar del log al
 * arranque de la sonda de decodificación (D4). `XmiImportController` entra ya
 * registrado pero **sin rutas**: las cuatro de §3 las agrega la Fase 4. El
 * lector (`xmi-reader.ts`), el lector de la extensión EA
 * (`ea-extension-reader.ts`) y el auto-layout (`auto-layout.ts`) son funciones
 * puras: no son providers y no necesitan estar acá.
 */
@Module({
  imports: [UmlModule],
  controllers: [XmiExportController, XmiImportController],
  providers: [XmiExportService, XsdValidatorService, XmiAdmissionService],
  exports: [XmiExportService, XmiAdmissionService],
})
export class InteropModule {}

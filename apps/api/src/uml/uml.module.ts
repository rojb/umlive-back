import { Module } from '@nestjs/common';

/**
 * Esqueleto (design.md §12, tasks.md 2.4). Esta unidad de trabajo (fase 1+2
 * de `uml-classifiers`) es contrato compartido + cimientos de backend
 * (`resolveUniqueViolation`, los cuatro helpers de aislamiento) — sin rutas
 * nuevas todavía. Fase 3/4 registra acá los cuatro pares controller/service:
 * `DiagramContentController/Service`, `ElementsController/Service`,
 * `FeaturesController/Service`, `ParametersController/Service`.
 */
@Module({})
export class UmlModule {}

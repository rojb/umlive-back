import { Module } from '@nestjs/common';
import { DiagramContentController } from './diagram-content.controller';
import { DiagramContentService } from './diagram-content.service';
import { ElementsController } from './elements.controller';
import { ElementsService } from './elements.service';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';
import { ParametersController } from './parameters.controller';
import { ParametersService } from './parameters.service';
import { RelationshipsController } from './relationships.controller';
import { RelationshipsService } from './relationships.service';

/**
 * Los cuatro pares controller/service de `uml-classifiers` (design.md §1,
 * §12; tasks.md 3.4, 4.5): `DiagramContentController/Service` (lectura, §8),
 * `ElementsController/Service`, `FeaturesController/Service`,
 * `ParametersController/Service` (parámetros + literales de enum). Sin
 * providers propios de guard — `ProjectAccessGuard` es `APP_GUARD` global
 * (`app.module.ts`) y `PrismaService` viene de `PrismaModule`, que es
 * `@Global()`.
 *
 * `RelationshipsController/Service` agregado por `uml-relationships`
 * (design.md §5; tasks.md 2.10) — quinto par, mismo criterio, sin provider
 * propio.
 */
@Module({
  controllers: [DiagramContentController, ElementsController, FeaturesController, ParametersController, RelationshipsController],
  providers: [DiagramContentService, ElementsService, FeaturesService, ParametersService, RelationshipsService],
})
export class UmlModule {}

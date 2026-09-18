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
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';

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
 *
 * `ValidationController/Service` agregado por `uml-validation` (design.md §1,
 * D6; tasks.md 2.5) — sexto par, capa de lectura consultiva de FR-B14.
 *
 * `DiagramContentService` se exporta (collaboration-gateway/design.md §D8):
 * `CollaborationGateway` lo reusa para el snapshot `version = 0` al vuelo, sin
 * inyectar `PrismaService` — es su única fuente de estado de diagrama, y ya
 * devuelve datos mapeados (sin `BigInt`).
 *
 * Los cuatro services de mutación (`ElementsService`, `RelationshipsService`,
 * `FeaturesService`, `ParametersService`) se exportan además
 * (`operations-pipeline/design.md` §5, contradicción #7 de la propuesta):
 * `CollaborationModule` los necesita para el `OperationDispatcher`, que solo
 * llama a sus variantes `…In(tx)` — nunca a las funciones públicas.
 */
@Module({
  controllers: [DiagramContentController, ElementsController, FeaturesController, ParametersController, RelationshipsController, ValidationController],
  providers: [DiagramContentService, ElementsService, FeaturesService, ParametersService, RelationshipsService, ValidationService],
  exports: [DiagramContentService, ElementsService, FeaturesService, ParametersService, RelationshipsService],
})
export class UmlModule {}

import { Module } from '@nestjs/common';
import { DiagramContentController } from './diagram-content.controller';
import { DiagramContentService } from './diagram-content.service';
import { ElementsService } from './elements.service';
import { FeaturesService } from './features.service';
import { ParametersService } from './parameters.service';
import { RelationshipsService } from './relationships.service';
import { ValidationController } from './validation.controller';
import { ValidationService } from './validation.service';

/**
 * Módulo del modelo UML. Tras `frontend-cutover` Fase 4 (tarea 4.2, D1)
 * conserva SOLO los controllers de lectura: `DiagramContentController`
 * (`@Get :diagramId`, §8) y `ValidationController` (`@Get .../validation`,
 * `uml-validation` D6). Los cuatro controllers de mutación de
 * `uml-classifiers`/`uml-relationships`/`uml-validation`/`association-class`
 * se borraron enteros. Los services de mutación siguen registrados porque el
 * `OperationDispatcher` los inyecta.
 *
 * Sin providers propios de guard — `ProjectAccessGuard` es `APP_GUARD` global
 * (`app.module.ts`) y `PrismaService` viene de `PrismaModule`, que es
 * `@Global()`.
 *
 * **Nota fechada 2026-09-18 (`frontend-cutover`, tarea 4.3, D1).** El array
 * `controllers` queda con **DOS** entradas, no una: `DiagramContentController`
 * (único `@Get` de la familia del contenido, D4-bis) y `ValidationController`
 * (la `@Get .../validation` que agregó `uml-validation` en M2, después de que
 * `frontend-cutover/design.md` §D1 se escribiera). Los cuatro controllers de
 * mutación (`Elements`, `Relationships`, `Features`, `Parameters`) se
 * borraron ENTEROS en la tarea 4.2 — no se vaciaron, para no dejar el lugar
 * donde un refactor futuro volviera a colgar un `@Patch`. Los cuatro services
 * siguen registrados como `providers`/`exports` porque `CollaborationModule`
 * los inyecta para el `OperationDispatcher`, que solo llama a sus variantes
 * `…In(tx)`.
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
  controllers: [DiagramContentController, ValidationController],
  providers: [DiagramContentService, ElementsService, FeaturesService, ParametersService, RelationshipsService, ValidationService],
  exports: [DiagramContentService, ElementsService, FeaturesService, ParametersService, RelationshipsService],
})
export class UmlModule {}

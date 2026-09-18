import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { DiagramsService } from '../projects/diagrams.service';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { CollaborationGateway } from './collaboration.gateway';
import { LocksService } from './locks.service';

/**
 * Borrar un diagrama y desalojar a los que están adentro — (`concurrency-ux`
 * D9). Es el equivalente de `member-removal.controller.ts` sobre un diagrama
 * en vez de sobre una persona, y por eso vive en el mismo módulo: necesita el
 * gateway y la compuerta de locks, que están acá, y mudar la ruta evita el
 * ciclo `Projects ↔ Collaboration` (mismo movimiento que D1 de
 * `diagram-freeze`). El `@Delete` de `projects/diagrams.controller.ts` se
 * sacó: dos handlers para la misma URL dejarían uno muerto en silencio.
 *
 * **Hallazgo, no en la propuesta original**: `DiagramsService.softDelete` no
 * avisaba a nadie por socket y el pipeline de operaciones no mira
 * `deletedAt`. Quien estaba adentro seguía viendo —y, sin congelado,
 * editando— un diagrama borrado hasta reconectarse; en uno congelado, el
 * cartel quedaba para siempre. Recién al reconectar el handshake respondía
 * `diagram_not_found`.
 *
 * Orden EXACTO del handler, y los tres pasos son un contrato:
 *   1. `softDelete` (la transacción: `deletedAt` + revocación de los códigos
 *      de acceso del diagrama);
 *   2. `evictDiagram` — todos los sockets unidos a ese diagrama, con motivo
 *      `'diagram_deleted'`, en un solo bloque síncrono;
 *   3. `forgetDiagram` — los locks y la compuerta de congelado, sin emitir
 *      (la sala ya está vacía).
 *
 * Mismos `403`/`404` de antes: la acción de autorización es la misma
 * (`diagram.delete`, solo HOST) y `ProjectAccessGuard` es `APP_GUARD`, así que
 * lee la metadata de cualquier controlador. `projectId` no se usa en el
 * cuerpo: existe para que el guard resuelva la membresía (`:diagramId` solo no
 * alcanza) y porque `ParseUUIDPipe` es la segunda barrera del uuid.
 */
@Controller('projects/:projectId/diagrams')
export class DiagramDeletionController {
  constructor(
    private readonly diagrams: DiagramsService,
    private readonly gateway: CollaborationGateway,
    private readonly locks: LocksService,
  ) {}

  @Delete(':diagramId')
  @RequiresProjectAction('diagram.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('projectId', ParseUUIDPipe) _projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
  ): Promise<void> {
    await this.diagrams.softDelete(diagramId);
    // Síncronos los dos: no hay un punto de suspensión entre la transacción
    // confirmada y el desalojo (D8), así que nadie puede tomar un lock en el
    // medio y sobrevivir al borrado.
    this.gateway.evictDiagram(diagramId);
    this.locks.forgetDiagram(diagramId);
  }
}

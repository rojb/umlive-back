import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { DiagramSummary } from '@umlive/contracts';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { DiagramFreezeService } from './diagram-freeze.service';

/**
 * Interruptor de congelado — dos rutas REST, solo host (`diagram-freeze` D1).
 *
 * **Vive en `collaboration/` y no en `projects/diagrams.controller.ts`**, que
 * es lo que decía la propuesta: `CollaborationModule` ya importa
 * `ProjectsModule` (por `ProjectAccessResolver`), así que con las rutas allá
 * `ProjectsModule` tendría que importar `CollaborationModule` para llegar a
 * `LocksService` y al gateway — un CICLO de módulos, que en NestJS suele
 * esconderse con `forwardRef` en vez de resolverse. Acá la dependencia sigue
 * yendo en un solo sentido (Collaboration → Projects). `ProjectAccessGuard` es
 * `APP_GUARD` y lee la metadata de cualquier controlador, así que la
 * autorización no cambia; `@RequiresProjectAction` se importa como archivo, no
 * como módulo.
 *
 * REST y no WebSocket por tres razones (propuesta, Scope): SC-C21 pide un
 * `403` y `ProjectAccessGuard` ya lo resuelve; la matriz FR-A13 la lee ese
 * guard; y la fila de B1 congela sin tener socket (un socket sirve un solo
 * diagrama).
 *
 * `POST` responde `200` y no `201`: no crea nada — es un cambio de estado de
 * acceso. `DELETE` responde `200` por la misma razón (devuelve el
 * `DiagramSummary` que la fila necesita para actualizarse).
 */
@Controller('projects/:projectId/diagrams/:diagramId/freeze')
export class DiagramFreezeController {
  constructor(private readonly freezeService: DiagramFreezeService) {}

  /**
   * `projectId` no se usa en el cuerpo: existe para que la ruta tenga el
   * alcance que `ProjectAccessGuard` necesita (`:diagramId` solo no alcanza
   * para resolver membresía) y para que `ParseUUIDPipe` sea la segunda barrera
   * del uuid. El diagrama siempre se direcciona por `:diagramId`.
   */
  @Post()
  @RequiresProjectAction('diagram.lock')
  @HttpCode(HttpStatus.OK)
  freeze(
    @Param('projectId', ParseUUIDPipe) _projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DiagramSummary> {
    return this.freezeService.freeze(diagramId, user);
  }

  @Delete()
  @RequiresProjectAction('diagram.unlock')
  @HttpCode(HttpStatus.OK)
  unfreeze(
    @Param('projectId', ParseUUIDPipe) _projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<DiagramSummary> {
    return this.freezeService.unfreeze(diagramId, user);
  }
}

import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { DiagramContent } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { DiagramContentService } from './diagram-content.service';

/**
 * Mismo prefijo que `DiagramsController` (`projects/`), en otro módulo
 * (design.md §8, desviación deliberada respecto de la propuesta):
 * `DiagramsService` es ciclo de vida (crear/renombrar/borrar suave); el
 * contenido es el modelo UML. NestJS admite dos controllers con el mismo
 * prefijo mientras no colisionen método+ruta — `GET :diagramId` no colisiona
 * con el `POST`/`PATCH`/`DELETE` ya existentes en `DiagramsController`.
 *
 * **Nota fechada 2026-09-18 (`frontend-cutover`, tarea 4.2, D4-bis).** Este
 * es el ÚNICO `@Get` de `apps/api/src/uml/` y **queda intacto** tras el
 * borrado de las 33 rutas de mutación (los cuatro controllers enteros de
 * `elements`/`relationships`/`features`/`parameters`). Se queda por dos
 * motivos: (a) es una LECTURA — no consume versión, no escribe log, no
 * puede divergir, así que el argumento de INV-1 (HTTP no pasa por el
 * `FOR UPDATE`) no la alcanza; (b) el pipeline y el snapshot de
 * `diagram:sync` usan `DiagramContentService.getDiagramContent` por dentro,
 * y borrar la RUTA no borraría ese código.
 *
 * Contrapartida honesta (D4-bis): tras el cutover esta ruta tiene **cero
 * llamadores en el producto** — el lienzo dejó de llamarla en la Fase 3
 * (tarea 2.8) porque `getContent` no devuelve versión y un estado sin número
 * de versión no se puede reconciliar con operaciones que sí lo tienen. Se
 * conserva por un uso real y no decorativo: en un proyecto sin runner de
 * tests, `curl` a esta ruta es el instrumento para comparar el estado
 * autoritativo contra lo que el lienzo dibuja. **Si sigue sin llamador al
 * cerrar M4, es candidata a borrarse.**
 */
@Controller('projects/:projectId/diagrams')
export class DiagramContentController {
  constructor(private readonly content: DiagramContentService) {}

  @Get(':diagramId')
  @RequiresProjectAction('diagram.view')
  get(@Param('diagramId', ParseUUIDPipe) diagramId: string): Promise<DiagramContent> {
    return this.content.getDiagramContent(diagramId);
  }
}

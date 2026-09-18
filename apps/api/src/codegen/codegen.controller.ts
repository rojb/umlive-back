import { Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { CodegenResponse } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { CodegenService } from './codegen.service';

/**
 * La ruta de generación (tarea 2.9, D10):
 * `POST /projects/:projectId/diagrams/:diagramId/codegen`.
 *
 * **`POST` y no un `GET` de descarga**: mismo motivo que en el exportador XMI —
 * una generación bloqueada tiene que fallar con el `422` estructurado y no se
 * entrega ningún archivo, cosa que un `Content-Disposition: attachment` no puede
 * hacer.
 *
 * `@RequiresProjectAction('export.run')`: la fila ya nombraba la generación de
 * código y es la única acción permitida a `HOST` y `PARTICIPANT`. Sin el
 * decorador el guard responde `403` y lo loguea (fail-closed).
 *
 * `ParseUUIDPipe` sobre `diagramId`: un id que no es UUID es un `400` de petición
 * y nunca llega a la base. El segmento `:projectId` **no** se declara como
 * parámetro: `ProjectAccessGuard` ya lo lee del `req` para resolver la membresía,
 * y el generador opera sobre UN diagrama, nunca sobre el proyecto entero.
 *
 * `200` explícito: el default de Nest para `POST` es `201` y acá no se creó
 * ningún recurso — el ZIP se arma en memoria y no se persiste.
 */
@Controller('projects/:projectId')
export class CodegenController {
  constructor(private readonly codegen: CodegenService) {}

  @Post('diagrams/:diagramId/codegen')
  @RequiresProjectAction('export.run')
  @HttpCode(HttpStatus.OK)
  generate(@Param('diagramId', ParseUUIDPipe) diagramId: string): Promise<CodegenResponse> {
    return this.codegen.generate(diagramId);
  }
}

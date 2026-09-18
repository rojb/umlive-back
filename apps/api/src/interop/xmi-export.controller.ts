import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { XmiExportRequest, XmiExportResponse, XmiVersion } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { XmiExportService } from './xmi-export.service';

/**
 * Cuerpo de las dos rutas de export (design.md §3). `version` es la única
 * lista blanca de valores: un `'2.0'` es un `400` de petición, no un `500`
 * silencioso. Sin `projectId`/`diagramId` — el objetivo viaja en la URL.
 */
export class XmiExportDto implements XmiExportRequest {
  @IsOptional()
  @IsIn(['2.1', '2.5.1'])
  version?: XmiVersion;

  @IsOptional()
  @IsBoolean()
  includeEaExtension?: boolean;
}

/**
 * Las dos rutas del exportador (design.md §3). **`POST` y no un `GET` de
 * descarga**: FR-E04 exige que un export que no valida FALLE con los errores
 * estructurados y no se entregue, y un `Content-Disposition: attachment` no
 * puede llevar un fallo; además las opciones viajan en el cuerpo sin ensuciar
 * la URL.
 *
 * Las dos llevan `@RequiresProjectAction('export.run')` y `ParseUUIDPipe`.
 * Esto le da a `export.run` su PRIMER llamador: hasta hoy era una fila
 * declarada de `PROJECT_PERMISSIONS` que ninguna ruta ejercía. El guard es
 * fail-closed — una ruta de proyecto sin el decorador responde `403` y loguea
 * `ruta de proyecto sin acción declarada`.
 *
 * `200` explícito: el default de Nest para `POST` es `201`, y acá no se creó
 * ningún recurso.
 */
@Controller('projects/:projectId')
export class XmiExportController {
  constructor(private readonly xmi: XmiExportService) {}

  @Post('diagrams/:diagramId/export/xmi')
  @RequiresProjectAction('export.run')
  @HttpCode(HttpStatus.OK)
  exportDiagram(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Body() dto: XmiExportDto,
  ): Promise<XmiExportResponse> {
    return this.xmi.export(projectId, diagramId, dto);
  }

  @Post('export/xmi')
  @RequiresProjectAction('export.run')
  @HttpCode(HttpStatus.OK)
  exportProject(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: XmiExportDto,
  ): Promise<XmiExportResponse> {
    return this.xmi.export(projectId, undefined, dto);
  }
}

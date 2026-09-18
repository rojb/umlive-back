import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterModuleOptions } from '@nestjs/platform-express';
import { IsString, Length, Matches } from 'class-validator';
import { XMI_IMPORT_ERROR, XMI_MAX_IMPORT_BYTES, type XmiImportPreview, type XmiImportResult } from '@umlive/contracts';
import multer from 'multer';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { XmiImportService } from './xmi-import.service';

/**
 * Las cuatro rutas del import (Fase 4, tarea 4.5) sobre dos métodos del
 * servicio — `preview` y `confirm` — y **dos modos de destino** (D10):
 *
 *   POST projects/:projectId/import/xmi/preview                  → 200 XmiImportPreview · diagrama NUEVO
 *   POST projects/:projectId/import/xmi/confirm                  → 201 XmiImportResult  · diagrama NUEVO (default de C5)
 *   POST projects/:projectId/diagrams/:diagramId/import/xmi/preview   → 200 · diagrama EXISTENTE
 *   POST projects/:projectId/diagrams/:diagramId/import/xmi/confirm   → 201 · diagrama EXISTENTE
 *
 * **La compuerta `[0]` de FR-E06 vive acá y en ningún otro lado.** Sin
 * `limits.fileSize` explícito, `multer@2.2.0` **no tiene tope propio**: un
 * `POST` de 3 GB se carga entero en memoria del proceso antes de que corra una
 * sola línea nuestra. `files: 1` cierra la variante de mandar cincuenta
 * archivos de 49 MB. Ninguno de los dos defaults lo trae Express ni Nest.
 *
 * **El `413` se traduce.** Nest convierte `LIMIT_FILE_SIZE` en
 * `PayloadTooLargeException` con el mensaje CRUDO de multer
 * (`File too large`). Un `413` que no dice cuál es el límite es un `413` que se
 * depura leyendo `node_modules`; el filtro de acá devuelve
 * `413 { code: 'file_too_large', limitBytes }`, que es lo que el modal muestra.
 *
 * **`@RequiresProjectAction('xmi.import')` en las CUATRO.** `xmi.import` es
 * HOST-only (`contracts/src/projects.ts:98`), a diferencia de `export.run`: es
 * el primer consumidor de esta fila de la tabla. Sin el decorador el guard
 * responde `403` y loguea el handler — el olvido cierra, nunca abre. **El rol
 * se evalúa antes que el estado del diagrama**: un PARTICIPANT sobre un
 * diagrama congelado recibe `403` y nunca `423` (D10).
 *
 * **`preview` responde `200` y `confirm` `201`**: el preview no crea nada (y el
 * default de Nest para `POST` es `201`), el confirm sí.
 */

/** Límites de subida (D3). El número sale del contrato: tres consumidores dicen el mismo. */
export const XMI_UPLOAD_LIMITS = { fileSize: XMI_MAX_IMPORT_BYTES, files: 1 } as const;

/** Opciones de multer del import. Una sola instancia, para que el tope no se pueda omitir por ruta. */
export const XMI_MULTER_OPTIONS: MulterModuleOptions = {
  storage: multer.memoryStorage(),
  limits: { ...XMI_UPLOAD_LIMITS },
};

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Traduce el `PayloadTooLargeException` que Nest produce a partir del
 * `LIMIT_FILE_SIZE` de multer. Acotado al controlador: en un controlador que
 * solo recibe `multipart`, la única fuente de un `413` es el tope del archivo.
 */
@Catch(PayloadTooLargeException)
export class XmiFileTooLargeFilter implements ExceptionFilter {
  private readonly logger = new Logger(XmiFileTooLargeFilter.name);

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    this.logger.warn(`subida rechazada por tamaño: el tope es ${XMI_MAX_IMPORT_BYTES} bytes`);
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.status(413).json({
      code: XMI_IMPORT_ERROR.FILE_TOO_LARGE,
      limitBytes: XMI_MAX_IMPORT_BYTES,
      message: `El archivo supera el límite de ${Math.floor(XMI_MAX_IMPORT_BYTES / (1024 * 1024))} MB por importación.`,
    });
  }
}

/**
 * Los campos de texto viajan en el MISMO `multipart` que el archivo, así que
 * multer los deja en `req.body` como strings y los valida el `ValidationPipe`
 * global. El `contentDigest` es el `sha256` hex del preview (D5).
 */
export class XmiConfirmDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'contentDigest tiene que ser el sha256 hex de 64 caracteres que devolvió el preview' })
  contentDigest!: string;
}

/** Modo `'new'`: el nombre del diagrama destino es obligatorio — es lo único que el usuario edita en C5. */
export class XmiConfirmNewDto extends XmiConfirmDto {
  @IsString()
  @Length(1, 120)
  diagramName!: string;
}

/** Sin archivo no hay import: `400`, no un `500` a mitad del pipeline. */
function requireBuffer(file: Express.Multer.File | undefined): Buffer {
  if (file === undefined || file.buffer === undefined) {
    throw new BadRequestException({ message: 'la petición no trae el archivo «file» (multipart/form-data, campo «file»)' });
  }
  return file.buffer;
}

function originalName(file: Express.Multer.File | undefined): string {
  return file?.originalname ?? 'modelo.xmi';
}

@Controller('projects/:projectId')
@UseInterceptors(FileInterceptor('file', XMI_MULTER_OPTIONS))
@UseFilters(XmiFileTooLargeFilter)
export class XmiImportController {
  constructor(private readonly xmi: XmiImportService) {}

  /** Modo nuevo, preview: admisión → lectura → pre-vuelo. Sin base, sin filas. */
  @Post('import/xmi/preview')
  @RequiresProjectAction('xmi.import')
  @HttpCode(HttpStatus.OK)
  previewNew(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<XmiImportPreview> {
    return this.xmi.preview(requireBuffer(file), { projectId, diagramId: null, sourceFilename: originalName(file) });
  }

  /** Modo nuevo, confirm: el diagrama destino se crea dentro de la transacción (D10). */
  @Post('import/xmi/confirm')
  @RequiresProjectAction('xmi.import')
  confirmNew(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: XmiConfirmNewDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<XmiImportResult> {
    return this.xmi.confirm(requireBuffer(file), {
      projectId,
      diagramId: null,
      sourceFilename: originalName(file),
      contentDigest: dto.contentDigest,
      diagramName: dto.diagramName,
      actorId: user.id,
    });
  }

  /** Modo existente, preview. El `diagramId` lo resuelve el guard, igual que en el confirm. */
  @Post('diagrams/:diagramId/import/xmi/preview')
  @RequiresProjectAction('xmi.import')
  @HttpCode(HttpStatus.OK)
  previewExisting(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<XmiImportPreview> {
    return this.xmi.preview(requireBuffer(file), { projectId, diagramId, sourceFilename: originalName(file) });
  }

  /**
   * Modo existente, confirm. Es donde viven el `423 diagram_frozen`, el
   * `409 xmi_id_already_present` y el `409 target_changed` (D10). El servicio
   * RELEE el `lockState` dentro de la transacción en vez de confiar en el que
   * el guard dejó en `request.projectContext`: entre el guard y el `BEGIN` el
   * host pudo congelar, y ese es justo el caso que D11 exige detectar.
   */
  @Post('diagrams/:diagramId/import/xmi/confirm')
  @RequiresProjectAction('xmi.import')
  confirmExisting(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Body() dto: XmiConfirmDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<XmiImportResult> {
    return this.xmi.confirm(requireBuffer(file), {
      projectId,
      diagramId,
      sourceFilename: originalName(file),
      contentDigest: dto.contentDigest,
      diagramName: null,
      actorId: user.id,
    });
  }
}

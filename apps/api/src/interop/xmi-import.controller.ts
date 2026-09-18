import {
  Catch,
  Controller,
  Logger,
  PayloadTooLargeException,
  UseFilters,
  UseInterceptors,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterModuleOptions } from '@nestjs/platform-express';
import { XMI_IMPORT_ERROR, XMI_MAX_IMPORT_BYTES } from '@umlive/contracts';
import multer from 'multer';

/**
 * Esqueleto del controlador de importación (Fase 1, tarea 1.5).
 *
 * **La compuerta `[0]` de FR-E06 vive acá y en ningún otro lado.** Sin
 * `limits.fileSize` explícito, `multer@2.2.0` **no tiene tope propio**: un
 * `POST` de 3 GB se carga entero en memoria del proceso antes de que corra una
 * sola línea nuestra. `files: 1` cierra la variante de mandar cincuenta
 * archivos de 49 MB. Ninguno de los dos defaults lo trae Express ni Nest.
 *
 * **`memoryStorage()` es explícito aunque sea el default de multer**: el lector
 * necesita el `Buffer` completo (D-config: parseo en memoria por exigencia de
 * SC-E06), y dejarlo implícito es exactamente cómo nació el riesgo de arriba.
 *
 * **El `413` se traduce.** Nest convierte `LIMIT_FILE_SIZE` en
 * `PayloadTooLargeException` con el mensaje CRUDO de multer
 * (`File too large`). Un `413` que no dice cuál es el límite es un `413` que se
 * depura leyendo `node_modules`; el filtro de acá devuelve
 * `413 { code: 'file_too_large', limitBytes }` con el mensaje en castellano.
 *
 * **Las cuatro rutas de §3 del diseño las agrega la Fase 4 (tarea 4.5)** con
 * `@RequiresProjectAction('xmi.import')` y las llamadas a `XmiImportService`.
 * Este archivo deja el cableado compartido —interceptor y filtro a nivel de
 * clase— para que esos handlers lo hereden sin repetirlo cuatro veces.
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
 * Cuatro handlers finos (Fase 4) sobre dos métodos del servicio. Acá queda el
 * esqueleto: prefijo, interceptor multipart y filtro del `413`. **Todavía no
 * expone ninguna ruta**, así que el arranque no cambia su conteo (tarea 2.6).
 */
@Controller('projects/:projectId')
@UseInterceptors(FileInterceptor('file', XMI_MULTER_OPTIONS))
@UseFilters(XmiFileTooLargeFilter)
export class XmiImportController {}

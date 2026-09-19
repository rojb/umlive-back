import {
  Catch,
  HttpStatus,
  Logger,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { MulterModuleOptions } from '@nestjs/platform-express';
import { AI_TURN_ERROR } from '@umlive/contracts';

/**
 * La subida de la imagen del turno de foto (M6, rebanada 3/4 — `ai-image-input`,
 * diseño D1): los límites de multer, el archivo tal como llega y el `413`.
 *
 * ── Sin `storage`: la imagen NUNCA toca el disco ─────────────────────────────
 *
 * Sin `storage` ni `dest`, multer usa su `memoryStorage()` interno
 * (`multer/index.js`): el archivo vive en `file.buffer` y muere con la petición.
 * Eso es lo que hace cierta la promesa de privacidad de esta rebanada —no hay
 * archivo que purgar ni temporal que se quede— y además no obliga a sumar
 * `@types/multer` (los tipos de multer no vienen con el paquete).
 *
 * ── Los límites NO tienen default ───────────────────────────────────────────
 *
 * `fileSize` es `10 MB` (`PRD.md:569`). Sin `limits.fileSize` explícito, multer
 * no tiene tope propio: un `POST` de 3 GB se carga entero en memoria del proceso
 * ANTES de que corra una sola línea nuestra. `files: 1` cierra la variante de
 * mandar cincuenta archivos; `parts`/`fields` acotan los campos de texto que
 * viajan en el mismo `multipart` (`mode`, `prompt`).
 *
 * ── El `413` se traduce, y por eso este filtro existe ───────────────────────
 *
 * Nest convierte el `LIMIT_FILE_SIZE` de multer en `PayloadTooLargeException`
 * con el mensaje CRUDO de multer (`@nestjs/platform-express`,
 * `multer/multer.utils.js`). Un `413` que no dice cuál es el límite se depura
 * leyendo `node_modules`; acá se responde `413 { code: 'image_too_large',
 * limitBytes }`, que es lo que el cliente puede mostrar sin adivinar.
 *
 * Es el mismo patrón que `xmi-import` y NO se comparte con él a propósito:
 * cambian el código y el límite.
 *
 * A quién se le pega: al controlador de las rutas de imagen (`ai-turns.controller.ts`),
 * con `@UseInterceptors(FileInterceptor('image', IMAGE_MULTER_OPTIONS))` y
 * `@UseFilters(ImageUploadFilter)`. El orden importa: el guard de `ai.use` va
 * primero, así un no miembro recibe `403` antes de que multer lea un byte.
 *
 * Especificación: `.../ai-image-input-backend/spec.md`, "La subida tiene un tope
 * de tamaño fijo…". Diseño: `design.md` D1. `apps/api` es CommonJS: imports
 * relativos sin `.js`.
 */

/** El tope de la subida, en bytes. Diez megas (`PRD.md:569`). */
export const IMAGE_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Límites de multer del turno de imagen: un archivo, y hasta cuatro campos de
 * texto (`mode`, `prompt`, …) — cinco partes contando el archivo.
 */
export const IMAGE_MULTER_LIMITS = {
  fileSize: IMAGE_UPLOAD_LIMIT_BYTES,
  files: 1,
  fields: 4,
  parts: 5,
} as const;

/**
 * Opciones de multer de la ruta de imagen: **sin `storage`**, que es memoria por
 * defecto. Una sola instancia para que el tope no se pueda omitir por ruta.
 */
export const IMAGE_MULTER_OPTIONS: MulterModuleOptions = { limits: { ...IMAGE_MULTER_LIMITS } };

/**
 * El archivo en memoria, tipado local.
 *
 * Es una interfaz propia y no `Express.Multer.File` porque ese tipo viene de
 * `@types/multer`, que no es una dependencia de este paquete: lo que el código
 * usa de verdad son estos tres campos, y declararlos acá es lo que evita sumar
 * la dependencia entera por un alias.
 */
export interface UploadedImage {
  readonly buffer: Buffer;
  readonly size: number;
  readonly mimetype: string;
}

interface HttpResponse {
  status(code: number): { json(body: unknown): void };
}

/**
 * Traduce el `PayloadTooLargeException` que Nest produce a partir del
 * `LIMIT_FILE_SIZE` de multer. Acotado al controlador: en un controlador que
 * solo recibe `multipart`, la única fuente de un `413` es el tope del archivo.
 */
@Catch(PayloadTooLargeException)
export class ImageUploadFilter implements ExceptionFilter {
  private readonly log = new Logger(ImageUploadFilter.name);

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    this.log.warn(`subida de imagen rechazada por tamaño: el tope es ${IMAGE_UPLOAD_LIMIT_BYTES} bytes`);
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
      code: AI_TURN_ERROR.IMAGE_TOO_LARGE,
      limitBytes: IMAGE_UPLOAD_LIMIT_BYTES,
      message: `La imagen supera el límite de ${Math.floor(IMAGE_UPLOAD_LIMIT_BYTES / (1024 * 1024))} MB por turno.`,
    });
  }
}

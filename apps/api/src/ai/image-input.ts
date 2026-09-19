import { createHash } from 'node:crypto';
import { AI_TURN_ERROR } from '@umlive/contracts';

/**
 * Primitivas de imagen del turno de foto (M6, rebanada 3/4 — `ai-image-input`,
 * diseño D2). Funciones PURAS sobre un `Buffer`: leer el tipo, leer las
 * dimensiones, quitar metadatos y hashear.
 *
 * ── El servidor NUNCA decodifica píxeles ────────────────────────────────────
 *
 * Nada de acá construye un bitmap ni importa una librería de imágenes: se leen
 * 24 bytes de encabezado y se copian bloques. Eso es lo que hace que no exista
 * una bomba de descompresión que ejecutar (un PNG de 100 KB puede dibujar
 * gigabytes), y es la razón por la que este archivo se puede verificar con
 * buffers de bytes armados a mano.
 *
 * ── La regla de oro: cada lectura comprueba sus límites ─────────────────────
 *
 * **Toda** lectura pasa por `readable(buffer, offset, length)`. Un JPEG
 * truncado —el caso que encuentra un fuzzer y no un revisor— tiene que fallar
 * como `image_unreadable`, que la ruta traduce a `422`, y NUNCA como un
 * `RangeError` de `Buffer.readUInt16BE` que termine en un `500`. Un archivo
 * cortado es una entrada esperable, no un bug del servidor.
 *
 * ── El tipo sale del CONTENIDO, jamás del cliente ───────────────────────────
 *
 * El `Content-Type`, la extensión y el nombre original se ignoran: un `.exe`
 * renombrado a `imagen.png` no tiene firma y cae en `image_type_unsupported`
 * (`415`). La firma dice PNG, JPEG o WebP; otra cosa no entra.
 *
 * Especificación: `.../ai-image-input-backend/spec.md`, "El tipo de imagen se
 * verifica por contenido…" y "…se rechaza sin decodificar píxeles". Diseño:
 * `design.md` D2. `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Los tres formatos aceptados (SC-D16). */
export type ImageType = 'png' | 'jpeg' | 'webp';

/** Dimensiones declaradas en el encabezado, sin decodificar la imagen. */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Resultado de leer dimensiones. Unión discriminada y no excepción: un archivo
 * truncado es un caso ESPERADO del camino, y la ruta lo traduce a `422
 * image_unreadable` sin que nadie atrape nada.
 */
export type ReadDimensionsOutcome =
  | { readonly ok: true; readonly dimensions: ImageDimensions }
  | { readonly ok: false; readonly reason: typeof AI_TURN_ERROR.IMAGE_UNREADABLE };

/** Los tres rechazos de estructura comparten este motivo único. */
const UNREADABLE: ReadDimensionsOutcome = { ok: false, reason: AI_TURN_ERROR.IMAGE_UNREADABLE };

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Marcadores JPEG sin campo de longitud: se saltean sin leer nada. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/** SOF (inicio de marco): trae las dimensiones. `C4`/`C8`/`CC` NO son SOF. */
const JPEG_SOF_EXCLUDED = new Set([0xc4, 0xc8, 0xcc]);

/** El chunk de imagen de un WebP simple: los dos que siguen traen extensión. */
const WEBP_SIMPLE = 'VP8 ';
const WEBP_LOSSLESS = 'VP8L';
const WEBP_EXTENDED = 'VP8X';

/** Chunks de metadatos que se quitan al normalizar. */
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);

/** Bits de `VP8X` que declaran metadatos: se apagan al quitarlos. */
const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;

/** Bytes de CRC que cierran cada chunk de un RIFF. */
const RIFF_CHUNK_CRC_BYTES = 4;

/** Largo mínimo de archivo para que valga la pena mirar: firma + algo. */
const PNG_HEADER_BYTES = 24;
const JPEG_HEADER_BYTES = 12;
const WEBP_HEADER_BYTES = 30;

/**
 * El tipo de imagen por firma de bytes, o `null` si ninguna coincide.
 *
 * `null` es el rechazo `415 image_type_unsupported`: no hay excepción, hay
 * silencio, y la ruta decide el código.
 */
export function sniffImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Las dimensiones del encabezado, o `image_unreadable` si el archivo se corta
 * antes de declararlas.
 *
 * Ojo con el orden de las guardas: primero el largo mínimo, después cada lectura
 * con su comprobación. Un buffer de 6 bytes no llega a leer nada y no puede
 * provocar una lectura fuera de rango.
 */
export function readImageDimensions(buffer: Buffer, type: ImageType): ReadDimensionsOutcome {
  switch (type) {
    case 'png':
      return buffer.length < PNG_HEADER_BYTES ? UNREADABLE : pngDimensions(buffer);
    case 'jpeg':
      return buffer.length < JPEG_HEADER_BYTES ? UNREADABLE : jpegDimensions(buffer);
    case 'webp':
      return buffer.length < WEBP_HEADER_BYTES ? UNREADABLE : webpDimensions(buffer);
  }
}

/**
 * `sha256` hexadecimal de los bytes RECIBIDOS.
 *
 * Se calcula ANTES de quitar metadatos: es el hash de lo que el cliente tiene
 * en la mano y puede recalcular (`ai_turns.image_sha256`, privacidad).
 */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Los mismos bytes, sin metadatos (defensa en profundidad para un cliente que
 * no recodifica: `curl`, no el navegador de D3).
 *
 * - **JPEG**: quita los segmentos `APP1` (EXIF y XMP) y deja todo lo demás byte
 *   por byte, incluida la entropía posterior a `SOS`.
 * - **PNG**: quita los chunks `eXIf`, `tEXt`, `iTXt` y `zTXt`. Los CRC de los
 *   chunks que quedan NO cambian: son el CRC de su propio contenido.
 * - **WebP**: quita los chunks `EXIF`/`XMP `, reescribe el tamaño RIFF y apaga
 *   los bits `0x08`/`0x04` del `VP8X`.
 *
 * Si la estructura no se puede recorrer entera, devuelve una COPIA de la entrada
 * sin tocar. Es una decisión consciente: un archivo con la estructura rota ya
 * pasó (o no pasó) por `readImageDimensions`, y romper una imagen válida por un
 * metadato es peor que no quitarlo. El bucle real llama a esto DESPUÉS de leer
 * las dimensiones, así que este camino no se alcanza en el flujo normal.
 */
export function stripMetadata(buffer: Buffer, type: ImageType): Buffer {
  switch (type) {
    case 'png':
      return stripPng(buffer);
    case 'jpeg':
      return stripJpeg(buffer);
    case 'webp':
      return stripWebp(buffer);
  }
}

/** `offset + length <= buffer.length`, la única lectura permitida en este archivo. */
function readable(buffer: Buffer, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= buffer.length;
}

/** Dimensiones válidas, o `null`: un lado en cero no describe ninguna imagen. */
function dimensionsOf(width: number, height: number): ReadDimensionsOutcome {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return UNREADABLE;
  return { ok: true, dimensions: { width, height } };
}

// ─────────────────────────────────────────────────────────────────────────────
// PNG: firma + chunks con largo y CRC
// ─────────────────────────────────────────────────────────────────────────────

/** `IHDR` es siempre el primer chunk: ancho `u32BE@16`, alto `u32BE@20`. */
function pngDimensions(buffer: Buffer): ReadDimensionsOutcome {
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') return UNREADABLE;
  // 8 de firma + 4 de largo + 4 de tipo + 8 de ancho/alto.
  if (!readable(buffer, 0, 24)) return UNREADABLE;
  return dimensionsOf(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

/**
 * Recorre los chunks y copia los que no son metadatos. El recorrido corta en
 * `IEND`; si un largo se sale del archivo, se devuelve la entrada sin tocar.
 */
function stripPng(buffer: Buffer): Buffer {
  if (!readable(buffer, 0, PNG_HEADER_BYTES)) return Buffer.from(buffer);

  const kept: Buffer[] = [buffer.subarray(0, PNG_SIGNATURE.length)];
  let offset = PNG_SIGNATURE.length;

  while (readable(buffer, offset, 8)) {
    const length = buffer.readUInt32BE(offset);
    // Largo del chunk + CRC. Los 4 bytes del tipo ya están dentro de los 8.
    if (!readable(buffer, offset, 12 + length)) return Buffer.from(buffer);

    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!PNG_METADATA_CHUNKS.has(type)) kept.push(buffer.subarray(offset, end));

    offset = end;
    if (type === 'IEND') break;
  }

  return fresh(kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// JPEG: segmentos `FF xx` con largo de 2 bytes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recorre los segmentos hasta un SOF. Los marcadores sin longitud (`D0`–`D7`,
 * `01`) se saltean y el bucle termina por LARGO: si no alcanza el archivo, es
 * `image_unreadable`. Un marcador que no corresponde (o llegar al `SOS`, o al
 * `EOI`, sin haber visto un SOF) también termina en `image_unreadable`.
 */
function jpegDimensions(buffer: Buffer): ReadDimensionsOutcome {
  const sof = findJpegSof(buffer);
  if (sof === null) return UNREADABLE;
  return dimensionsOf(sof.width, sof.height);
}

/** El SOF con sus dimensiones, o `null` si la estructura no se puede leer entera. */
function findJpegSof(buffer: Buffer): ImageDimensions | null {
  let offset = 2; // después de `FF D8`

  while (readable(buffer, offset, 2)) {
    if (buffer[offset] !== 0xff) return null;

    // Relleno de bytes `FF` antes del marcador (permitido por la especificación).
    let markerOffset = offset;
    while (readable(buffer, markerOffset + 1, 1) && buffer[markerOffset + 1] === 0xff) markerOffset += 1;
    if (!readable(buffer, markerOffset, 2)) return null;

    const marker = buffer[markerOffset + 1]!;

    // `FF 00` es un `0x00` escapado dentro de la entropía: no es un marcador y
    // sólo aparece después de `SOS`, que ya habría cortado el recorrido.
    if (marker === 0x00) return null;

    // Sin SOF no hay dimensiones: `SOS` (marcadores con longitud) y `EOI` cortan.
    if (marker === 0xda || marker === 0xd9) return null;

    if (JPEG_STANDALONE.has(marker)) {
      offset = markerOffset + 2;
      continue;
    }

    if (!readable(buffer, markerOffset, 4)) return null;
    const segmentLength = buffer.readUInt16BE(markerOffset + 2);
    // El largo incluye sus propios 2 bytes, así que nunca puede ser < 2.
    if (segmentLength < 2 || !readable(buffer, markerOffset, 2 + segmentLength)) return null;

    const isSof = marker >= 0xc0 && marker <= 0xcf && !JPEG_SOF_EXCLUDED.has(marker);
    if (isSof) {
      // `FF Cx` + largo + precisión + alto (`@+5`) + ancho (`@+7`).
      if (!readable(buffer, markerOffset, 9)) return null;
      return {
        height: buffer.readUInt16BE(markerOffset + 5),
        width: buffer.readUInt16BE(markerOffset + 7),
      };
    }

    offset = markerOffset + 2 + segmentLength;
  }

  return null;
}

/**
 * Copia la imagen sin los segmentos `APP1` (EXIF y XMP).
 *
 * Se recorre la cabecera hasta `SOS` y el resto del archivo se copia como está:
 * el flujo de entropía puede contener `FF` y no se interpreta. Si el recorrido
 * no es concluyente, se devuelve la entrada sin tocar.
 */
function stripJpeg(buffer: Buffer): Buffer {
  if (!readable(buffer, 0, 2)) return Buffer.from(buffer);

  const kept: Buffer[] = [buffer.subarray(0, 2)];
  let offset = 2;

  while (readable(buffer, offset, 2)) {
    if (buffer[offset] !== 0xff) return Buffer.from(buffer);

    let markerOffset = offset;
    while (readable(buffer, markerOffset + 1, 1) && buffer[markerOffset + 1] === 0xff) markerOffset += 1;
    if (!readable(buffer, markerOffset, 2)) return Buffer.from(buffer);

    const marker = buffer[markerOffset + 1]!;

    if (marker === 0xda || marker === 0xd9 || JPEG_STANDALONE.has(marker)) {
      kept.push(buffer.subarray(offset));
      return fresh(kept);
    }

    if (!readable(buffer, markerOffset, 4)) return Buffer.from(buffer);
    const segmentLength = buffer.readUInt16BE(markerOffset + 2);
    if (segmentLength < 2 || !readable(buffer, markerOffset, 2 + segmentLength)) return Buffer.from(buffer);

    if (marker !== 0xe1) kept.push(buffer.subarray(markerOffset, markerOffset + 2 + segmentLength));
    offset = markerOffset + 2 + segmentLength;
  }

  return fresh(kept);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebP: contenedor RIFF con chunks
// ─────────────────────────────────────────────────────────────────────────────

/** Dimensiones según la variante: `VP8 `, `VP8L` o `VP8X`. */
function webpDimensions(buffer: Buffer): ReadDimensionsOutcome {
  if (!readable(buffer, 0, WEBP_HEADER_BYTES)) return UNREADABLE;

  const fourCC = buffer.toString('latin1', 12, 16);
  const length = buffer.readUInt32LE(16);
  if (!readable(buffer, 20, length)) return UNREADABLE;

  if (fourCC === WEBP_SIMPLE) {
    // `VP8 `: start code en `@23` y los dos `u16LE` con el tamaño en `@26`/`@28`.
    if (!readable(buffer, 26, 4)) return UNREADABLE;
    return dimensionsOf(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }

  if (fourCC === WEBP_LOSSLESS) {
    // `VP8L`: firma `0x2F` en `@20` y 14+14 bits LE desde `@21`, con +1.
    if (buffer[20] !== 0x2f || !readable(buffer, 21, 4)) return UNREADABLE;
    const bits = buffer.readUInt32LE(21);
    return dimensionsOf((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }

  if (fourCC === WEBP_EXTENDED) {
    // `VP8X`: ancho 24 bits LE en `@24`, alto en `@27`, los dos con +1.
    if (!readable(buffer, 24, 6)) return UNREADABLE;
    const width = 1 + buffer[24]! + (buffer[25]! << 8) + (buffer[26]! << 16);
    const height = 1 + buffer[27]! + (buffer[28]! << 8) + (buffer[29]! << 16);
    return dimensionsOf(width, height);
  }

  // Un chunk que no es de imagen (`ANIM`, `ALPH`, …) o una variante desconocida:
  // no hay dimensiones que leer sin decodificar.
  return UNREADABLE;
}

/**
 * Reescribe el contenedor sin los chunks `EXIF`/`XMP `.
 *
 * El tamaño RIFF (`@4`) se recalcula sobre el archivo final, y si el `VP8X`
 * declara metadatos se apagan sus bits. Todo lo demás se copia byte por byte,
 * incluido el byte de relleno de los chunks de largo impar.
 */
function stripWebp(buffer: Buffer): Buffer {
  if (!readable(buffer, 0, 12)) return Buffer.from(buffer);

  const kept: Buffer[] = [buffer.subarray(0, 12)];
  let offset = 12;
  let removedMetadata = false;

  while (readable(buffer, offset, 8)) {
    const fourCC = buffer.toString('latin1', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const padded = length + (length % 2);
    // Cada chunk es `fourCC` + largo + datos (con relleno par) + CRC.
    const size = 8 + padded + RIFF_CHUNK_CRC_BYTES;
    if (!readable(buffer, offset, size)) return Buffer.from(buffer);

    const end = offset + size;
    if (WEBP_METADATA_CHUNKS.has(fourCC)) {
      removedMetadata = true;
    } else {
      kept.push(buffer.subarray(offset, end));
    }
    offset = end;
  }

  // Un archivo con la estructura cortada al final ya devolvió la entrada sin
  // tocar; llegar acá con `offset < buffer.length` es relleno legítimo.
  const body = fresh(kept);
  if (removedMetadata) clearWebpMetadataFlags(body);
  body.writeUInt32LE(body.length - 8, 4);
  return body;
}

/**
 * Concatenación SIEMPRE nueva: `Buffer.concat` con un solo elemento puede
 * devolver una vista del original, y al `VP8X` se le escribe encima.
 */
function fresh(parts: readonly Buffer[]): Buffer {
  return Buffer.from(Buffer.concat(parts as Buffer[]));
}

/**
 * Apaga los bits `0x08`/`0x04` del `VP8X`, si el archivo tiene ese chunk.
 *
 * Límite conocido: el CRC del chunk NO se recalcula (no hay dependencia de
 * `crc32`); el diseño D2 pide apagar los bits y los decodificadores reales no
 * verifican ese CRC.
 */
function clearWebpMetadataFlags(file: Buffer): void {
  if (!readable(file, 12, 8 + 10 + RIFF_CHUNK_CRC_BYTES)) return;
  if (file.toString('latin1', 12, 16) !== WEBP_EXTENDED) return;
  const flags = file[20]!;
  file[20] = flags & ~WEBP_EXIF_FLAG & ~WEBP_XMP_FLAG;
}

/**
 * El Maven Wrapper del proyecto emitido (tarea 2.6, D7 y D9).
 *
 * Este archivo no inventa un solo byte: decodifica los tres archivos que
 * `wrapper-scripts.ts` guarda en base64, copiados del golden de la Fase 0, y les
 * da la única propiedad que el ZIP necesita además del contenido — el bit de
 * ejecución, y solo para `mvnw`.
 *
 * Por qué la distribución es 3.9.14 y la URL de Maven Central: el directorio de
 * `~/.m2/wrapper/dists` es un hash de la URL, así que una URL idéntica carácter
 * por carácter reusa la distribución ya cacheada en esta máquina y el wrapper no
 * sale a la red (D9, verificado en la Fase 0).
 *
 * Por qué `mvnw.cmd` es CRLF y el resto LF: `cmd.exe` rompe los `goto` y las
 * etiquetas con LF, y `.gitattributes` no alcanza al interior del ZIP. La
 * conversión la trae el byte copiado del golden; el emisor no toca finales de
 * línea.
 */

import type { GeneratedFile } from '../zip';
import { WRAPPER_SCRIPTS } from './wrapper-scripts';

/** El único archivo del wrapper con bit de ejecución (D7). */
const EXECUTABLE_WRAPPER_PATH = 'mvnw';

/**
 * Decodifica los bytes del golden. `Buffer.from(…, 'base64').toString('utf8')`
 * es exacto acá porque los tres archivos son ASCII: los `\r` de `mvnw.cmd`
 * sobreviven como `\r\n` y `buildZip` los escribe tal cual.
 */
export function decodeWrapperScript(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

/** Los tres archivos del wrapper, listos para el ZIP. */
export function emitWrapperFiles(): GeneratedFile[] {
  return WRAPPER_SCRIPTS.map((script) => ({
    path: script.path,
    content: decodeWrapperScript(script.base64),
    executable: script.path === EXECUTABLE_WRAPPER_PATH,
  }));
}

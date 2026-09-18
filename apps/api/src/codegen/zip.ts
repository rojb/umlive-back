/**
 * Empaquetado determinista (D7, tarea 2.7).
 *
 * El ZIP lleva **todos** los archivos emitidos, en memoria: nada toca el disco
 * ni se persiste en la base (requisito «el generador no escribe ninguna fila ni
 * persiste el ZIP»). `sha256` viaja en la respuesta, así SC-F11 se compara sin
 * descomprimir.
 *
 * Las cuatro fuentes de no-determinismo que D7 cierra, una por una:
 *
 * 1. **Orden de las entradas** — rutas ordenadas con `<`, nunca con
 *    `localeCompare` (que depende de ICU y del locale del proceso). Se insertan
 *    como claves planas y ninguna ruta tiene forma de índice entero, así que
 *    `Object.keys` respeta el orden de inserción.
 * 2. **`mtime`** — `new Date(1980, 0, 1)` con componentes **locales**. `fflate`
 *    arma la fecha DOS con getters locales (`wzh`), así que un `Date` construido
 *    en UTC se convierte en 1979-12-31 en UTC−4 y `fflate` **lanza**
 *    («date not in range»). Con componentes locales el resultado es el mismo
 *    instante local —y por lo tanto los mismos bytes— en cualquier zona.
 * 3. **Compresión** — `level: 6` fijo y `fflate` con versión exacta en
 *    `package.json` (sin `^`): con otro compresor el mismo modelo daría otro
 *    hash.
 * 4. **Permisos y finales de línea** — `mvnw` es el único con `attrs` de
 *    ejecución y `os: 3` (Unix). Los emisores escriben `\n`, nunca `os.EOL`; el
 *    único archivo CRLF es `mvnw.cmd`, y sus bytes vienen del golden (D9).
 *
 * El bit 11 del «general purpose flag» (UTF-8, `0x0800`) lo calcula `zipSync`
 * solo, comparando los bytes UTF-8 del nombre contra su longitud de cadena
 * (`fflate@0.8.2`, `lib/index.cjs:2289` y `:1854`): una entrada
 * `entity/Dirección.java` sale marcada sin ninguna lógica extra acá (D7).
 */

import { createHash } from 'node:crypto';
import { strToU8, zipSync, type ZipOptions, type Zippable } from 'fflate';

/** Un archivo emitido, en memoria y sin tocar el disco. */
export interface GeneratedFile {
  /** Ruta relativa dentro del ZIP, con `/`, sin el prefijo del `artifactId`. */
  path: string;
  /** Texto UTF-8 sin BOM y con `\n` (la única excepción es `mvnw.cmd`, en CRLF). */
  content: string;
  /** `true` solo para `mvnw`: es el único archivo con bit de ejecución (D7). */
  executable?: boolean;
}

/** Resultado del empaquetado: los bytes del ZIP y su hash. */
export interface ZipPackage {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * Fecha fija de todas las entradas. Componentes **locales** a propósito: ver el
 * punto 2 del encabezado. Es la única aparición de `new Date` en `codegen/`, y
 * es una constante, no una lectura del reloj.
 */
const FIXED_MTIME = new Date(1980, 0, 1);

/** `0100755` (rwxr-xr-x) en el campo DOS de atributos externos. */
const EXECUTABLE_ATTRS = 0o100755 << 16;

/** Identificador de Unix en «version made by»: solo para `mvnw`. */
const UNIX_OS = 3;

/** Nivel de compresión fijo (D7). */
const DEFLATE_LEVEL = 6;

/**
 * Comparación de rutas independiente del locale (punto 1 del encabezado).
 * Exportada para que el reporte y las pruebas de determinismo puedan reusarla.
 */
export function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Comprime `files` bajo `<artifactId>/` y devuelve los bytes y su SHA-256.
 *
 * Función pura: dos llamadas con los mismos archivos dan bytes idénticos, en la
 * misma zona horaria y en cualquier otra.
 */
export function buildZip(artifactId: string, files: readonly GeneratedFile[]): ZipPackage {
  const ordered = [...files].sort((a, b) => comparePath(a.path, b.path));
  const entries: Zippable = {};

  for (const file of ordered) {
    const zipPath = `${artifactId}/${file.path}`;
    if (Object.prototype.hasOwnProperty.call(entries, zipPath)) {
      // Dos emisores con la misma ruta dejan un archivo de menos en el ZIP:
      // sería una pérdida silenciosa, justo lo que el reporte no puede tener.
      throw new Error(`ruta de ZIP duplicada: ${zipPath}`);
    }
    const options: ZipOptions = { mtime: FIXED_MTIME, level: DEFLATE_LEVEL };
    if (file.executable === true) {
      options.attrs = EXECUTABLE_ATTRS;
      options.os = UNIX_OS;
    }
    entries[zipPath] = [strToU8(file.content), options];
  }

  const bytes = zipSync(entries);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

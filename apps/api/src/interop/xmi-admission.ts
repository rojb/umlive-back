import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import {
  XMI_IMPORT_ERROR,
  XMI_MAX_IMPORT_BYTES,
  type XmiImportErrorCode,
  type XmiSourceEncoding,
  type XmiVersion,
} from '@umlive/contracts';
import { XMI_2_1, XMI_2_5_1, type XmiVersionStrategy } from './xmi-version-strategy';

/**
 * Nivel A de la admisión (D1, D3, D4) — Fase 1, tareas 1.2 y 1.4.
 *
 * Todo lo que hay acá corre **sobre bytes y documento**, antes de abrir
 * cualquier transacción: tamaño, prólogo/encoding, buena formación, raíz +
 * namespace POR URI, versión detectable. Un rechazo deja **cero filas** y ni
 * siquiera llega al lector.
 *
 * ── D4: el orden de la decodificación NO es negociable ────────────────────
 * ```
 * 1. primeros 1024 bytes como ASCII   (subconjunto seguro de UTF-8 y windows-1252)
 * 2. regex del prólogo sobre esa ventana
 * 3. normalizar la etiqueta → 'UTF-8' | 'windows-1252'
 * 4. RECIÉN AHORA decodificar el Buffer entero
 * 5. quitar BOM
 * ```
 * Decodificar primero como UTF-8 para leer el prólogo es la vía obvia y ya
 * corrompió el archivo antes de enterarse. Sin prólogo → UTF-8 (default de XML).
 *
 * ── La sonda de `windows-1252` es de CORRECTITUD, no solo de disponibilidad ─
 * El diseño pide `TextDecoder('windows-1252')` con caída a `iconv-lite` ante
 * `RangeError` (small-icu). **Medido en esta máquina**, Node v22.18.0 con
 * full-icu: `new TextDecoder('windows-1252')` NO lanza y decodifica el byte
 * `0x80` como `U+0080`, es decir se comporta como `latin1` — justo el bug que
 * D4 existe para evitar. Por eso la sonda no pregunta «¿anda?» sino «¿decodifica
 * `0x80` como `€`?»: si la respuesta no es sí, o si lanza, se usa `iconv-lite`.
 * `latin1` **nunca** es un sustituto válido.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Árbol XML ordenado — lo consumen el lector (Fase 2) y el lector de la
// extensión EA (Fase 3). `preserveOrder` es lo que hace posible las `position`
// por orden de documento (D9) y el índice del auto-layout (D8).
// ─────────────────────────────────────────────────────────────────────────────

export interface XmlElementNode {
  /** Nombre calificado tal como se escribió (p. ej. `uml:Model`, `packagedElement`). */
  readonly name: string;
  /** Atributos sin el prefijo `@_`, con su nombre crudo (`xmi:id`, `xmlns:uml`). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElementNode[];
  /** Texto directo concatenado. Los documentos de E.1/E.2 no lo usan; EA sí puede. */
  readonly text: string;
}

/** Nombre local sin prefijo. Nunca se decide un `xmi:type` por el prefijo (trampa 3), pero el nombre local sí es estable. */
export function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/** Prefijo de un nombre calificado, o la cadena vacía si no tiene. */
export function prefixOf(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? '' : qualified.slice(0, colon);
}

/**
 * Construye el árbol ordenado. `parseTagValue`/`parseAttributeValue` en
 * `false`: TODOS los valores quedan string, porque un `xmi:id` numérico no
 * debe convertirse en número por accidente.
 */
export function parseXmlTree(text: string): XmlElementNode {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    parseAttributeValue: false,
    allowBooleanAttributes: true,
  });
  const parsed = parser.parse(text) as unknown;
  const root = findRootElement(parsed);
  if (root === null) {
    throw new XmiAdmissionError(XMI_IMPORT_ERROR.MALFORMED_XML, 'el documento no tiene un elemento raíz');
  }
  return root;
}

const RAW_KEYS = new Set([':@', '#text', '#comment']);

function findRootElement(parsed: unknown): XmlElementNode | null {
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    const element = toElement(entry);
    if (element !== null) return element;
  }
  return null;
}

function toElement(entry: unknown): XmlElementNode | null {
  if (entry === null || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const attributes: Record<string, string> = {};
  const attributeBag = record[':@'];
  if (attributeBag !== null && typeof attributeBag === 'object') {
    for (const [key, value] of Object.entries(attributeBag as Record<string, unknown>)) {
      if (key.startsWith('@_') && typeof value === 'string') attributes[key.slice(2)] = value;
    }
  }

  let text = '';
  const children: XmlElementNode[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (RAW_KEYS.has(key)) continue;
    if (key === '#text') {
      if (typeof value === 'string') text += value;
      continue;
    }
    // Instrucciones de procesamiento (`?xml`) y declaraciones (`!DOCTYPE`)
    // NO son elementos: el árbol empieza en el primer tag real.
    if (key.startsWith('?') || key.startsWith('!')) return null;
    if (!Array.isArray(value)) continue;
    for (const child of value) {
      const element = toElement(child);
      if (element !== null) children.push(element);
      else if (child !== null && typeof child === 'object') {
        const childText = (child as Record<string, unknown>)['#text'];
        if (typeof childText === 'string') text += childText;
      }
    }
    return { name: key, attributes, children, text };
  }
  // Nodo hoja sin hijos: `record` tenía solo `:@` (y quizá `#text`).
  return { name: '', attributes, children, text };
}

/** Recorre el árbol en pre-orden (orden de documento), incluyendo el nodo raíz. */
export function* walkDocument(node: XmlElementNode): Generator<XmlElementNode> {
  yield node;
  for (const child of node.children) yield* walkDocument(child);
}

/**
 * Mapa prefijo→URI de TODO el documento (`xmlns` = prefijo vacío). Se recorre
 * entero y gana la última declaración de cada prefijo: alcanza para resolver
 * `xmi:type="uml:Class"` por URI sin escribir un rastreador de ámbitos, y es
 * estrictamente mejor que mirar el prefijo.
 */
export function collectNamespaces(root: XmlElementNode): Map<string, string> {
  const namespaces = new Map<string, string>();
  for (const node of walkDocument(root)) {
    for (const [key, value] of Object.entries(node.attributes)) {
      if (key === 'xmlns') namespaces.set('', value);
      else if (key.startsWith('xmlns:')) namespaces.set(key.slice(6), value);
    }
  }
  return namespaces;
}

/** Resuelve la URI de un prefijo. `''` es el namespace por defecto. */
export function namespaceUriOf(qualified: string, namespaces: ReadonlyMap<string, string>): string | null {
  const prefix = prefixOf(qualified);
  return namespaces.get(prefix) ?? (prefix === '' ? namespaces.get('') ?? null : null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decodificación (D4)
// ─────────────────────────────────────────────────────────────────────────────

export class XmiAdmissionError extends Error {
  constructor(
    readonly code: XmiImportErrorCode,
    message: string,
    /** Solo para `unsupported_format` (FR-E19): el formato nombrado. */
    readonly format?: string,
    /** Solo para `file_too_large` (D3): el tope, para que el cliente lo diga. */
    readonly limitBytes?: number,
  ) {
    super(message);
    this.name = 'XmiAdmissionError';
  }
}

export interface DecodedXmi {
  readonly text: string;
  readonly encoding: XmiSourceEncoding;
}

/** Ventana ASCII del prólogo. 1024 bytes alcanzan para cualquier `<?xml …?>` real. */
const PROLOGUE_WINDOW_BYTES = 1024;
const PROLOGUE_ENCODING = /<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9_.-]+)["']/i;

interface WindowsCodec {
  readonly label: string;
  decode(buffer: Buffer): string;
}

let cachedWindowsCodec: WindowsCodec | null = null;

/**
 * Sonda única y cacheada. `TextDecoder` solo se elige si decodifica `0x80`
 * como `€`; si lanza `RangeError` (small-icu) o miente, cae a `iconv-lite`.
 */
export function windowsCodec(): WindowsCodec {
  if (cachedWindowsCodec !== null) return cachedWindowsCodec;
  try {
    const direct = new TextDecoder('windows-1252');
    if (direct.decode(Buffer.from([0x80])) === '\u20AC') {
      cachedWindowsCodec = { label: 'TextDecoder(windows-1252)', decode: (buffer) => new TextDecoder('windows-1252').decode(buffer) };
      return cachedWindowsCodec;
    }
  } catch {
    // small-icu: `RangeError`. Se resuelve abajo con iconv-lite.
  }
  cachedWindowsCodec = { label: 'iconv-lite(windows-1252)', decode: (buffer) => iconv.decode(buffer, 'windows-1252') };
  return cachedWindowsCodec;
}

/** Etiqueta del códec activo, para la línea de log del arranque (D4). */
export function windowsCodecLabel(): string {
  return windowsCodec().label;
}

function normalizeEncoding(label: string | null): XmiSourceEncoding {
  if (label === null) return 'UTF-8';
  const normalized = label.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'utf-8' || normalized === 'utf8') return 'UTF-8';
  if (normalized === 'windows-1252' || normalized === 'cp1252' || normalized === 'x-cp1252') return 'windows-1252';
  throw new XmiAdmissionError(
    XMI_IMPORT_ERROR.UNSUPPORTED_ENCODING,
    `el prólogo declara encoding="${label}"; solo se aceptan UTF-8 y windows-1252 (latin1/ISO-8859-1 NO son un sustituto: difieren en 0x80–0x9F)`,
  );
}

/**
 * Orden obligatorio de D4. Único punto de entrada: no hay una función que
 * devuelva el texto sin pasar por acá.
 */
export function decodeXmi(buffer: Buffer): DecodedXmi {
  // 1) Ventana ASCII. `latin1` acá es seguro: mapea byte→punto de código 1:1,
  //    y el prólogo es ASCII puro en las dos codificaciones aceptadas.
  const window = buffer.subarray(0, PROLOGUE_WINDOW_BYTES).toString('latin1');
  // 2) y 3) prólogo → etiqueta normalizada.
  const encoding = normalizeEncoding(PROLOGUE_ENCODING.exec(window)?.[1] ?? null);
  // 4) ahora sí, el Buffer entero.
  const text = encoding === 'windows-1252' ? windowsCodec().decode(buffer) : buffer.toString('utf8');
  // 5) BOM, si quedó (TextDecoder('utf-8') ya lo quita; toString('utf8') no).
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admisión (tareas 1.4) — tamaño, buena formación, raíz + namespace por URI
// ─────────────────────────────────────────────────────────────────────────────

export interface XmiAdmission {
  readonly buffer: Buffer;
  readonly text: string;
  readonly encoding: XmiSourceEncoding;
  readonly version: XmiVersion;
  readonly strategy: XmiVersionStrategy;
  readonly root: XmlElementNode;
  readonly namespaces: ReadonlyMap<string, string>;
}

/**
 * Formatos que EA puede exportar por el mismo menú y que **no** son UML
 * (trampa 7 de E.5). Se nombra el formato en el `415`, no se dice «no es UML»
 * (FR-E19): el mensaje tiene que ser accionable.
 */
const KNOWN_FORMATS: readonly { format: string; matches: (uri: string, rootLocal: string) => boolean }[] = [
  { format: 'bpmn', matches: (uri, rootLocal) => /bpmn/i.test(uri) || (rootLocal === 'definitions' && /bpmn/i.test(uri)) },
  { format: 'ecore', matches: (uri) => /ecore/i.test(uri) },
  { format: 'arcgis', matches: (uri) => /arcgis/i.test(uri) || /esri\.com/i.test(uri) },
];

const UML_STRATEGIES: readonly XmiVersionStrategy[] = [XMI_2_5_1, XMI_2_1];

/**
 * Nivel A sobre el `Buffer` crudo. Aborta (nunca degrada) y devuelve el árbol
 * ya parseado para que el lector NO reparsee 50 MB.
 */
export function admitXmi(buffer: Buffer): XmiAdmission {
  if (buffer.length > XMI_MAX_IMPORT_BYTES) {
    throw new XmiAdmissionError(
      XMI_IMPORT_ERROR.FILE_TOO_LARGE,
      `el archivo tiene ${buffer.length} bytes y el máximo son ${XMI_MAX_IMPORT_BYTES}`,
      undefined,
      XMI_MAX_IMPORT_BYTES,
    );
  }

  const { text, encoding } = decodeXmi(buffer);

  // [2] buena formación, sobre el texto ya decodificado con la codificación correcta.
  const validated = XMLValidator.validate(text);
  if (validated !== true) {
    throw new XmiAdmissionError(
      XMI_IMPORT_ERROR.MALFORMED_XML,
      `el XML no está bien formado (línea ${validated.err.line}, columna ${validated.err.col}): ${validated.err.msg}`,
    );
  }

  const root = parseXmlTree(text);
  const namespaces = collectNamespaces(root);
  const rootLocal = localName(root.name);

  // [3] versión y namespace POR URI (trampa 3), nunca por el prefijo `uml:`.
  const declared = [...new Set(namespaces.values())];
  const strategy = UML_STRATEGIES.find((candidate) => declared.includes(candidate.umlNs));

  if (strategy === undefined) {
    const known = declared
      .map((uri) => KNOWN_FORMATS.find((entry) => entry.matches(uri, rootLocal)))
      .find((entry) => entry !== undefined);
    if (known !== undefined) {
      throw new XmiAdmissionError(
        XMI_IMPORT_ERROR.UNSUPPORTED_FORMAT,
        `el documento es un archivo ${known.format.toUpperCase()}, no un modelo UML: no declara el namespace de UML`,
        known.format,
      );
    }
    // Hay namespaces de UML pero de una versión que no manejamos: es UML, la versión no es detectable.
    const umlLooking = declared.find((uri) => /\/spec\/UML\/|schema\.omg\.org\/spec\/UML\//i.test(uri));
    if (umlLooking !== undefined) {
      throw new XmiAdmissionError(
        XMI_IMPORT_ERROR.VERSION_UNDETECTABLE,
        `el documento declara el namespace UML '${umlLooking}', que no corresponde ni a XMI 2.5.1 ni a XMI 2.1`,
      );
    }
    throw new XmiAdmissionError(
      XMI_IMPORT_ERROR.NOT_UML_DOCUMENT,
      `la raíz <${root.name}> no declara el namespace de UML por URI: no es un documento UML`,
    );
  }

  return { buffer, text, encoding, version: strategy.version, strategy, root, namespaces };
}

/**
 * Proveedor Nest (tarea 1.7). No es una clase de caso de uso: es el punto de
 * inyección del nivel A y el lugar del **log al arranque** que D4 pide para la
 * sonda de `windows-1252` — un `RangeError` de small-icu deja de ser un spike
 * bloqueante y pasa a ser una línea de log.
 */
@Injectable()
export class XmiAdmissionService implements OnModuleInit {
  private readonly logger = new Logger(XmiAdmissionService.name);

  onModuleInit(): void {
    this.logger.log(
      `decodificación windows-1252 activa vía ${windowsCodecLabel()} (sonda de correctitud de 0x80 = €, cacheada una sola vez)`,
    );
  }

  /** Abre el archivo: tamaño → prólogo/encoding → buena formación → raíz/namespace/versión. */
  admit(buffer: Buffer): XmiAdmission {
    return admitXmi(buffer);
  }
}

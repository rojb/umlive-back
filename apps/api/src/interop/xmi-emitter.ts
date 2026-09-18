import { XMI_EXPORT_NOTE, type XmiExportNote } from '@umlive/contracts';
import type { XmiVersionStrategy } from './xmi-version-strategy';

/**
 * Emisor de XML a mano (D9). **No** se usa `XMLBuilder` de `fast-xml-parser`:
 * su orden de atributos sale del orden de claves del objeto, y en JS las
 * claves con forma numérica se reordenan antes que las demás. Hoy un `xmi:id`
 * numérico no pasaría (no es NCName válido), pero un determinismo byte a byte
 * no puede descansar en una sutileza del runtime. Acá los atributos son una
 * **lista ordenada explícita**: el determinismo se lee.
 *
 * Reglas fijas: `\n` siempre (nunca `os.EOL` — esto compila en Windows),
 * indentación de 2 espacios, sin BOM, `<?xml version="1.0" encoding="UTF-8"?>`
 * en las DOS versiones (FR-E05, D10) y **cero marcas de tiempo**.
 *
 * Escapado: `&`, `<`, `>` en texto; `&`, `<`, `"` en atributo. Un carácter de
 * control ilegal en XML 1.0 no lo arregla ningún escapado — se **elimina** y
 * se reporta (`illegal_xml_char_stripped`): un carácter invisible no puede
 * matar un export, pero tampoco puede alterar el documento en silencio.
 */

export interface XmiAttr {
  readonly name: string;
  readonly value: string | number | boolean;
}

/** Azúcar para armar la lista ordenada de atributos sin objetos intermedios. */
export const att = (name: string, value: string | number | boolean): XmiAttr => ({ name, value });

/**
 * Rangos legales de XML 1.0: `#x9 | #xA | #xD | [#x20-#xD7FF] |
 * [#xE000-#xFFFD] | [#x10000-#x10FFFF]`. `u` es obligatorio para que un
 * carácter astral cuente como un solo punto de código y no se elimine por
 * error. Los surrogates sueltos quedan fuera de los rangos y también se van.
 */
const ILLEGAL_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const TEXT_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '"': '&quot;' };

export class XmiEmitter {
  private readonly lines: string[] = [];
  private readonly stripped: XmiExportNote[] = [];
  private depth = 0;
  private subjectId: string | null = null;

  /** Lee la estrategia SOLO para el prólogo y la raíz: es uno de los cuatro puntos de consulta de D4. */
  constructor(private readonly strategy: XmiVersionStrategy) {}

  /** `xmi:id` del elemento cuyo texto se está escribiendo. Solo alimenta el reporte. */
  subject(xmiId: string | null): void {
    this.subjectId = xmiId;
  }

  /** Prólogo + raíz + `xmi:Documentation` (E.1). Sin fecha: E.1 no la lleva. */
  openDocument(): void {
    this.lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    this.open('xmi:XMI', [
      att('xmi:version', this.strategy.token),
      att('xmlns:uml', this.strategy.umlNs),
      att('xmlns:xmi', this.strategy.xmiNs),
    ]);
    this.leaf('xmi:Documentation', [att('exporter', 'UMLive'), att('exporterVersion', '1.0')]);
  }

  closeDocument(): void {
    this.close('xmi:XMI');
  }

  openModel(): void {
    this.open('uml:Model', [att('xmi:type', 'uml:Model'), att('name', 'EA_Model'), att('visibility', 'public')]);
  }

  closeModel(): void {
    this.close('uml:Model');
  }

  leaf(tag: string, attrs: readonly XmiAttr[]): void {
    this.lines.push(`${this.indent()}<${tag}${this.renderAttrs(tag, attrs)}/>`);
  }

  open(tag: string, attrs: readonly XmiAttr[]): void {
    this.lines.push(`${this.indent()}<${tag}${this.renderAttrs(tag, attrs)}>`);
    this.depth += 1;
  }

  close(tag: string): void {
    this.depth -= 1;
    this.lines.push(`${this.indent()}</${tag}>`);
  }

  text(tag: string, attrs: readonly XmiAttr[], value: string): void {
    const body = this.escape(this.scrub(value, `texto de <${tag}>`), TEXT_ESCAPES);
    this.lines.push(`${this.indent()}<${tag}${this.renderAttrs(tag, attrs)}>${body}</${tag}>`);
  }

  illegalCharNotes(): readonly XmiExportNote[] {
    return this.stripped;
  }

  toXml(): string {
    return `${this.lines.join('\n')}\n`;
  }

  private indent(): string {
    return '  '.repeat(this.depth);
  }

  private renderAttrs(tag: string, attrs: readonly XmiAttr[]): string {
    return attrs
      .map((a) => ` ${a.name}="${this.escape(this.scrub(String(a.value), `${a.name} de <${tag}>`), ATTR_ESCAPES)}"`)
      .join('');
  }

  private escape(value: string, table: Readonly<Record<string, string>>): string {
    return value.replace(/[&<>"]/g, (c) => table[c] ?? c);
  }

  private scrub(value: string, where: string): string {
    return value.replace(ILLEGAL_XML_CHAR, (c) => {
      const point = c.codePointAt(0) ?? 0;
      this.stripped.push({
        code: XMI_EXPORT_NOTE.ILLEGAL_XML_CHAR_STRIPPED,
        subjectId: this.subjectId,
        detail: `U+${point.toString(16).toUpperCase().padStart(4, '0')} eliminado de ${where}`,
      });
      return '';
    });
  }
}

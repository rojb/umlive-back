import type { ElementLayoutView } from '@umlive/contracts';
import { autoLayoutAt } from './auto-layout';
import { localName, walkDocument, type XmlElementNode } from './xmi-admission';

/**
 * Bloque de extensión de Enterprise Architect — lado LECTOR (E.4) —
 * Fase 2/3, tareas 2.4 y 3.2.
 *
 * **La desambiguación de `<element>` es por presencia del atributo `geometry`,
 * nunca por el padre** (`<elements>` vs `<diagrams>`): EA usa el mismo nombre
 * de tag para la extensión de un elemento del modelo y para la forma de un
 * elemento en un diagrama (trampa 1 de E.5). Mirar el padre funciona hasta el
 * primer archivo que anida distinto y, cuando falla, **mezcla datos semánticos
 * con visuales en silencio**.
 *
 * **Fórmula inversa de E.4**: `x = Left`, `y = Top`, `width = Right − Left`,
 * `height = Bottom − Top`. `x`/`y` no tienen restricción de signo — el lienzo
 * usa coordenadas negativas normalmente; la única restricción real es
 * `ck_layout_size` (`width > 0 AND height > 0`).
 *
 * **Geometría inutilizable = ausente, malformada, con menos de las cuatro
 * claves, no numérica, o con `width <= 0 || height <= 0`.** Los cinco casos
 * caen al MISMO lugar: auto-layout de ESE elemento (D8) y una línea nombrada
 * en `warnings`. **Nunca aborta y nunca arrastra a otro elemento** (hallazgo 1
 * del diseño: 100 clases, una degenerada, 100 importadas).
 */

export interface ParsedGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EaExtensionIndex {
  /** Geometría UTILIZABLE, por `subject` (el `xmi:id` del elemento dibujado). */
  readonly geometryBySubject: ReadonlyMap<string, ParsedGeometry>;
  /** Geometría cruda tal como vino, esté usable o no. Solo para el detalle del warning. */
  readonly rawGeometryBySubject: ReadonlyMap<string, string>;
  /** `xmi:idref` → `stereotype` de la extensión de modelo (texto de perfil degradado a columna). */
  readonly stereotypeBySubject: ReadonlyMap<string, string>;
  /** ¿Alguna forma traía `seqno`? El z-order no tiene columna y se declara ignorado. */
  readonly seqnoSeen: boolean;
}

export interface LayoutOutcome extends ParsedGeometry {
  /** `extension` = geometría real del archivo; `auto_layout` = D8 por ausencia o degeneración. */
  readonly source: 'extension' | 'auto_layout';
  /** La cadena cruda, presente pero inutilizable, o `null` si directamente no había geometría. */
  readonly rawGeometry: string | null;
}

const EMPTY_INDEX: EaExtensionIndex = {
  geometryBySubject: new Map(),
  rawGeometryBySubject: new Map(),
  stereotypeBySubject: new Map(),
  seqnoSeen: false,
};

/**
 * Índice de la extensión. Recorre TODO el documento buscando `<element>` —el
 * discriminante es el atributo, así que el padre es irrelevante por diseño.
 */
export function readEaExtension(root: XmlElementNode): EaExtensionIndex {
  const geometryBySubject = new Map<string, ParsedGeometry>();
  const rawGeometryBySubject = new Map<string, string>();
  const stereotypeBySubject = new Map<string, string>();
  let seqnoSeen = false;

  for (const node of walkDocument(root)) {
    if (localName(node.name) !== 'element') continue;

    const rawGeometry = node.attributes['geometry'];
    if (rawGeometry !== undefined) {
      // Forma de diagrama: tiene `geometry`. `subject` apunta al elemento del modelo.
      if (node.attributes['seqno'] !== undefined) seqnoSeen = true;
      const subject = node.attributes['subject'];
      if (subject === undefined || subject === '') continue;
      rawGeometryBySubject.set(subject, rawGeometry);
      const geometry = parseEaGeometry(rawGeometry);
      if (geometry !== null) geometryBySubject.set(subject, geometry);
      continue;
    }

    // Extensión de modelo: sin `geometry`. Solo se aprovecha el estereotipo.
    const reference = node.attributes['xmi:idref'];
    const stereotype = node.attributes['stereotype'];
    if (reference !== undefined && stereotype !== undefined && stereotype !== '') {
      stereotypeBySubject.set(reference, stereotype);
    }
  }

  return { geometryBySubject, rawGeometryBySubject, stereotypeBySubject, seqnoSeen };
}

/** Índice vacío — un documento sin `<xmi:Extension>`, que es un caso válido (FR-E09). */
export function emptyEaExtension(): EaExtensionIndex {
  return EMPTY_INDEX;
}

/**
 * E.4 inversa. Devuelve `null` para los cinco casos de geometría inutilizable:
 * ausente (lo decide el llamador), malformada, con menos de cuatro claves, no
 * numérica, o de ancho/alto no positivo. **No lanza**: degenerar es la
 * política, no una excepción.
 */
export function parseEaGeometry(raw: string): ParsedGeometry | null {
  const parts = raw.split(';');
  const values = new Map<string, number>();
  for (const part of parts) {
    if (part.trim() === '') continue;
    const separator = part.indexOf('=');
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = Number(part.slice(separator + 1).trim());
    if (!Number.isFinite(value)) return null;
    values.set(key, value);
  }
  if (values.size < 4) return null;

  const left = values.get('Left');
  const top = values.get('Top');
  const right = values.get('Right');
  const bottom = values.get('Bottom');
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) return null;

  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: left, y: top, width, height };
}

/**
 * Geometría FINAL de un elemento (tarea 3.2): la del archivo si es utilizable,
 * y si no —ausente o degenerada— el auto-layout determinista de D8 para ESE
 * elemento. El llamador convierte `source === 'auto_layout'` en el warning
 * `degenerate_geometry` con `rawGeometry` para el detalle.
 *
 * `xmiId` es `null` solo para la fila de clase de una `AssociationClass` (D7):
 * esa fila no existe en el bloque de extensión, así que siempre se auto-acomoda.
 */
export function layoutFor(extension: EaExtensionIndex, xmiId: string | null, documentIndex: number): LayoutOutcome {
  const raw = xmiId === null ? null : extension.rawGeometryBySubject.get(xmiId) ?? null;
  const geometry = xmiId === null ? undefined : extension.geometryBySubject.get(xmiId);
  if (geometry !== undefined) {
    return { ...geometry, source: 'extension', rawGeometry: null };
  }
  return { ...autoLayoutAt(documentIndex), source: 'auto_layout', rawGeometry: raw };
}

/** Azúcar tipada para quien arma las filas de `element_layouts` (Fase 4). */
export function asLayoutView(outcome: LayoutOutcome): Pick<ElementLayoutView, 'x' | 'y' | 'width' | 'height'> {
  return { x: outcome.x, y: outcome.y, width: outcome.width, height: outcome.height };
}

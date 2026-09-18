import { XMLValidator } from 'fast-xml-parser';
import { XMI_ERROR, type XmiErrorCode } from '@umlive/contracts';
import type { DiagramContent } from '@umlive/contracts';
import type { XmiVersionStrategy } from './xmi-version-strategy';

/**
 * G1 — invariantes propias (D6/D8). Se corren **siempre**, en proceso, antes
 * de la compuerta XSD de la Unidad 3. Es la compuerta que atrapa NUESTROS
 * errores: el XSD no atrapa ninguno de estos (en XMI `type` es `xs:string`,
 * no `xs:IDREF`, así que un `idref` colgado valida y no significa nada).
 *
 * Acá vive también la aserción del contrato de orden (D8): el determinismo
 * byte a byte depende de cuatro `orderBy` que viven en
 * `uml/diagram-content.service.ts`, un archivo de otra rebanada. Desde acá esa
 * dependencia es invisible y no hay runner que la vigile, así que el
 * exportador **afirma lo que asume**. Si mañana alguien quita un `orderBy`,
 * el PRIMER export falla nombrando la colección exacta, en vez de producir un
 * hash distinto la tercera vez, después de un `VACUUM`, durante la corrección.
 */

/** Una fila del alcance, para nombrar las dos partes de una colisión (D2). */
export interface XmiIdRow {
  table: string;
  id: string;
  name: string | null;
}

/**
 * Falla del exportador. `code` es un `XmiErrorCode` del contrato: el service
 * lo traduce a la excepción HTTP con `XMI_ERROR_STATUS`. Las invariantes no
 * importan `@nestjs/common` — son comparaciones puras sobre los bytes.
 */
export class XmiExportError extends Error {
  constructor(
    readonly code: XmiErrorCode,
    message: string,
    readonly rows: readonly XmiIdRow[] = [],
  ) {
    super(message);
    this.name = 'XmiExportError';
  }
}

/** Atributo XML crudo: nombre y valor, tal como quedan en los bytes. */
const ATTRIBUTE = /([A-Za-z_][A-Za-z0-9_:.\-]*)="([^"]*)"/g;

/**
 * Atributos que llevan el `xmi:id` de OTRO elemento como texto plano. En XMI
 * el XSD los declara `xs:string`, así que un valor colgado **valida y no
 * significa nada**: esta es la única compuerta que lo ve. `type` es el caso
 * que D1 existe para prevenir; `general`/`client`/`supplier`/`contract` son
 * los otros cuatro sitios de `idref` del mapeo E.2.
 */
const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set(['xmi:idref', 'type', 'general', 'client', 'supplier', 'contract']);

function attributes(document: string): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = [];
  for (const match of document.matchAll(ATTRIBUTE)) {
    found.push({ name: match[1] ?? '', value: match[2] ?? '' });
  }
  return found;
}

/**
 * D8 — `elements`/`relationships`/`layouts`/`relationshipLayouts` llegan
 * estrictamente crecientes por su clave. Una pasada, comparación de strings,
 * sin costo real. Se afirma **por diagrama**: concatenar los diagramas de un
 * alcance de proyecto rompería la monotonía sin que nada esté mal.
 *
 * Rechazado reordenar defensivamente: enmascara la regresión en vez de
 * exponerla, y duplica una responsabilidad que ya tiene dueño.
 */
export function assertOrderContract(content: DiagramContent): void {
  assertStrictlyIncreasing(content.diagram.id, 'elements', content.elements.map((e) => e.id));
  assertStrictlyIncreasing(content.diagram.id, 'relationships', content.relationships.map((r) => r.id));
  assertStrictlyIncreasing(content.diagram.id, 'layouts', content.layouts.map((l) => l.elementId));
  assertStrictlyIncreasing(content.diagram.id, 'relationshipLayouts', content.relationshipLayouts.map((l) => l.relationshipId));
}

function assertStrictlyIncreasing(diagramId: string, collection: string, keys: readonly string[]): void {
  for (let i = 1; i < keys.length; i += 1) {
    const previous = keys[i - 1] as string;
    const current = keys[i] as string;
    if (current <= previous) {
      throw new XmiExportError(
        XMI_ERROR.ORDER_CONTRACT_VIOLATED,
        `la colección '${collection}' del diagrama ${diagramId} no llega estrictamente creciente por su clave: '${current}' sigue a '${previous}'`,
      );
    }
  }
}

/**
 * G1 sobre los bytes ya emitidos: buena formación, versión/namespace,
 * `idref` colgados y geometría. Trabaja sobre el STRING, no sobre el modelo
 * en memoria — así comprueba lo que el usuario va a recibir, no lo que
 * creíamos haber emitido.
 *
 * Extensión deliberada sobre la tabla de D6: la tabla nombra `xmi:idref`, pero
 * también se validan `type`, `general`, `client`, `supplier` y `contract`, que
 * en XMI llevan el id del referenciado como texto plano. Sin esto, un
 * `Pago.matricula` cuyo tipo fuera una clase suprimida emitiría un `type`
 * colgado que **valida contra el XSD**.
 */
export function assertInvariants(document: string, strategy: XmiVersionStrategy): void {
  const wellFormed = XMLValidator.validate(document);
  if (wellFormed !== true) {
    throw new XmiExportError(
      XMI_ERROR.MALFORMED_OUTPUT,
      `el documento no está bien formado (línea ${wellFormed.err.line}, columna ${wellFormed.err.col}): ${wellFormed.err.msg}`,
    );
  }

  assertVersion(document, strategy);

  const attrs = attributes(document);
  const defined = new Set(attrs.filter((a) => a.name === 'xmi:id').map((a) => a.value));
  for (const attr of attrs) {
    if (REFERENCE_ATTRIBUTES.has(attr.name) && !defined.has(attr.value)) {
      throw new XmiExportError(
        XMI_ERROR.DANGLING_IDREF,
        `${attr.name}="${attr.value}" no resuelve a ningún xmi:id definido en el documento`,
      );
    }
  }

  for (const attr of attrs) {
    if (attr.name === 'geometry' && !isWellFormedGeometry(attr.value)) {
      throw new XmiExportError(XMI_ERROR.MALFORMED_GEOMETRY, `geometry mal formada: '${attr.value}'`);
    }
  }
}

/**
 * E.4: cadena `key=value` separada por `;` con punto y coma FINAL, en píxeles
 * absolutos. Las coordenadas negativas son válidas — el lienzo usa el origen
 * y valores negativos normalmente.
 */
export function isWellFormedGeometry(geometry: string): boolean {
  return /^Left=-?\d+;Top=-?\d+;Right=-?\d+;Bottom=-?\d+;$/.test(geometry);
}

/** Los cuatro atributos del prólogo tienen que coincidir con la estrategia pedida (D4). */
function assertVersion(document: string, strategy: XmiVersionStrategy): void {
  const root = document.match(/^<\?xml[^?]*\?>\r?\n(<[^>]*>)/)?.[1] ?? '';
  const attrs = attributes(root);
  const read = (name: string): string | undefined => attrs.find((a) => a.name === name)?.value;

  const actual = { version: read('xmi:version'), uml: read('xmlns:uml'), xmi: read('xmlns:xmi') };
  if (actual.version !== strategy.token || actual.uml !== strategy.umlNs || actual.xmi !== strategy.xmiNs) {
    throw new XmiExportError(
      XMI_ERROR.VERSION_MISMATCH,
      `el documento declara xmi:version="${actual.version}" con xmlns:uml="${actual.uml}" y xmlns:xmi="${actual.xmi}", pero la estrategia pedida es "${strategy.token}" / "${strategy.umlNs}" / "${strategy.xmiNs}"`,
    );
  }
}

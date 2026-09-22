import {
  absolutePositionOf,
  XMI_EXPORT_NOTE,
  type DiagramContent,
  type ElementKind,
  type UmlRelationshipView,
  type XmiExportNote,
} from '@umlive/contracts';
import { att, type XmiEmitter } from './xmi-emitter';
import type { IdentityMap } from './xmi-identity';

/**
 * Bloque de extensión de Enterprise Architect (E.4, tarea 3.1) — FR-E08 y
 * FR-E09, SC-E15.
 *
 * Tres secciones hermanas bajo `<xmi:Extension>`: `<elements>`, `<connectors>`
 * y `<diagrams>`. La extensión **referencia** identidad (`xmi:idref`), nunca la
 * define: quien define es la sección semántica (E.3 regla 4). La única
 * excepción es `<diagram xmi:id="…">`, que sí define la identidad del diagrama
 * — y por eso el diagrama recibe DOS ids distintos (D1): `UMLIVE_PKG_…` para su
 * `packagedElement` y `UMLIVE_DG_…` para su entrada acá. Reusar uno sería un
 * `xmi:id` duplicado: «un documento que valida y no significa nada».
 *
 * **Geometría**: `key=value` separado por `;` con punto y coma FINAL, en
 * píxeles absolutos, con `Right = x + width` y `Bottom = y + height`. Ancho y
 * alto se derivan, nunca se guardan. Las coordenadas negativas son válidas —
 * el lienzo usa el origen y valores negativos normalmente — y la mitad
 * `isWellFormedGeometry` de G1 las acepta.
 *
 * Desde `element-parent-containment`, `ElementLayout.x/y` en la base es
 * relativo al elemento padre (absoluto solo en la raíz) — EA no modela esa
 * relación, así que el bucle de abajo reconstruye la posición absoluta con
 * `absolutePositionOf` ANTES de llamar a `geometryFor`; nunca se le pasa
 * `layout.x/y` crudo.
 *
 * **`seqno` acuñado**: se numera 1..N en el orden de las filas que la consulta
 * ya trajo (orden determinista, D8). EA usa `seqno` como z-order; el
 * `zIndex` del modelo NO se transporta, y el reporte lo declara con
 * `seqno_synthesized` en vez de dejarlo pasar en silencio.
 *
 * **Apagado**: este módulo no se llama. El interruptor vive en
 * `xmi-export.service.ts` (`includeEaExtension`, default `true`) y, apagado,
 * el documento no contiene NINGUNA ocurrencia de `xmi:Extension` (SC-E15).
 */

export const EA_EXTENDER = 'Enterprise Architect';
export const EA_EXTENDER_ID = '6.5';

/** FR-E09: encendido por defecto. El único lugar que traduce `undefined`. */
export const DEFAULT_INCLUDE_EA_EXTENSION = true;

/**
 * `ElementKind` → `xmi:type` del `<element>` de la extensión. Incluye
 * `COMMENT`, que en la sección semántica se emite como `ownedComment` y acá es
 * un elemento más (`uml:Comment`): EA lo dibuja como nota.
 */
const EA_ELEMENT_TYPE: Readonly<Record<ElementKind, string>> = {
  PACKAGE: 'uml:Package',
  CLASS: 'uml:Class',
  INTERFACE: 'uml:Interface',
  ENUMERATION: 'uml:Enumeration',
  DATATYPE: 'uml:DataType',
  PRIMITIVE_TYPE: 'uml:PrimitiveType',
  COMMENT: 'uml:Comment',
};

/** El `xmi:type` que la extensión declara para una relación en `<elements>` (solo el caso fusionado, D5). */
const EA_RELATIONSHIP_TYPE: Readonly<Record<UmlRelationshipView['kind'], string>> = {
  ASSOCIATION: 'uml:Association',
  GENERALIZATION: 'uml:Generalization',
  DEPENDENCY: 'uml:Dependency',
  USAGE: 'uml:Usage',
  INTERFACE_REALIZATION: 'uml:InterfaceRealization',
};

export interface EaExtensionInput {
  readonly contents: readonly DiagramContent[];
  readonly identity: IdentityMap;
}

export interface EaExtensionOutcome {
  readonly notes: readonly XmiExportNote[];
  readonly elementEntries: number;
  readonly connectorEntries: number;
  readonly diagramEntries: number;
  readonly shapes: number;
}

/**
 * E.4 completa. Se emite DESPUÉS del `uml:Model` (E.1) y antes del cierre de
 * `xmi:XMI`. `notes` es lo único que se agrega al reporte: los conteos son
 * evidencia para la verificación, no un campo del contrato.
 */
export function emitEaExtension(emitter: XmiEmitter, input: EaExtensionInput): EaExtensionOutcome {
  const notes: XmiExportNote[] = [];
  const suppressed = input.identity.suppressedElementIds();

  let elementEntries = 0;
  let connectorEntries = 0;
  let diagramEntries = 0;
  let shapes = 0;

  emitter.open('xmi:Extension', [att('extender', EA_EXTENDER), att('extenderID', EA_EXTENDER_ID)]);

  emitter.open('elements', []);
  for (const content of input.contents) {
    for (const element of content.elements) {
      if (suppressed.has(element.id)) continue;
      const xmiId = input.identity.forElement(element.id);
      if (xmiId === null) continue;
      emitter.subject(xmiId);
      const attrs = [att('xmi:idref', xmiId), att('xmi:type', EA_ELEMENT_TYPE[element.kind])];
      if (element.name !== null) attrs.push(att('name', element.name));
      if (element.stereotype !== null) attrs.push(att('stereotype', element.stereotype));
      attrs.push(att('scope', 'public'));
      emitter.leaf('element', attrs);
      elementEntries += 1;
    }

    // D5: la clase asociación suprimida no tiene identidad propia; la
    // extensión referencia UNA vez el id de la relación fusionada, no dos.
    for (const relationship of content.relationships) {
      if (relationship.associationClassId === null) continue;
      const xmiId = input.identity.forRelationship(relationship.id);
      if (xmiId === null) continue;
      const fused = content.elements.find((element) => element.id === relationship.associationClassId);
      emitter.subject(xmiId);
      const attrs = [att('xmi:idref', xmiId), att('xmi:type', 'uml:AssociationClass')];
      const fusedName = fused === undefined ? relationship.name : fused.name;
      if (fusedName !== null) attrs.push(att('name', fusedName));
      if (fused !== undefined && fused.stereotype !== null) attrs.push(att('stereotype', fused.stereotype));
      attrs.push(att('scope', 'public'));
      emitter.leaf('element', attrs);
      elementEntries += 1;
    }
  }
  emitter.close('elements');

  emitter.open('connectors', []);
  for (const content of input.contents) {
    for (const relationship of content.relationships) {
      const xmiId = input.identity.forRelationship(relationship.id);
      if (xmiId === null) continue;
      emitter.subject(xmiId);
      emitter.open('connector', [att('xmi:idref', xmiId)]);
      emitter.leaf('source', [att('xmi:idref', input.identity.requireElement(relationship.sourceElementId, `la relación ${relationship.id}`))]);
      emitter.leaf('target', [att('xmi:idref', input.identity.requireElement(relationship.targetElementId, `la relación ${relationship.id}`))]);
      emitter.close('connector');
      connectorEntries += 1;
    }
  }
  emitter.close('connectors');

  emitter.open('diagrams', []);
  for (const content of input.contents) {
    const diagramId = input.identity.diagramEntryId(content.diagram.id);
    emitter.subject(diagramId);
    emitter.open('diagram', [att('xmi:id', diagramId), att('name', content.diagram.name)]);
    emitter.open('elements', []);

    // `element-parent-containment`: `layout.x/y` pasó a ser relativo al
    // elemento padre (absoluto solo en la raíz) — EA no conoce esa relación,
    // así que la geometría que exporta tiene que seguir siendo absoluta.
    // Índices por diagrama (no globales: dos `content` pueden repetir ids de
    // `elementId` entre diagramas distintos... en realidad no, son UUID, pero
    // igual conviene un índice propio por diagrama para no arrastrar entradas
    // de otro `content` a `absolutePositionOf`).
    const elementsById: Record<string, (typeof content.elements)[number]> = {};
    for (const element of content.elements) elementsById[element.id] = element;
    const layoutsById: Record<string, (typeof content.layouts)[number]> = {};
    for (const layout of content.layouts) layoutsById[layout.elementId] = layout;

    let seqno = 0;
    for (const layout of content.layouts) {
      // Un elemento suprimido (D5) o sin identidad no tiene forma: su
      // geometría pertenece a la clase que la fusión eliminó del documento.
      if (suppressed.has(layout.elementId)) continue;
      const subject = input.identity.forElement(layout.elementId);
      if (subject === null) continue;
      seqno += 1;
      // `?? layout`: si a algún antepasado le faltara el layout (dato
      // inconsistente, nunca debería pasar con `layoutsById` construido
      // arriba de la MISMA lista), se exporta con la coordenada cruda en vez
      // de reventar el export — mejor una forma mal ubicada que ninguna.
      const absolute = absolutePositionOf(layout.elementId, elementsById, layoutsById) ?? layout;
      emitter.leaf('element', [
        att('geometry', geometryFor(absolute.x, absolute.y, layout.width, layout.height)),
        att('subject', subject),
        att('seqno', seqno),
      ]);
      shapes += 1;
    }

    emitter.close('elements');
    emitter.close('diagram');
    diagramEntries += 1;
    notes.push({
      code: XMI_EXPORT_NOTE.SEQNO_SYNTHESIZED,
      subjectId: diagramId,
      detail: `el diagrama '${content.diagram.name}' recibió seqno 1..${seqno} en orden de documento; el zIndex del modelo no se transporta`,
    });
  }
  emitter.close('diagrams');

  emitter.close('xmi:Extension');

  return { notes, elementEntries, connectorEntries, diagramEntries, shapes };
}

/**
 * E.4: `Left=290;Top=50;Right=380;Bottom=200;` — `Right = x + width`,
 * `Bottom = y + height`, punto y coma final SIEMPRE. Es el ÚNICO lugar que
 * arma la cadena; G1 la vuelve a leer de los bytes.
 */
export function geometryFor(x: number, y: number, width: number, height: number): string {
  return `Left=${x};Top=${y};Right=${x + width};Bottom=${y + height};`;
}

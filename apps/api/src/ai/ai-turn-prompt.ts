import type { DiagramContent, UmlElementView, UmlFeatureView } from '@umlive/contracts';
import { AI_TURN_TOOLS } from './ai-tools';
import { elementAlias, featureAlias, relationshipAlias } from './ai-turn-plan';

/**
 * El prompt de sistema del turno (M6, rebanada 2/4 — `ai-text-instructions`).
 *
 * Tres cosas, y ninguna más (D3, FR-D20b, SC-D11):
 *
 * 1. **Identificadores textuales (FR-D20b)**: los nombres que produce el modelo
 *    se guardan EXACTAMENTE como los devolvió, tildes incluidas. El prompt
 *    prohíbe traducirlos y transliterarlos, que es el defecto que PO-4 detectó
 *    entre `Dirección` y `Direccion`.
 * 2. **No inventar (SC-D11)**: lo que no está en la foto del diagrama se
 *    reporta en el texto final, nunca se crea ni se referencia. Los UUID no
 *    llegan al modelo, así que tampoco los puede inventar: ve alias.
 * 3. **La foto serializada**: `e:3 CLASS Cliente {f:7 nombre: String}`, corta y
 *    estable, con la MISMA numeración que resuelve el plan.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Arma el prompt de sistema completo para un turno. */
export function buildSystemPrompt(snapshot: DiagramContent): string {
  return [
    'Sos el asistente de modelado UML de uMLive. Convertís una instrucción en lenguaje natural en llamadas a herramientas sobre el diagrama abierto.',
    '',
    '## Cómo trabajás',
    `- Usá solo estas herramientas: ${AI_TURN_TOOLS.map((tool) => tool.name).join(', ')}.`,
    '- Una instrucción que no se puede mapear a ninguna herramienta se responde con texto, sin inventar operaciones.',
    '- Pedí todas las llamadas que necesites en la menor cantidad de respuestas; una respuesta puede traer varias.',
    '- Si una parte de la instrucción no se puede cumplir, decilo en el texto final. No la apliques a medias ni en silencio.',
    '',
    '## Referencias',
    '- En la foto del diagrama cada cosa tiene un alias: `e:N` elementos, `f:N` atributos u operaciones, `r:N` relaciones.',
    '- Cuando una herramienta necesita referirse a algo que ya existe, usá su alias; nunca un id ni un UUID.',
    '- Lo que este turno crea queda disponible como `new:N`, en el orden en que lo creaste. Podés usarlo en las llamadas siguientes.',
    '- Si el alias que necesitás no aparece en la foto, la clase o el atributo NO existe: decilo en el texto final, no lo inventes.',
    '',
    '## Nombres (regla dura)',
    '- Escribí cada nombre — clase, atributo, operación, parámetro y relación — EXACTAMENTE como lo dijo la persona: en español, con sus tildes y su ortografía.',
    '- Nunca traduzcas un identificador y nunca lo transliteres. `Dirección` lleva tilde; `códigoPostal` no se convierte en `codigoPostal`.',
    '- Tampoco cambies mayúsculas ni espacios para "normalizar": respetá el texto original.',
    `- Cada nombre tiene como máximo 120 caracteres.`,
    '',
    '## Herramientas',
    ...AI_TURN_TOOLS.map((tool) => `- \`${tool.name}\`: ${tool.description}`),
    '',
    '## Foto del diagrama',
    'Formato: `e:N TIPO Nombre {f:M nombre: tipo}` para elementos y sus miembros, `r:N TIPO e:origen -> e:destino` para relaciones.',
    describeDiagram(snapshot),
  ].join('\n');
}

/**
 * Serialización corta de la foto (D3). Legible para el modelo y estable entre
 * iteraciones del mismo turno: el orden de las nueve colecciones ya es parte
 * del contrato de `DiagramContentService`.
 */
export function describeDiagram(snapshot: DiagramContent): string {
  const lines: string[] = [];

  snapshot.elements.forEach((element, index) => {
    const name = element.name ?? '(sin nombre)';
    const members = snapshot.features.filter((feature) => feature.ownerId === element.id);
    const traits: string[] = [];
    if (element.isAbstract) traits.push('abstracto');
    if (element.stereotype !== null && element.stereotype.length > 0) {
      traits.push(`«${element.stereotype}»`);
    }
    if (element.body !== null && element.body.length > 0) traits.push(element.body);

    const header = `${elementAlias(index)} ${element.kind} ${name}${traits.length > 0 ? ` ${traits.join(' ')}` : ''}`;
    if (members.length === 0) {
      lines.push(header);
      return;
    }
    const rendered = members
      .map((feature) => `${featureAlias(snapshot.features.indexOf(feature))} ${describeFeature(snapshot, feature)}`)
      .join(', ');
    lines.push(`${header} {${rendered}}`);
  });

  snapshot.relationships.forEach((relationship, index) => {
    const source = elementAliasOf(snapshot, relationship.sourceElementId);
    const target = elementAliasOf(snapshot, relationship.targetElementId);
    const name = relationship.name === null || relationship.name.length === 0 ? '' : ` "${relationship.name}"`;
    lines.push(`${relationshipAlias(index)} ${relationship.kind} ${source} -> ${target}${name}`);
  });

  return lines.length === 0 ? '(el diagrama está vacío)' : lines.join('\n');
}

function describeFeature(snapshot: DiagramContent, feature: UmlFeatureView): string {
  const type = featureTypeName(snapshot, feature);
  const multiplicity = formatMultiplicity(feature.lowerBound, feature.upperBound);
  const suffix = multiplicity === '1' ? '' : `[${multiplicity}]`;
  if (feature.kind === 'OPERATION') {
    const parameters = snapshot.parameters
      .filter((parameter) => parameter.operationId === feature.id)
      .map((parameter) => `${parameter.name}${typeSuffix(snapshot, parameter.typeName, parameter.typeElementId)}`)
      .join(', ');
    return `${feature.name}(${parameters})${type === null ? '' : `: ${type}`}`;
  }
  return `${feature.name}${type === null ? '' : `: ${type}`}${suffix}`;
}

function typeSuffix(snapshot: DiagramContent, typeName: string | null, typeElementId: string | null): string {
  const name = typeName ?? (typeElementId === null ? null : (nameOf(snapshot, typeElementId) ?? null));
  return name === null ? '' : `: ${name}`;
}

function featureTypeName(snapshot: DiagramContent, feature: UmlFeatureView): string | null {
  if (feature.typeName !== null && feature.typeName.length > 0) return feature.typeName;
  if (feature.typeElementId !== null) return nameOf(snapshot, feature.typeElementId) ?? null;
  return null;
}

function formatMultiplicity(lower: number, upper: number | null): string {
  const top = upper === null ? '*' : String(upper);
  return lower === upper ? top : `${lower}..${top}`;
}

function elementAliasOf(snapshot: DiagramContent, id: string): string {
  const index = snapshot.elements.findIndex((element) => element.id === id);
  return index < 0 ? id : elementAlias(index);
}

function nameOf(snapshot: DiagramContent, id: string): string | null {
  const element: UmlElementView | undefined = snapshot.elements.find((candidate) => candidate.id === id);
  if (element !== undefined) return element.name ?? null;
  const feature = snapshot.features.find((candidate) => candidate.id === id);
  return feature?.name ?? null;
}

import type { AiImageMode, DiagramContent, UmlElementView, UmlFeatureView } from '@umlive/contracts';
import { AI_TURN_TOOLS } from './ai-tools';
import type { ToolDefinition } from './providers/llm-provider.interface';
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
 * 2. **No inventar (SC-D11)**: lo que no está en el estado del diagrama se
 *    reporta en el texto final, nunca se crea ni se referencia. Los UUID no
 *    llegan al modelo, así que tampoco los puede inventar: ve alias.
 * 3. **El estado serializado**: `e:3 CLASS Cliente {f:7 nombre: String}`, corto
 *    y estable, con la MISMA numeración que resuelve el plan.
 *
 * ── Defecto corregido (2026-09-21) ─────────────────────────────────────────
 * Este bloque se llamaba «la foto del diagrama» y las Referencias hablaban de
 * «la foto». En un turno de IMAGEN la palabra es correcta y hay una foto real;
 * en uno de TEXTO no hay ninguna, así que el modelo la leía en sentido literal
 * y contestaba pidiendo que le mandaran la imagen — con el estado completo
 * delante, serializado, en ese mismo prompt. Síntoma reproducido: «no tengo
 * ninguna foto del diagrama a la vista, así que no puedo confirmar si existe la
 * clase Cita», dicho por un modelo que en la misma respuesta usaba la palabra
 * «alias», que sale de acá y de ningún otro lado.
 *
 * Regla que deja el arreglo: **«foto» se reserva para la fotografía de verdad**
 * (`imageInstructions`, y `nx`/`ny` en `ai-tools.ts`). El contenido del diagrama
 * es «el estado del diagrama», y se dice explícitamente que ya está en el
 * prompt como texto. No renombrar esto de vuelta por simetría con el turno de
 * imagen: la simetría era el defecto.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Cómo se arma el prompt de sistema de un turno. */
export interface SystemPromptOptions {
  /** Las herramientas visibles; por defecto, las siete del turno de texto (D5). */
  readonly tools?: readonly ToolDefinition[];
  /** Presente solo en un turno de imagen: agrega las instrucciones de la foto (D5). */
  readonly imageMode?: AiImageMode;
}

/** Arma el prompt de sistema completo para un turno. */
export function buildSystemPrompt(snapshot: DiagramContent, options: SystemPromptOptions = {}): string {
  const tools = options.tools ?? AI_TURN_TOOLS;
  return [
    'Sos el asistente de modelado UML de uMLive. Convertís una instrucción en lenguaje natural en llamadas a herramientas sobre el diagrama abierto.',
    '',
    '## Cómo trabajás',
    `- Usá solo estas herramientas: ${tools.map((tool) => tool.name).join(', ')}.`,
    '- Una instrucción que no se puede mapear a ninguna herramienta se responde con texto, sin inventar operaciones.',
    '- Pedí todas las llamadas que necesites en la menor cantidad de respuestas; una respuesta puede traer varias.',
    '- Si una parte de la instrucción no se puede cumplir, decilo en el texto final. No la apliques a medias ni en silencio.',
    '',
    '## Referencias',
    '- Más abajo, en «Estado actual del diagrama», tenés el contenido COMPLETO del diagrama abierto, ya serializado como texto. Es lo que hay ahora mismo en el lienzo: leelo de ahí y trabajá sobre eso.',
    '- No necesitás ninguna imagen ni captura para saber qué existe, y nunca pidas una: el estado ya está en este mensaje.',
    '- En ese estado cada cosa tiene un alias: `e:N` elementos, `f:N` atributos u operaciones, `r:N` relaciones.',
    '- La numeración EMPIEZA EN 1, no en 0: el primer elemento es `e:1`. No existe `e:0`.',
    '- Copiá el alias TAL CUAL aparece en el estado; no lo deduzcas ni lo renumeres.',
    '- Preferí siempre el alias. Si mandás el nombre exacto («Cita»), el servidor lo resuelve igual, pero el nombre falla cuando dos cosas se llaman parecido y el alias nunca.',
    '- Cuando una herramienta necesita referirse a algo que ya existe, usá su alias; nunca un id ni un UUID.',
    '- Lo que este turno crea queda disponible como `new:N`, en el orden en que lo creaste. Podés usarlo en las llamadas siguientes.',
    '- Si el alias que necesitás no aparece en el estado del diagrama, la clase o el atributo NO existe: decilo en el texto final, no lo inventes.',
    '',
    '## Nombres (regla dura)',
    '- Escribí cada nombre — clase, atributo, operación, parámetro y relación — EXACTAMENTE como lo dijo la persona: en español, con sus tildes y su ortografía.',
    '- Nunca traduzcas un identificador y nunca lo transliteres. `Dirección` lleva tilde; `códigoPostal` no se convierte en `codigoPostal`.',
    '- Tampoco cambies mayúsculas ni espacios para "normalizar": respetá el texto original.',
    `- Cada nombre tiene como máximo 120 caracteres.`,
    ...(options.imageMode === undefined ? [] : imageInstructions(options.imageMode)),
    '',
    '## Herramientas',
    ...tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`),
    '',
    '## Estado actual del diagrama',
    'Esto es lo que el diagrama contiene AHORA. Es la fuente de verdad de este turno; no hace falta nada más para leerlo.',
    'Formato: `e:N TIPO Nombre {f:M nombre: tipo}` para elementos y sus miembros, `r:N TIPO e:origen -> e:destino` para relaciones.',
    describeDiagram(snapshot),
  ].join('\n');
}

/**
 * Las instrucciones del turno de imagen (D5, tarea 3.3). Cuatro reglas, y cada
 * una existe por un modo de falla concreto:
 *
 * 1. **Leer TODAS las clases**: el usuario manda una foto, no un inventario. Si
 *    el prompt no lo dice, el modelo dibuja las dos clases que nombra el pie de
 *    foto y el resto de la pizarra se pierde.
 * 2. **Agrupar las llamadas**: la foto se reenvía ENTERA en cada iteración, así
 *    que una llamada por respuesta se paga seis veces.
 * 3. **Posición normalizada del centro**: el modelo ve la foto, no el lienzo.
 *    Un `x`/`y` inventado en píxeles del lienzo es una posición que no significa
 *    nada (D7); `nx`/`ny` en `0..1` es lo único que puede estimar.
 * 4. **`low` ante la duda**: es la válvula que el humano revisa (PO-2). Un dato
 *    adivinado con confianza alta se aplica sin que nadie lo mire.
 */
function imageInstructions(mode: AiImageMode): string[] {
  const framing =
    mode === 'create'
      ? '- La foto es el diagrama COMPLETO: creá todas las clases que se vean, con sus atributos y relaciones.'
      : '- Estás AGREGANDO a un diagrama que ya existe: creá solo lo que la foto aporta. Nunca borres ni muevas lo que ya está; para algo que ya existe, usá su alias en vez de duplicarlo.';

  return [
    '',
    '## Foto de referencia',
    framing,
    '- Leé TODAS las clases visibles en la foto, no solo las que nombra la instrucción escrita.',
    '- Pedí todas las llamadas en la MENOR cantidad de respuestas posible: la foto se reenvía en cada vuelta y cada vuelta se paga.',
    '- Ubicá cada clase que creás con `apply_layout` sobre su `new:N`, pasando `nx` y `ny`: la posición NORMALIZADA del CENTRO de esa clase en la foto, de 0 a 1. `(0,0)` es la esquina superior izquierda y `(1,1)` la inferior derecha. Es una estimación: el servidor la convierte al lienzo.',
    '- Si dudás de algo —una multiplicidad que no se lee, un nombre que no distinguís, una relación que no estás seguro de ver— marcá `confidence: "low"` y explicá el motivo en `note`. La persona lo revisa y decide; un dato dudoso aplicado en silencio es peor que un dato dudoso destildado.',
    '- Lo que no se pueda leer o interpretar decilo en el TEXTO FINAL, con tus palabras. No lo inventes ni lo apliques a medias.',
  ];
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

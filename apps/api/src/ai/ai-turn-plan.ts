import {
  absolutePositionOf,
  LOCK_REQUIREMENTS,
  type AiImageMode,
  type AiPreviewItem,
  type AiPreviewLowReason,
  type AiTurnAppliedOp,
  type AiTurnNotAppliedCall,
  type AggregationKind,
  type DiagramContent,
  type ElementKind,
  type ElementLayoutView,
  type OperationType,
  type PayloadFor,
  type Rect,
  type RelationshipKind,
  type UmlElementView,
  type Visibility,
} from '@umlive/contracts';
import { MAX_OPS_PER_TURN } from './ai-tools';

/**
 * El plan del turno (M6, rebanada 2/4 — `ai-text-instructions`, diseño D3).
 *
 * ── El modelo planifica y el pipeline aplica ───────────────────────────────
 *
 * Este archivo NO escribe nada y NO abre ninguna transacción: construye una
 * lista de `PlannedOp` a partir de la foto del diagrama (`DiagramContent`) más
 * lo que el turno ya planificó. La aplicación de ese plan (una sola transacción
 * y un solo `FOR UPDATE`) es de `applyBatch`, en la rebanada siguiente.
 *
 * ── Referencias: `e:/f:/r:` para lo que existe, `new:N` para lo que se crea ─
 *
 * Los UUID nunca llegan al modelo: la foto se serializa con alias cortos
 * (`e:3 CLASS Cliente {f:7 nombre: String}`). Al planificar, cada alias se
 * resuelve a su UUID real contra la foto; un alias desconocido se rechaza como
 * resultado de herramienta, nunca se inventa (SC-D11). Lo que el turno crea
 * queda como `new:N` y se resuelve recién dentro de la transacción.
 *
 * ── La sustitución va campo por campo, NUNCA por regex ─────────────────────
 *
 * `REF_FIELDS` dice, por tipo de operación, qué campos llevan referencias. Un
 * reemplazo por regex sobre todo el payload cambiaría una clase que se llame
 * literalmente `new:1`: texto del usuario decidiendo una rama. La sustitución
 * recorre esos caminos y solo esos (D3).
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Ancho y alto por defecto de un elemento nuevo (espeja `InsertPalette.tsx`). */
export const DEFAULT_ELEMENT_WIDTH = 180;
export const DEFAULT_ELEMENT_HEIGHT = 90;
const PACKAGE_WIDTH = 260;
const PACKAGE_HEIGHT = 160;
const COMMENT_WIDTH = 180;
const COMMENT_HEIGHT = 80;

/** Origen del recuadro nuevo y separaciones, iguales al criterio de `ai-image-input`. */
const ORIGIN_X = 40;
const ORIGIN_Y = 40;
const COLUMN_GAP = 160;
const ROW_GAP = 40;

/** Tope de caracteres de todo nombre creado, impuesto por los DTOs compartidos. */
export const MAX_NAME_LENGTH = 120;

/** De qué tabla es una referencia. Determina qué herramientas la aceptan. */
export type RefKind = 'element' | 'feature' | 'relationship';

/**
 * Una operación planificada. Unión discriminada por `type`: `op.type` estrecha
 * `op.payload` al payload real de esa operación.
 *
 * `produces` es el `new:N` que esta operación crea, o `null`. Después de
 * aplicarla, `applyBatch` guarda `refMap.set(op.produces, autoritativo.id)`.
 */
export type PlannedOp = {
  [T in OperationType]: {
    readonly type: T;
    readonly payload: PayloadFor<T>;
    readonly produces: string | null;
  };
}[OperationType];

/** Motivos de una llamada no aplicada. Van al resumen (FR-D25). */
export type NotAppliedReason =
  | 'invalid_input'
  | 'unknown_alias'
  | 'alias_kind_mismatch'
  | 'unknown_tool'
  | 'nothing_to_update'
  | 'field_not_applicable'
  | 'invalid_multiplicity'
  | 'aggregation_requires_association'
  | 'self_generalization'
  | 'op_limit_reached'
  | 'layout_target_not_planned'
  | 'image_turn_create_only';

/**
 * Opciones del plan (D5, D6, D7).
 *
 * `image` cambia tres cosas: expone solo las herramientas de creación, afloja
 * la validación de multiplicidad (el servidor marca el ítem como dudoso en vez
 * de tirarlo) y hace que `apply_layout` reciba el centro NORMALIZADO de la foto.
 * `opLimit` es el tope de operaciones del turno, que depende del modo de entrada.
 */
export interface TurnPlanOptions {
  readonly image?: boolean;
  readonly opLimit?: number;
}

/** La posición normalizada (0..1) del centro de una clase en la foto (D7). */
interface PlannedPosition {
  readonly nx: number;
  readonly ny: number;
}

/** Lo que produjo UNA llamada aceptada: sus operaciones y lo que la vista previa lista. */
interface PlannedItem {
  readonly ops: PlannedOp[];
  readonly applied: AiTurnAppliedOp[];
}

export type ToolCallOutcome =
  | {
      readonly ok: true;
      /** Texto que se le devuelve al modelo como resultado de herramienta. */
      readonly result: string;
      readonly ops: readonly PlannedOp[];
    }
  | {
      readonly ok: false;
      readonly result: string;
      readonly error: NotAppliedReason;
    };

/**
 * Campos de un payload que llevan referencias, por tipo de operación. `D3`.
 *
 * El camino `ends[].elementId` no es expresable con `keyof` porque es anidado,
 * y por eso se admite aparte: el recorrido soporta `[]` para arrays.
 */
type RefStringKeys<P> = {
  [K in keyof P]-?: NonNullable<P[K]> extends string ? K : never;
}[keyof P];

type RefPath<T extends OperationType> = RefStringKeys<PayloadFor<T>> | 'ends[].elementId';

export const REF_FIELDS: { [T in OperationType]?: readonly RefPath<T>[] } = {
  'element.create': ['parentId'],
  'element.rename': ['id'],
  'element.setAbstract': ['id'],
  'element.move': ['id'],
  'element.delete': ['id'],
  'feature.create': ['ownerId', 'typeElementId'],
  'feature.update': ['id', 'typeElementId'],
  'feature.delete': ['id'],
  'parameter.add': ['operationId', 'typeElementId'],
  'relationship.create': ['sourceElementId', 'targetElementId', 'ends[].elementId'],
  'relationship.rename': ['id'],
  'relationship.delete': ['id'],
  'relationshipEnd.setMultiplicity': ['relationshipId'],
  'relationshipEnd.setAggregation': ['relationshipId'],
};

/**
 * Sustituye referencias campo por campo, sobre los caminos de `REF_FIELDS`.
 *
 * `resolve` devuelve el valor nuevo para una referencia, o `undefined` para
 * dejarla como está (el `new:N` que todavía no existe, al planificar) o para
 * ignorarla (texto que no es una referencia). Genérica a propósito: la usa el
 * plan al fijar los `new:N` de una misma llamada y la usa `applyBatch` al
 * enlazar los `new:N` contra los ids autoritativos.
 */
export function substituteRefFields<T extends OperationType>(
  type: T,
  payload: PayloadFor<T>,
  resolve: (reference: string) => string | undefined,
): PayloadFor<T> {
  const paths = REF_FIELDS[type];
  if (paths === undefined) return payload;
  const clone: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const path of paths) {
    replaceAtPath(clone, String(path).split('.'), resolve);
  }
  return clone as PayloadFor<T>;
}

function replaceAtPath(
  node: Record<string, unknown>,
  segments: readonly string[],
  resolve: (reference: string) => string | undefined,
): void {
  const head = segments[0];
  if (head === undefined) return;
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  const value = node[key];

  if (isArray) {
    if (!Array.isArray(value) || segments.length === 1) return;
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        replaceAtPath(item as Record<string, unknown>, segments.slice(1), resolve);
      }
    }
    return;
  }

  if (segments.length === 1) {
    if (typeof value === 'string') {
      const next = resolve(value);
      if (next !== undefined) node[key] = next;
    }
    return;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    replaceAtPath(value as Record<string, unknown>, segments.slice(1), resolve);
  }
}

/**
 * Los valores de los caminos de `REF_FIELDS` de un payload, en orden de tabla.
 * Los usa `referencedIds()` (D8) y los `dependsOn` de los ítems (D6): son las
 * mismas referencias que `substituteRefFields` reemplaza, leídas en vez de
 * escritas.
 */
function collectRefValues<T extends OperationType>(type: T, payload: PayloadFor<T>): string[] {
  const paths = REF_FIELDS[type];
  if (paths === undefined) return [];
  const values: string[] = [];
  for (const path of paths) {
    readAtPath(payload as unknown as Record<string, unknown>, String(path).split('.'), values);
  }
  return values;
}

function readAtPath(node: Record<string, unknown>, segments: readonly string[], out: string[]): void {
  const head = segments[0];
  if (head === undefined) return;
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  const value = node[key];

  if (isArray) {
    if (!Array.isArray(value) || segments.length === 1) return;
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        readAtPath(item as Record<string, unknown>, segments.slice(1), out);
      }
    }
    return;
  }

  if (segments.length === 1) {
    if (typeof value === 'string') out.push(value);
    return;
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    readAtPath(value as Record<string, unknown>, segments.slice(1), out);
  }
}

/**
 * El cierre de exclusiones (D6, PO-2): todo ítem que depende, directa o
 * indirectamente, de uno excluido también queda fuera.
 *
 * **Una sola pasada** alcanza porque `dependsOn` SIEMPRE apunta hacia atrás y
 * los ítems vienen en orden de plan: cuando el recorrido llega a un ítem, todos
 * sus dependencias ya se evaluaron. Trasladar esto a un grafo con una pila no
 * sería más correcto, sería más código.
 *
 * La corre el CLIENTE para mostrar el efecto al instante y la vuelve a correr
 * el SERVIDOR sobre su propio plan en cada confirmación: la lista de excluidos
 * que llega del cliente es una pista, jamás la verdad (FR-D24).
 */
export function excludeClosure(items: readonly AiPreviewItem[], seed: Iterable<number>): Set<number> {
  const out = new Set<number>(seed);
  for (const item of items) {
    if (item.dependsOn.some((dependency) => out.has(dependency))) out.add(item.index);
  }
  return out;
}

/** Id inerte de una creación: el servidor genera el autoritativo y lo devuelve. */
const INERT_ID = 'pending';

/** Las herramientas que un turno de imagen puede aceptar (D5, PO-3). */
const IMAGE_TOOL_NAMES = new Set<string>([
  'create_class',
  'add_attribute',
  'add_operation',
  'create_relationship',
  'apply_layout',
]);

/** Tipo de ítem de cada herramienta de creación (D6). `apply_layout` no produce ítem. */
const ITEM_KINDS: Partial<Record<string, AiPreviewItem['kind']>> = {
  create_class: 'class',
  add_attribute: 'attribute',
  add_operation: 'operation',
  create_relationship: 'relationship',
};

/**
 * Un nombre sin nada fuera de `[\p{L}\p{N}_]` es el caso normal; cualquier otro
 * carácter —un espacio, una barra, un emoji— deja el ítem en `low` con
 * `name_suspicious` (D5). El ítem NO se descarta: entra, destildado.
 */
const SAFE_NAME = /^[\p{L}\p{N}_]+$/u;

/** Marcador interno de una referencia al `new:N` que produce otra op de la misma llamada. */
const SELF_PREFIX = '\u0000self:';

function selfRef(index: number): string {
  return `${SELF_PREFIX}${index}`;
}

function selfRefIndex(reference: string): number | null {
  if (!reference.startsWith(SELF_PREFIX)) return null;
  const raw = reference.slice(SELF_PREFIX.length);
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alias de la foto
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedRef {
  readonly kind: RefKind;
  readonly token: string;
}

type AliasLookup = { readonly ok: true } & ResolvedRef;

const ALIAS_RE = /^(e|f|r|new):(\d+)$/;

function looksLikeAlias(value: string): boolean {
  return /^(e|f|r|new):/.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Borradores de operación
// ─────────────────────────────────────────────────────────────────────────────

interface DraftOp {
  readonly type: OperationType;
  readonly payload: Record<string, unknown>;
  readonly produces: RefKind | null;
}

type DraftResult = { readonly ops: readonly DraftOp[] } | DraftError;
interface DraftError {
  readonly error: NotAppliedReason;
  readonly message: string;
}

function draftError(error: NotAppliedReason, message: string): DraftError {
  return { error, message };
}

function isDraftError(value: unknown): value is DraftError {
  return typeof value === 'object' && value !== null && 'error' in value;
}

type Validator = (input: Record<string, unknown>, plan: TurnPlan) => DraftResult;

/** Un alias de la foto, por índice 0-based. La MISMA numeración que usa `TurnPlan`. */
export function elementAlias(index: number): string {
  return `e:${index + 1}`;
}

export function featureAlias(index: number): string {
  return `f:${index + 1}`;
}

export function relationshipAlias(index: number): string {
  return `r:${index + 1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// El plan
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plan en memoria de un turno: la foto, los alias resueltos, y los `PlannedOp`
 * que el modelo fue validando. Cada llamada a herramienta pasa por `addToolCall`
 * y **nunca** toca la base.
 */
export class TurnPlan {
  /** Lo que se aplicó y no se aplicó, tal como lo reporta el resumen (FR-D25). */
  readonly notApplied: AiTurnNotAppliedCall[] = [];

  private readonly refs = new Map<string, ResolvedRef>();
  private readonly planned: PlannedOp[] = [];
  private newCount = 0;

  /** Modo imagen (D5, D7): validación indulgente y posiciones normalizadas. */
  private readonly image: boolean;
  /** Tope de operaciones del turno; depende del modo de entrada (D5). */
  private readonly opLimit: number;

  /** Un ítem por llamada aceptada (D6), en orden de plan. */
  private readonly itemDrafts: AiPreviewItem[] = [];
  /** Lo que produjo cada ítem, alineado por índice con `itemDrafts`. */
  private readonly itemProduced: PlannedItem[] = [];
  /** `new:N` → índice del ítem que lo creó. Los `dependsOn` se resuelven con esto. */
  private readonly itemOfLabel = new Map<string, number>();
  /** El centro normalizado que el modelo declaró para cada `new:N` (D7). */
  private readonly imagePositions = new Map<string, PlannedPosition>();
  /** Marcas de baja confianza que dejó el validador de la llamada en curso. */
  private marks: AiPreviewLowReason[] = [];

  /**
   * Índices de la foto por id (`element-parent-containment`): los arma UNA
   * vez el constructor, y los usan `nextCreateLayout` (hermanos del mismo
   * padre) y `absolutePositionOfToken`/`storedPositionFor` (reconstruir o
   * convertir una posición absoluta contra la cadena de `parentId`). Sin
   * esto, cada llamada tendría que recorrer `snapshot.elements`/
   * `snapshot.layouts` entero — barato para un turno, pero repetido sin
   * necesidad si dos herramientas del mismo turno tocan geometría.
   */
  private readonly elementsById: Record<string, UmlElementView> = {};
  private readonly layoutsById: Record<string, ElementLayoutView> = {};

  constructor(readonly snapshot: DiagramContent, options: TurnPlanOptions = {}) {
    this.image = options.image === true;
    this.opLimit = options.opLimit ?? MAX_OPS_PER_TURN;
    snapshot.elements.forEach((element, index) => {
      this.refs.set(`e:${index + 1}`, { kind: 'element', token: element.id });
      this.elementsById[element.id] = element;
    });
    snapshot.features.forEach((feature, index) => {
      this.refs.set(`f:${index + 1}`, { kind: 'feature', token: feature.id });
    });
    snapshot.relationships.forEach((relationship, index) => {
      this.refs.set(`r:${index + 1}`, { kind: 'relationship', token: relationship.id });
    });
    snapshot.layouts.forEach((layout) => {
      this.layoutsById[layout.elementId] = layout;
    });
  }

  /** ¿Es el turno de la foto? (D5.) */
  get imageMode(): boolean {
    return this.image;
  }

  /** Las operaciones planificadas, en el orden en que se aplicarán. */
  get ops(): readonly PlannedOp[] {
    return this.planned;
  }

  /** La foto con la que se planificó: los alias se resuelven contra ella, no contra la base. */
  get diagram(): DiagramContent {
    return this.snapshot;
  }

  /**
   * El único camino por el que una llamada del modelo entra al plan.
   *
   * Valida contra el plan (no contra la base), aplica el tope de operaciones y
   * recién entonces registra el `new:N` de lo que crea. Un error vuelve como
   * resultado de herramienta y **no** deja rastro en el plan (FR-D05, SC-D03).
   */
  addToolCall(toolName: string, input: unknown): ToolCallOutcome {
    this.marks = [];
    const validator = VALIDATORS[toolName];
    if (validator === undefined) {
      return this.reject(toolName, 'unknown_tool', `La herramienta "${toolName}" no existe.`);
    }
    // En modo imagen la lista de herramientas es la del proveedor, pero un
    // modelo puede pedir igual una que no está: acá se corta, porque una
    // `update_element` aceptada rompería PO-3 (el turno de imagen solo crea).
    if (this.image && !IMAGE_TOOL_NAMES.has(toolName)) {
      return this.reject(
        toolName,
        'unknown_tool',
        `La herramienta "${toolName}" no está disponible en un turno de imagen.`,
      );
    }

    const record = isRecord(input) ? input : {};
    const result = validator(record, this);
    if (isDraftError(result)) return this.reject(toolName, result.error, result.message);

    if (this.planned.length + result.ops.length > this.opLimit) {
      return this.reject(
        toolName,
        'op_limit_reached',
        `El plan ya tiene ${this.planned.length} operaciones y el tope es ${this.opLimit}. ` +
          'No se planificó nada de esta llamada; el resto del turno sigue igual.',
      );
    }

    const committed = this.commit(result.ops);
    this.planned.push(...committed);
    this.buildItem(toolName, record, committed);
    return {
      ok: true,
      result:
        committed.length === 0
          ? `Sin operaciones nuevas: la llamada se plegó en lo que el turno ya tenía planificado.`
          : `Planificado: ${committed.map((op) => this.describe(op)).join('; ')}.`,
      ops: committed,
    };
  }

  /**
   * Resuelve una referencia del modelo contra el estado o contra lo que el
   * turno ya planificó. Una referencia que no resuelve es un error de
   * herramienta, nunca un silencio.
   *
   * ── Por qué acepta también el NOMBRE (2026-09-21) ──────────────────────────
   * El alias corto existe para que los UUID no lleguen al modelo, y sigue
   * siendo la forma preferida. Pero un modelo chico manda el nombre igual:
   * medido, no supuesto — el log de un turno real dejó
   * `add_attribute {"target":"Cita","name":"fecha","type":"Date"}` sobre un
   * diagrama donde `Cita` era `e:1`, y lo repitió DESPUÉS de recibir un error
   * que le decía «No uses el nombre del elemento» junto con el inventario
   * completo de alias. Endurecer más el prompt es pelearle a la capacidad del
   * modelo; resolver el nombre acá es determinista y barato.
   *
   * Esto NO afloja SC-D11 («no inventar»): el nombre se busca contra el estado
   * real, tiene que coincidir con EXACTAMENTE una cosa, y un nombre que no
   * existe se sigue rechazando. Lo que desaparece es el rebote por notación.
   *
   * La distinción que sostiene todo: algo con FORMA de alias (`e:0`, `new:9`)
   * que no resuelve es un alias equivocado y se rechaza como tal — nunca se
   * reinterpreta como nombre. El nombre es el camino de lo que no parece alias.
   */
  resolveAlias(value: string, expected?: RefKind): AliasLookup | DraftError {
    if (ALIAS_RE.test(value)) {
      const resolved = this.refs.get(value);
      if (resolved !== undefined) return { ok: true, ...resolved };
      return draftError(
        'unknown_alias',
        `El alias ${value} no existe en este diagrama. ${this.aliasInventory()}`,
      );
    }

    // Tiene forma de alias pero está mal escrito (`e:`, `new:x`): es un alias
    // roto, no un nombre. Reinterpretarlo abriría la puerta a que una clase
    // llamada "e:1" secuestre la referencia.
    if (looksLikeAlias(value)) {
      return draftError(
        'unknown_alias',
        `"${value}" no es un alias válido: se espera la forma e:N, f:N o r:N (por ejemplo e:1). ${this.aliasInventory()}`,
      );
    }

    return this.resolveByName(value, expected);
  }

  /**
   * Busca por nombre contra el estado del diagrama. Exacto primero; si no hay,
   * sin distinguir mayúsculas. Tiene que dar UNA sola cosa: dos clases que se
   * llaman igual son una ambigüedad real y se devuelve para que el modelo
   * elija con el alias, que nunca es ambiguo.
   */
  private resolveByName(name: string, expected?: RefKind): AliasLookup | DraftError {
    const candidates: { readonly alias: string; readonly ref: ResolvedRef; readonly name: string }[] = [];
    const push = (kind: RefKind, alias: string, candidateName: string | null, token: string) => {
      if (candidateName === null || candidateName.length === 0) return;
      if (expected !== undefined && kind !== expected) return;
      candidates.push({ alias, ref: { kind, token }, name: candidateName });
    };

    this.snapshot.elements.forEach((element, index) => {
      push('element', elementAlias(index), element.name, element.id);
    });
    this.snapshot.features.forEach((feature, index) => {
      push('feature', featureAlias(index), feature.name, feature.id);
    });
    this.snapshot.relationships.forEach((relationship, index) => {
      push('relationship', relationshipAlias(index), relationship.name, relationship.id);
    });

    const exact = candidates.filter((candidate) => candidate.name === name);
    const matches =
      exact.length > 0
        ? exact
        : candidates.filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase());

    if (matches.length === 1) return { ok: true, ...matches[0]!.ref };
    if (matches.length > 1) {
      return draftError(
        'unknown_alias',
        `"${name}" coincide con más de una cosa (${matches.map((m) => m.alias).join(', ')}). ` +
          'Usá el alias para decir cuál.',
      );
    }
    return draftError(
      'unknown_alias',
      `No hay nada llamado "${name}" en este diagrama, y tampoco es un alias. ${this.aliasInventory()}`,
    );
  }

  /**
   * Los alias que SÍ resuelven ahora mismo, con su nombre al lado, para que el
   * modelo pueda elegir uno en la iteración siguiente en vez de volver a
   * inventar. Incluye lo que este turno planificó (`new:N`), porque un
   * atributo puede colgar de una clase recién creada.
   */
  private aliasInventory(): string {
    const parts: string[] = [];
    this.snapshot.elements.forEach((element, index) => {
      parts.push(`${elementAlias(index)} (${element.name ?? 'sin nombre'})`);
    });
    this.snapshot.features.forEach((feature, index) => {
      parts.push(`${featureAlias(index)} (${feature.name})`);
    });
    this.snapshot.relationships.forEach((_relationship, index) => {
      parts.push(relationshipAlias(index));
    });
    for (const label of this.itemOfLabel.keys()) parts.push(label);
    return parts.length === 0
      ? 'El diagrama está vacío: no hay ningún alias todavía, así que primero hay que crear el elemento.'
      : `Los alias disponibles son: ${parts.join(', ')}.`;
  }

  /**
   * Resuelve exigiendo el tipo (un dueño de atributo es un elemento). El tipo
   * esperado viaja hasta la búsqueda por nombre: pedir el dueño de un atributo
   * llamado `nombre` tiene que encontrar la CLASE `nombre`, no el atributo
   * homónimo de otra clase.
   */
  resolveAliasOf(value: string, expected: RefKind, field: string): AliasLookup | DraftError {
    const resolved = this.resolveAlias(value, expected);
    if (isDraftError(resolved)) return resolved;
    if (resolved.kind !== expected) {
      return draftError(
        'alias_kind_mismatch',
        `${field}: ${value} apunta a un ${resolved.kind}, no a un ${expected}.`,
      );
    }
    return resolved;
  }

  /** El `id` del elemento que produce una determinada creación planificada. */
  plannedCreateLabelOf(index: number): string | null {
    return this.planned[index]?.produces ?? null;
  }

  /** Cuántos elementos crea el plan hasta ahora (para ubicar los nuevos). */
  plannedCreateCount(): number {
    return this.planned.filter((op) => op.type === 'element.create').length;
  }

  /**
   * Los UUID EXISTENTES a los que apunta el plan: dueños, extremos y
   * `typeElementId` (D6, D8). Es lo que el `precheck` del confirm vuelve a
   * consultar —«¿algo posterior tocó alguno de estos?»— y el conjunto sobre el
   * que se piden los locks. Los `new:N` del propio turno no cuentan: todavía no
   * existen.
   */
  referencedIds(): string[] {
    const ids = new Set<string>();
    for (const op of this.planned) {
      for (const reference of collectRefValues(op.type, op.payload)) {
        if (!reference.startsWith('new:')) ids.add(reference);
      }
    }
    return [...ids];
  }

  /**
   * Los ítems de la vista previa (D6). `initiallyExcluded` es el cierre de las
   * bajas confianzas: lo que depende de algo dudoso arranca destildado, aunque
   * el propio ítem sea `high` (PO-2).
   */
  previewItems(): AiPreviewItem[] {
    const low = this.itemDrafts.filter((item) => item.confidence === 'low').map((item) => item.index);
    const closure = excludeClosure(this.itemDrafts, low);
    return this.itemDrafts.map((item) => ({ ...item, initiallyExcluded: closure.has(item.index) }));
  }

  /** Las operaciones de cada ítem, alineadas por índice (D8: el confirm filtra por cierre). */
  opsByItem(): PlannedOp[][] {
    return this.itemProduced.map((entry) => entry.ops);
  }

  /** Lo que la vista previa lista por cada ítem, alineado por índice (FR-D25). */
  appliedByItem(): AiTurnAppliedOp[][] {
    return this.itemProduced.map((entry) => entry.applied);
  }

  /**
   * Los `element.create` del plan, en orden de plan, con su `new:N` y el centro
   * normalizado que el modelo declaró (o `null`): la entrada de
   * `layoutImageItems` (D7).
   */
  imageCreateOps(): { label: string; index: number; position: PlannedPosition | null }[] {
    return this.planned
      .filter((op) => op.type === 'element.create' && op.produces !== null)
      .map((op, index) => ({
        label: op.produces!,
        index,
        position: this.imagePositions.get(op.produces!) ?? null,
      }));
  }

  /**
   * Aplica al `element.create` de ese `new:N` el rectángulo que resolvió el
   * lienzo (D7). `rect` viene en coordenadas ABSOLUTAS de lienzo —
   * `layoutImageItems` (`image-layout.ts`) no sabe nada de `parentId`, ubica
   * contra `nx`/`ny` de la FOTO — así que acá, antes de guardar, se convierte
   * a lo que `element_layouts` espera (`element-parent-containment`): si la
   * creación tiene padre, relativo a él; si no, la misma absoluta de siempre.
   * Es el único punto de conversión para el turno de IMAGEN: si un elemento
   * nuevo nace DENTRO de un paquete (`create_class` con `parent`, ver D7 del
   * turno de texto), su fila tiene que guardar la posición relativa al
   * paquete, no la absoluta que calculó `layoutImageItems` contra la foto.
   */
  applyLayoutRect(label: string, rect: Rect): void {
    const index = this.planned.findIndex((op) => op.type === 'element.create' && op.produces === label);
    if (index < 0) return;
    const op = this.planned[index]!;
    const payload = op.payload as unknown as Record<string, unknown>;
    const parentId = (payload['parentId'] as string | null | undefined) ?? null;
    const stored = this.storedPositionFor(rect.x, rect.y, parentId);
    this.planned[index] = {
      ...op,
      payload: { ...payload, layout: { ...rect, x: stored.x, y: stored.y } },
    } as unknown as PlannedOp;
  }

  /** Guarda el centro normalizado de un `new:N` (D7). Fuera de rango cae a la grilla, no es un error. */
  recordImagePosition(label: string, nx: number, ny: number): void {
    this.imagePositions.set(label, { nx, ny });
  }

  /**
   * Marca la llamada en curso como dudosa (validación indulgente de D5). El
   * validador la llama en vez de rechazar; el ítem nace `low` y destildado.
   */
  noteLow(reason: AiPreviewLowReason): void {
    this.marks.push(reason);
  }

  /**
   * Ubica un elemento nuevo en una columna a la derecha de lo que ya existe
   * (D3): sin `apply_layout`, un turno que solo crea tiene que seguir siendo
   * solo de creación — y deshacible.
   *
   * `element-parent-containment`: "lo que ya existe" se filtra a los
   * HERMANOS del mismo padre (`parentId`, `null` para la raíz) — mezclar la
   * escala de un paquete (chico, relativo a sí mismo) con la del lienzo
   * (grande, absoluta) daría una columna sin sentido. El resultado sale YA
   * en el marco de referencia correcto para guardar sin conversión: si
   * `parentId` es `null`, la foto solo tiene otras raíces con coordenadas
   * absolutas: si `parentId` apunta a un paquete, sus hermanos (si los tiene)
   * ya están en `snapshot.layouts` con coordenadas relativas A ESE PADRE —
   * exactamente lo que hay que guardar. Un paquete sin hermanos con layout
   * (por ejemplo, el primer hijo de un paquete que este mismo turno acaba de
   * crear) cae al origen de siempre (`ORIGIN_X/Y`), que —relativo al padre—
   * es la esquina superior izquierda con el mismo margen que usa el PAD de
   * la migración `20260922000000_relative_child_layouts`.
   */
  nextCreateLayout(kind: ElementKind, parentId: string | null): Rect {
    const size = defaultSize(kind);
    const existing = this.snapshot.layouts.filter((layout) => {
      const element = this.elementsById[layout.elementId];
      return (element?.parentId ?? null) === parentId;
    });
    const baseX =
      existing.length === 0 ? ORIGIN_X : Math.max(...existing.map((l) => l.x + l.width)) + COLUMN_GAP;
    const baseY = existing.length === 0 ? ORIGIN_Y : Math.min(...existing.map((l) => l.y));
    const row = this.plannedCreateCount();
    return {
      x: baseX,
      y: baseY + row * (DEFAULT_ELEMENT_HEIGHT + ROW_GAP),
      width: size.width,
      height: size.height,
    };
  }

  /**
   * `apply_layout` sobre un `new:N` se PLIEGA en el `element.create` planificado
   * y no genera un `element.move` (D3). Devuelve `false` si la etiqueta no
   * corresponde a una creación de elemento de este turno.
   *
   * `x`/`y` acá son la "coordenada dentro del lienzo" que declara la
   * herramienta (`ai-tools.ts`, `apply_layout`) — ABSOLUTA, porque el modelo
   * razona sobre el lienzo entero, no sobre un paquete. `storedPositionFor`
   * la convierte a relativa si la creación tiene padre (mismo motivo que
   * `applyLayoutRect`, arriba, para el turno de imagen).
   */
  foldLayout(label: string, x: number, y: number): boolean {
    const index = this.planned.findIndex(
      (op) => op.type === 'element.create' && op.produces === label,
    );
    if (index < 0) return false;
    const op = this.planned[index]!;
    const payload = op.payload as unknown as Record<string, unknown>;
    const layout = payload['layout'] as Rect;
    const parentId = (payload['parentId'] as string | null | undefined) ?? null;
    const stored = this.storedPositionFor(x, y, parentId);
    const next = {
      ...op,
      payload: { ...payload, layout: { x: stored.x, y: stored.y, width: layout.width, height: layout.height } },
    };
    this.planned[index] = next as unknown as PlannedOp;
    return true;
  }

  /**
   * `elementId` (existente, de la foto) → su `parentId` de MODELO, o `null`
   * si no tiene padre o no se encuentra. Azúcar sobre `elementsById` para
   * quien necesita convertir una posición ABSOLUTA que declaró el modelo
   * (`apply_layout` sobre algo que YA existe, no un `new:N`) a lo que hay
   * que guardar — ver `storedPositionFor`.
   */
  elementParentIdOf(elementId: string): string | null {
    return this.elementsById[elementId]?.parentId ?? null;
  }

  /**
   * Posición ABSOLUTA de un token — de la foto (usa `absolutePositionOf` de
   * `@umlive/contracts`, la misma que usan `DiagramPage.tsx`/`PresenceLayer.tsx`/
   * `ea-extension.ts`) o de una creación que ESTE TURNO ya planificó (`new:N`,
   * cuyo `layout`/`parentId` viven en `this.planned`, no en `snapshot`
   * — no existen todavía en la base). Mismo criterio de "sumar la cadena de
   * padres" que la función de contracts, pero mezclando las dos fuentes
   * porque un padre `new:N` (un paquete que el turno acaba de crear, con una
   * clase adentro planificada a continuación) no está en la foto.
   *
   * `null` si el token no resuelve en ninguna de las dos fuentes — no
   * debería pasar en un plan válido (todo `parentId` referenciado ya se
   * resolvió contra la foto o contra un `new:N` anterior al validar el
   * alias), pero `storedPositionFor` cae a "sin convertir" en ese caso en vez
   * de reventar el turno por una posición.
   */
  absolutePositionOfToken(token: string): { x: number; y: number } | null {
    let x = 0;
    let y = 0;
    let current: string | null = token;
    const visited = new Set<string>();
    // Un `parentId` de un elemento YA EXISTENTE nunca puede apuntar a un
    // `new:N` (ese elemento no existía cuando se leyó la foto), así que la
    // cadena es, cuando mucho, un prefijo de `new:N` seguido de un sufijo
    // 100% de foto — nunca se intercalan. Este bucle solo camina el prefijo.
    while (current !== null && current.startsWith('new:')) {
      if (visited.has(current)) return { x, y };
      visited.add(current);
      const op = this.planned.find((candidate) => candidate.type === 'element.create' && candidate.produces === current);
      if (op === undefined) return null;
      const payload = op.payload as unknown as { layout?: Rect; parentId?: string | null };
      if (payload.layout === undefined) return null;
      x += payload.layout.x;
      y += payload.layout.y;
      current = payload.parentId ?? null;
    }
    if (current === null) return { x, y };
    // El resto de la cadena (si la hay) ya vive en la foto — mismo camino que
    // usa cualquier otro consumidor de layouts (`DiagramPage.tsx`,
    // `PresenceLayer.tsx`, `ea-extension.ts`).
    const rest = absolutePositionOf(current, this.elementsById, this.layoutsById);
    if (rest === null) return null;
    return { x: x + rest.x, y: y + rest.y };
  }

  /**
   * Convierte una posición ABSOLUTA de lienzo — la que declara el modelo, sea
   * por `apply_layout` (x/y directo) o por `nx`/`ny` de una foto ya resueltas
   * a lienzo (`layoutImageItems`) — a lo que hay que GUARDAR en
   * `element_layouts` (`element-parent-containment`): relativa a `parentId`
   * si lo hay, la misma absoluta si no (la raíz). Cae a "sin convertir"
   * cuando no puede resolver la posición absoluta del padre — más seguro que
   * rechazar la llamada del modelo por un problema de geometría interno.
   */
  storedPositionFor(x: number, y: number, parentId: string | null): { x: number; y: number } {
    if (parentId === null) return { x, y };
    const parentAbsolute = this.absolutePositionOfToken(parentId);
    if (parentAbsolute === null) return { x, y };
    return { x: x - parentAbsolute.x, y: y - parentAbsolute.y };
  }

  /** Posición del próximo atributo/operación de un dueño (foto + lo planificado). */
  nextFeaturePosition(ownerToken: string): number {
    const existing = this.snapshot.features.filter((f) => f.ownerId === ownerToken).length;
    const planned = this.planned.filter(
      (op) => op.type === 'feature.create' && (op.payload as { ownerId: string }).ownerId === ownerToken,
    ).length;
    return existing + planned;
  }

  /** Posición del próximo parámetro de una operación (foto + lo planificado). */
  nextParameterPosition(operationToken: string): number {
    const existing = this.snapshot.parameters.filter((p) => p.operationId === operationToken).length;
    const planned = this.planned.filter(
      (op) => op.type === 'parameter.add' && (op.payload as { operationId: string }).operationId === operationToken,
    ).length;
    return existing + planned;
  }

  /** Relaciones incidentes de un elemento en la foto, para `expectedIncidentRelationshipIds`. */
  incidentRelationshipIds(elementToken: string): string[] {
    const ids = new Set<string>();
    for (const relationship of this.snapshot.relationships) {
      if (relationship.sourceElementId === elementToken || relationship.targetElementId === elementToken) {
        ids.add(relationship.id);
      }
    }
    for (const end of this.snapshot.relationshipEnds) {
      if (end.elementId === elementToken) ids.add(end.relationshipId);
    }
    return [...ids];
  }

  /** La multiplicidad vigente del extremo destino de una relación, si está en la foto. */
  relationshipEnd(elementToken: string, endIndex: 0 | 1) {
    return this.snapshot.relationshipEnds.find(
      (end) => end.relationshipId === elementToken && end.endIndex === endIndex,
    );
  }

  /**
   * La unión de objetivos de lock del plan (Fase 6 / `acquireAllTracked`).
   *
   * Se deriva de `LOCK_REQUIREMENTS` y de la FOTO, no de la base: es la lista
   * que el turno intenta tomar antes de aplicar. Lo que el turno crea no
   * necesita lock (todavía no existe); los `new:N` se descartan por eso.
   *
   * El servidor vuelve a resolver la tabla dentro de su transacción y es la
   * autoridad; esto es la lista con la que se pide, todo o nada.
   */
  lockTargets(): string[] {
    const targets = new Set<string>();
    for (const op of this.planned) {
      for (const target of LOCK_REQUIREMENTS[op.type].targets) {
        for (const id of this.resolveLockTarget(op, target)) {
          if (!id.startsWith('new:')) targets.add(id);
        }
      }
    }
    return [...targets];
  }

  /** El resumen de lo aplicado, con su etiqueta en lenguaje simple (FR-D25). */
  applied(): AiTurnAppliedOp[] {
    return this.planned.map((op) => ({ type: op.type, label: this.describe(op) }));
  }

  private resolveLockTarget(
    op: PlannedOp,
    target: (typeof LOCK_REQUIREMENTS)[OperationType]['targets'][number],
  ): string[] {
    const payload = op.payload as unknown as Record<string, unknown>;
    const field = (target as { field: string }).field;
    const raw = payload[field];
    const value = typeof raw === 'string' ? raw : null;
    if (value === null) return [];

    switch (target.from) {
      case 'payload':
        return [value];
      case 'featureOwner': {
        const feature = this.snapshot.features.find((f) => f.id === value);
        return feature ? [feature.ownerId] : [];
      }
      case 'parameterOwner': {
        const parameter = this.snapshot.parameters.find((p) => p.id === value);
        if (!parameter) return [];
        const operation = this.snapshot.features.find((f) => f.id === parameter.operationId);
        return operation ? [operation.ownerId] : [];
      }
      case 'literalOwner': {
        const literal = this.snapshot.enumLiterals.find((l) => l.id === value);
        return literal ? [literal.enumerationId] : [];
      }
      case 'deleteClosure': {
        const subtree = this.subtreeOf(value);
        const relationships =
          op.type === 'element.delete'
            ? this.incidentRelationshipIds(value)
            : [];
        return [...subtree, ...relationships];
      }
      default:
        return [];
    }
  }

  private subtreeOf(root: string): string[] {
    const ids: string[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      for (const element of this.snapshot.elements) {
        if (element.parentId === current && !ids.includes(element.id)) queue.push(element.id);
      }
    }
    return ids;
  }

  /** Asigna los `new:N`, sustituye los marcadores internos y registra los alias. */  private commit(drafts: readonly DraftOp[]): PlannedOp[] {
    const labels = drafts.map((draft) => (draft.produces === null ? null : `new:${++this.newCount}`));

    return drafts.map((draft, index) => {
      const payload = substituteRefFields(
        draft.type,
        draft.payload as PayloadFor<OperationType>,
        (reference) => {
          const self = selfRefIndex(reference);
          if (self === null) return undefined;
          const label = labels[self];
          if (label === null || label === undefined) {
            throw new Error(`marcador interno de referencia inválido: ${reference}`);
          }
          return label;
        },
      );
      const label = labels[index] ?? null;
      if (label !== null) this.refs.set(label, { kind: draft.produces!, token: label });
      return { type: draft.type, payload, produces: label } as unknown as PlannedOp;
    });
  }

  private reject(tool: string, reason: NotAppliedReason, message: string): ToolCallOutcome {
    this.notApplied.push({ tool, reason });
    return { ok: false, error: reason, result: message };
  }

  /**
   * Construye el ítem de una llamada aceptada (D6). Sin operaciones no hay
   * ítem: `apply_layout` sobre un `new:N` se pliega en el create y no aparece
   * como una fila aparte de la vista previa.
   */
  private buildItem(toolName: string, input: Record<string, unknown>, committed: readonly PlannedOp[]): void {
    if (!this.image || committed.length === 0) return;
    const kind = ITEM_KINDS[toolName];
    if (kind === undefined) return;

    const lowReasons = this.lowReasonsFor(input, committed);
    const index = this.itemDrafts.length;
    const note = typeof input['note'] === 'string' && input['note'].trim().length > 0 ? input['note'] : null;

    this.itemDrafts.push({
      index,
      label: this.describe(committed[0]!),
      kind,
      confidence: lowReasons.length === 0 ? 'high' : 'low',
      lowReasons,
      note,
      dependsOn: this.dependenciesOf(committed),
      initiallyExcluded: false,
    });
    this.itemProduced.push({
      ops: [...committed],
      applied: committed.map((op) => ({ type: op.type, label: this.describe(op) })),
    });

    for (const op of committed) {
      if (op.produces !== null) this.itemOfLabel.set(op.produces, index);
    }
  }

  /**
   * Por qué el ítem es dudoso (D5): lo que declaró el modelo (`confidence`)
   * más lo que el servidor no pudo interpretar (marcas del validador, nombres
   * con caracteres raros). Un solo motivo alcanza para `low`.
   */
  private lowReasonsFor(input: Record<string, unknown>, committed: readonly PlannedOp[]): AiPreviewLowReason[] {
    const reasons = new Set<AiPreviewLowReason>(this.marks);
    if (input['confidence'] === 'low') reasons.add('model');
    for (const op of committed) {
      const name = (op.payload as Record<string, unknown>)['name'];
      if (typeof name === 'string' && !SAFE_NAME.test(name)) reasons.add('name_suspicious');
    }
    return [...reasons];
  }

  /**
   * Los ítems que producen los `new:N` que esta llamada referencia (D6).
   * `itemOfLabel` solo tiene los ítems YA cerrados, así que una referencia
   * interna de la propia llamada (el parámetro que apunta a su operación) no
   * cuenta como dependencia: es el mismo ítem.
   */
  private dependenciesOf(committed: readonly PlannedOp[]): number[] {
    const deps = new Set<number>();
    for (const op of committed) {
      for (const reference of collectRefValues(op.type, op.payload)) {
        const item = this.itemOfLabel.get(reference);
        if (item !== undefined) deps.add(item);
      }
    }
    return [...deps].sort((a, b) => a - b);
  }

  /** Etiqueta legible de una operación, para el resumen (FR-D25). */
  describe(op: PlannedOp): string {
    const payload = op.payload as unknown as Record<string, unknown>;
    switch (op.type) {
      case 'element.create': {
        const kind = payload['kind'] as ElementKind;
        const noun = ELEMENT_NOUNS[kind] ?? { singular: 'Elemento', feminine: false };
        return `${noun.singular} ${String(payload['name'])} ${noun.feminine ? 'creada' : 'creado'}`;
      }
      case 'feature.create': {
        const kind = payload['kind'] === 'OPERATION' ? 'Operación' : 'Atributo';
        const feminine = kind === 'Operación';
        return `${kind} ${String(payload['name'])} ${feminine ? 'agregada' : 'agregado'} a ${this.nameOf(payload['ownerId'])}`;
      }
      case 'parameter.add':
        return `Parámetro ${String(payload['name'])} agregado a ${this.nameOf(payload['operationId'])}`;
      case 'relationship.create':
        return `Relación ${this.nameOf(payload['sourceElementId'])} → ${this.nameOf(payload['targetElementId'])} creada`;
      case 'element.rename':
        return `${this.nameOf(payload['id'])} renombrado a ${String(payload['name'])}`;
      case 'element.setAbstract':
        return `${this.nameOf(payload['id'])} ${payload['isAbstract'] === true ? 'marcado abstracto' : 'desmarcado como abstracto'}`;
      case 'feature.update':
        return `${this.nameOf(payload['id'])} actualizado`;
      case 'element.move':
        return `${this.nameOf(payload['id'])} reubicado`;
      case 'relationship.rename':
        return `Relación ${this.nameOf(payload['id'])} renombrada a ${String(payload['name'])}`;
      case 'relationshipEnd.setMultiplicity':
      case 'relationshipEnd.setAggregation':
        return `Extremo de la relación ${this.nameOf(payload['relationshipId'])} actualizado`;
      case 'element.delete':
      case 'feature.delete':
      case 'relationship.delete':
        return `${this.nameOf(payload['id'])} borrado`;
      default:
        return op.type;
    }
  }

  /** Nombre de un id real o de un `new:N` planificado, para las etiquetas. */
  private nameOf(reference: unknown): string {
    if (typeof reference !== 'string') return '?';
    const element = this.snapshot.elements.find((e) => e.id === reference);
    if (element !== undefined) return element.name ?? element.id;
    const feature = this.snapshot.features.find((f) => f.id === reference);
    if (feature !== undefined) return feature.name;
    const relationship = this.snapshot.relationships.find((r) => r.id === reference);
    if (relationship !== undefined) return relationship.name ?? relationship.id;
    return reference;
  }
}

const ELEMENT_NOUNS: Partial<Record<ElementKind, { singular: string; feminine: boolean }>> = {
  CLASS: { singular: 'Clase', feminine: true },
  INTERFACE: { singular: 'Interfaz', feminine: true },
  ENUMERATION: { singular: 'Enumeración', feminine: true },
  DATATYPE: { singular: 'Tipo de dato', feminine: false },
  PRIMITIVE_TYPE: { singular: 'Tipo primitivo', feminine: false },
  PACKAGE: { singular: 'Paquete', feminine: false },
  COMMENT: { singular: 'Comentario', feminine: false },
};

function defaultSize(kind: ElementKind): { width: number; height: number } {
  if (kind === 'PACKAGE') return { width: PACKAGE_WIDTH, height: PACKAGE_HEIGHT };
  if (kind === 'COMMENT') return { width: COMMENT_WIDTH, height: COMMENT_HEIGHT };
  return { width: DEFAULT_ELEMENT_WIDTH, height: DEFAULT_ELEMENT_HEIGHT };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura y validación de la entrada del modelo
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredName(input: Record<string, unknown>, field: string): string | DraftError {
  const raw = input[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return draftError('invalid_input', `\`${field}\` es obligatorio: es un nombre no vacío.`);
  }
  if (raw.length > MAX_NAME_LENGTH) {
    return draftError(
      'invalid_input',
      `\`${field}\` tiene ${raw.length} caracteres y el máximo es ${MAX_NAME_LENGTH}.`,
    );
  }
  return raw;
}

function optionalName(input: Record<string, unknown>, field: string): string | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return draftError('invalid_input', `\`${field}\` debe ser un nombre no vacío si se manda.`);
  }
  if (raw.length > MAX_NAME_LENGTH) {
    return draftError(
      'invalid_input',
      `\`${field}\` tiene ${raw.length} caracteres y el máximo es ${MAX_NAME_LENGTH}.`,
    );
  }
  return raw;
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return draftError('invalid_input', `\`${field}\` debe ser uno de: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
): boolean | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'boolean') {
    return draftError('invalid_input', `\`${field}\` debe ser true o false.`);
  }
  return raw;
}

function optionalString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    return draftError('invalid_input', `\`${field}\` debe ser un texto no vacío si se manda.`);
  }
  if (raw.length > maxLength) {
    return draftError('invalid_input', `\`${field}\` supera los ${maxLength} caracteres.`);
  }
  return raw;
}

function requiredInteger(
  input: Record<string, unknown>,
  field: string,
): number | DraftError {
  const raw = input[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return draftError('invalid_input', `\`${field}\` debe ser un número entero.`);
  }
  return raw;
}

/** Un número finito, sin exigir que sea entero: las posiciones son normalizadas (D7). */
function requiredNumber(input: Record<string, unknown>, field: string): number | DraftError {
  const raw = input[field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return draftError('invalid_input', `\`${field}\` debe ser un número.`);
  }
  return raw;
}

/** Multiplicidad textual (`"1"`, `"0..1"`, `"1..*"`, `"*"`) → par de cotas. */
function parseMultiplicity(value: string): { lowerBound: number; upperBound: number | null } | null {
  if (value === '*') return { lowerBound: 0, upperBound: null };
  const parts = value.split('..');
  if (parts.length === 1) {
    const bound = toBound(parts[0]);
    return bound === null ? null : { lowerBound: bound, upperBound: bound };
  }
  if (parts.length !== 2) return null;
  const lower = toBound(parts[0]);
  const upper = parts[1] === '*' ? null : toBound(parts[1]);
  if (lower === null || (parts[1] !== '*' && upper === null)) return null;
  if (upper !== null && upper < lower) return null;
  return { lowerBound: lower, upperBound: upper };
}

function toBound(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function optionalMultiplicity(
  input: Record<string, unknown>,
  field: string,
): { lowerBound: number; upperBound: number | null } | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    return draftError('invalid_input', `\`${field}\` debe ser texto, por ejemplo "1" o "0..1".`);
  }
  const parsed = parseMultiplicity(raw);
  if (parsed === null) {
    return draftError(
      'invalid_multiplicity',
      `\`${field}\`: "${raw}" no es una multiplicidad válida. Usá "1", "0..1", "1..*" o "*".`,
    );
  }
  return parsed;
}

type TypeResolution =
  | { readonly kind: 'element'; readonly token: string }
  | { readonly kind: 'name'; readonly name: string };

/**
 * Un tipo puede ser un primitivo (`String`) o el alias de un elemento modelado
 * (D6): si tiene forma de alias, se resuelve; si no, se copia tal cual.
 */
function resolveTypeField(
  input: Record<string, unknown>,
  field: string,
  plan: TurnPlan,
): TypeResolution | undefined | DraftError {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    return draftError('invalid_input', `\`${field}\` debe ser un texto no vacío si se manda.`);
  }
  if (!looksLikeAlias(raw)) return { kind: 'name', name: raw };
  const resolved = plan.resolveAliasOf(raw, 'element', field);
  if ('error' in resolved) return resolved;
  return { kind: 'element', token: resolved.token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validadores por herramienta (FR-D05, SC-D03)
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATORS: Record<string, Validator> = {
  create_class: (input, plan) => {
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    const kind = optionalEnum(input, 'kind', CLASSIFIER_KINDS);
    if (isDraftError(kind)) return kind;
    const isAbstract = optionalBoolean(input, 'isAbstract');
    if (isDraftError(isAbstract)) return isAbstract;

    let parentId: string | null = null;
    if (input['parent'] !== undefined && input['parent'] !== null) {
      if (typeof input['parent'] !== 'string') {
        return draftError('invalid_input', '`parent` debe ser el alias de un paquete.');
      }
      const parent = plan.resolveAliasOf(input['parent'], 'element', 'parent');
      if ('error' in parent) return parent;
      parentId = parent.token;
    }

    const effectiveKind: ElementKind = kind ?? 'CLASS';
    return {
      ops: [
        {
          type: 'element.create',
          produces: 'element',
          payload: {
            id: INERT_ID,
            kind: effectiveKind,
            name,
            parentId,
            ...(isAbstract === undefined ? {} : { isAbstract }),
            layout: plan.nextCreateLayout(effectiveKind, parentId),
          },
        },
      ],
    };
  },

  add_attribute: (input, plan) => {
    const target = aliasField(input, 'target', 'element', plan);
    if (isDraftError(target)) return target;
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    const type = resolveTypeField(input, 'type', plan);
    if (type !== undefined && isDraftError(type)) return type;
    const visibility = optionalEnum(input, 'visibility', VISIBILITIES);
    if (isDraftError(visibility)) return visibility;
    const multiplicity = optionalMultiplicity(input, 'multiplicity');
    if (multiplicity !== undefined && isDraftError(multiplicity)) return multiplicity;
    const defaultValue = optionalString(input, 'defaultValue', 2000);
    if (defaultValue !== undefined && isDraftError(defaultValue)) return defaultValue;

    const flags = readFlags(input, ['isStatic', 'isReadonly', 'isDerived']);
    if (isDraftError(flags)) return flags;

    return {
      ops: [
        {
          type: 'feature.create',
          produces: 'feature',
          payload: {
            id: INERT_ID,
            ownerId: target.token,
            kind: 'ATTRIBUTE',
            name,
            visibility: visibility ?? 'PUBLIC',
            ...typeFields(type),
            lowerBound: multiplicity?.lowerBound ?? 1,
            upperBound: multiplicity === undefined ? 1 : multiplicity.upperBound,
            position: plan.nextFeaturePosition(target.token),
            ...(defaultValue === undefined ? {} : { defaultValue }),
            ...flags.value,
          },
        },
      ],
    };
  },

  add_operation: (input, plan) => {
    const target = aliasField(input, 'target', 'element', plan);
    if (isDraftError(target)) return target;
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    const returnType = resolveTypeField(input, 'returnType', plan);
    if (returnType !== undefined && isDraftError(returnType)) return returnType;
    const visibility = optionalEnum(input, 'visibility', VISIBILITIES);
    if (isDraftError(visibility)) return visibility;

    const flags = readFlags(input, ['isStatic', 'isAbstract', 'isQuery']);
    if (isDraftError(flags)) return flags;

    const rawParameters = input['parameters'];
    const parameters: { name: string; type?: TypeResolution; direction?: 'IN' | 'OUT' | 'INOUT' }[] = [];
    if (rawParameters !== undefined && rawParameters !== null) {
      if (!Array.isArray(rawParameters)) {
        return draftError('invalid_input', '`parameters` debe ser un arreglo.');
      }
      for (const [index, raw] of rawParameters.entries()) {
        if (!isRecord(raw)) {
          return draftError('invalid_input', `\`parameters[${index}]\` debe ser un objeto.`);
        }
        const paramName = requiredName(raw, 'name');
        if (isDraftError(paramName)) return paramName;
        const direction = optionalEnum(raw, 'direction', PARAMETER_DIRECTIONS);
        if (isDraftError(direction)) return direction;
        const paramType = resolveTypeField(raw, 'type', plan);
        if (paramType !== undefined && isDraftError(paramType)) return paramType;
        parameters.push({ name: paramName, type: paramType, direction });
      }
    }

    const operation: DraftOp = {
      type: 'feature.create',
      produces: 'feature',
      payload: {
        id: INERT_ID,
        ownerId: target.token,
        kind: 'OPERATION',
        name,
        visibility: visibility ?? 'PUBLIC',
        ...typeFields(returnType),
        position: plan.nextFeaturePosition(target.token),
        ...flags.value,
      },
    };

    const base = plan.nextParameterPosition(selfRef(0));
    const parameterOps: DraftOp[] = parameters.map((parameter, index) => ({
      type: 'parameter.add',
      produces: null,
      payload: {
        id: INERT_ID,
        // Referencia a la operación que crea ESTA misma llamada: el marcador se
        // sustituye por el `new:N` en cuanto el plan lo asigna.
        operationId: selfRef(0),
        name: parameter.name,
        direction: parameter.direction ?? 'IN',
        ...typeFields(parameter.type),
        position: base + index,
      },
    }));

    return { ops: [operation, ...parameterOps] };
  },

  create_relationship: (input, plan) => {
    const kind = optionalEnum(input, 'kind', RELATIONSHIP_KINDS);
    if (isDraftError(kind)) return kind;
    if (kind === undefined) {
      return draftError('invalid_input', '`kind` es obligatorio: decí qué tipo de relación es.');
    }
    const source = aliasField(input, 'source', 'element', plan);
    if (isDraftError(source)) return source;
    const target = aliasField(input, 'target', 'element', plan);
    if (isDraftError(target)) return target;
    const name = optionalName(input, 'name');
    if (name !== undefined && isDraftError(name)) return name;

    const aggregation = optionalEnum(input, 'aggregation', AGGREGATIONS);
    if (isDraftError(aggregation)) return aggregation;
    if (aggregation !== undefined && kind !== 'ASSOCIATION') {
      return draftError(
        'aggregation_requires_association',
        '`aggregation` solo aplica a una asociación: una composición es kind ASSOCIATION con aggregation COMPOSITE.',
      );
    }

    const sourceMultiplicity = optionalMultiplicity(input, 'sourceMultiplicity');
    if (sourceMultiplicity !== undefined && isDraftError(sourceMultiplicity)) return sourceMultiplicity;
    const targetMultiplicity = optionalMultiplicity(input, 'targetMultiplicity');
    if (targetMultiplicity !== undefined && isDraftError(targetMultiplicity)) return targetMultiplicity;

    if (kind === 'GENERALIZATION' && source.token === target.token) {
      return draftError('self_generalization', 'Una generalización no puede heredar de sí misma.');
    }

    const ends =
      kind === 'ASSOCIATION'
        ? buildEnds(sourceMultiplicity, targetMultiplicity, aggregation)
        : undefined;
    if (ends !== undefined && isDraftError(ends)) return ends;

    return {
      ops: [
        {
          type: 'relationship.create',
          produces: 'relationship',
          payload: {
            id: INERT_ID,
            kind,
            sourceElementId: source.token,
            targetElementId: target.token,
            ...(name === undefined ? {} : { name }),
            ...(ends === undefined ? {} : { ends: ends.value }),
          },
        },
      ],
    };
  },

  update_element: (input, plan) => {
    if (typeof input['target'] !== 'string') {
      return draftError('invalid_input', '`target` es obligatorio: el alias de lo que se cambia.');
    }
    const resolved = plan.resolveAlias(input['target']);
    if ('error' in resolved) return resolved;

    switch (resolved.kind) {
      case 'element':
        return updateElement(input, resolved.token);
      case 'feature':
        return updateFeature(input, resolved.token, plan);
      case 'relationship':
        return updateRelationship(input, resolved.token, plan);
    }
  },

  delete_element: (input, plan) => {
    if (typeof input['target'] !== 'string') {
      return draftError('invalid_input', '`target` es obligatorio: el alias de lo que se borra.');
    }
    const resolved = plan.resolveAlias(input['target']);
    if ('error' in resolved) return resolved;

    if (resolved.kind === 'element') {
      return {
        ops: [
          {
            type: 'element.delete',
            produces: null,
            payload: {
              id: resolved.token,
              expectedIncidentRelationshipIds: resolved.token.startsWith('new:')
                ? []
                : plan.incidentRelationshipIds(resolved.token),
            },
          },
        ],
      };
    }
    if (resolved.kind === 'feature') {
      return { ops: [{ type: 'feature.delete', produces: null, payload: { id: resolved.token } }] };
    }
    return { ops: [{ type: 'relationship.delete', produces: null, payload: { id: resolved.token } }] };
  },

  apply_layout: (input, plan) => {
    // Modo imagen: el modelo ve la FOTO, no el lienzo (D7). Pide el centro
    // normalizado y solo sobre algo que el turno crea; una posición fuera de
    // rango no es un error: el lienzo la resuelve con su grilla de respaldo.
    if (plan.imageMode) {
      const target = aliasField(input, 'target', 'element', plan);
      if (isDraftError(target)) return target;
      if (!target.token.startsWith('new:')) {
        return draftError(
          'image_turn_create_only',
          `Un turno de imagen solo ubica lo que crea: ${target.token} ya existe en el diagrama.`,
        );
      }
      const nx = requiredNumber(input, 'nx');
      if (isDraftError(nx)) return nx;
      const ny = requiredNumber(input, 'ny');
      if (isDraftError(ny)) return ny;

      plan.recordImagePosition(target.token, nx, ny);
      return { ops: [] };
    }

    const target = aliasField(input, 'target', 'element', plan);
    if (isDraftError(target)) return target;
    const x = requiredInteger(input, 'x');
    if (isDraftError(x)) return x;
    const y = requiredInteger(input, 'y');
    if (isDraftError(y)) return y;

    // Sobre algo que el turno crea, se pliega en el create: no genera un
    // `element.move` y el turno sigue siendo solo de creación (D3).
    if (target.token.startsWith('new:')) {
      const folded = plan.foldLayout(target.token, x, y);
      if (!folded) {
        return draftError(
          'layout_target_not_planned',
          `${target.token} no es una creación de elemento de este turno.`,
        );
      }
      return { ops: [] };
    }

    // `x`/`y` de la herramienta son ABSOLUTOS de lienzo (mismo criterio que
    // arriba). Sobre un elemento EXISTENTE, su `parentId` ya está resuelto en
    // la foto (nunca puede ser un `new:N` — no existía cuando se leyó), así
    // que alcanza con `elementParentIdOf`, sin pasar por
    // `absolutePositionOfToken`/el prefijo `new:N`.
    const stored = plan.storedPositionFor(x, y, plan.elementParentIdOf(target.token));
    return {
      ops: [{ type: 'element.move', produces: null, payload: { id: target.token, x: stored.x, y: stored.y } }],
    };
  },
};

/** Campos de actualización admitidos por cada tipo de destino del `update_element`. */
const ELEMENT_UPDATE_FIELDS = ['name', 'isAbstract'];
const FEATURE_UPDATE_FIELDS = [
  'name',
  'type',
  'visibility',
  'multiplicity',
  'defaultValue',
  'isStatic',
  'isReadonly',
  'isDerived',
  'isAbstract',
  'isQuery',
];
const RELATIONSHIP_UPDATE_FIELDS = [
  'name',
  'sourceMultiplicity',
  'targetMultiplicity',
  'aggregation',
];

function updateElement(input: Record<string, unknown>, id: string): DraftResult {
  const stray = strayFields(input, ELEMENT_UPDATE_FIELDS);
  if (stray !== undefined) return stray;

  const ops: DraftOp[] = [];
  if (input['name'] !== undefined) {
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    ops.push({ type: 'element.rename', produces: null, payload: { id, name } });
  }
  if (input['isAbstract'] !== undefined) {
    const isAbstract = optionalBoolean(input, 'isAbstract');
    if (isDraftError(isAbstract)) return isAbstract;
    ops.push({
      type: 'element.setAbstract',
      produces: null,
      payload: { id, isAbstract: isAbstract ?? false },
    });
  }
  return ops.length === 0 ? nothingToUpdate() : { ops };
}

function updateFeature(input: Record<string, unknown>, id: string, plan: TurnPlan): DraftResult {
  const stray = strayFields(input, FEATURE_UPDATE_FIELDS);
  if (stray !== undefined) return stray;

  const payload: Record<string, unknown> = { id };
  if (input['name'] !== undefined) {
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    payload['name'] = name;
  }
  if (input['visibility'] !== undefined) {
    const visibility = optionalEnum(input, 'visibility', VISIBILITIES);
    if (isDraftError(visibility)) return visibility;
    payload['visibility'] = visibility;
  }
  const type = resolveTypeField(input, 'type', plan);
  if (type !== undefined && isDraftError(type)) return type;
  if (type !== undefined) Object.assign(payload, typeFields(type));
  if (input['multiplicity'] !== undefined) {
    const multiplicity = optionalMultiplicity(input, 'multiplicity');
    if (multiplicity !== undefined && isDraftError(multiplicity)) return multiplicity;
    payload['lowerBound'] = multiplicity?.lowerBound;
    payload['upperBound'] = multiplicity === undefined ? null : multiplicity.upperBound;
  }
  if (input['defaultValue'] !== undefined) {
    const defaultValue = optionalString(input, 'defaultValue', 2000);
    if (defaultValue !== undefined && isDraftError(defaultValue)) return defaultValue;
    payload['defaultValue'] = defaultValue;
  }
  const flags = readFlags(input, ['isStatic', 'isReadonly', 'isDerived', 'isAbstract', 'isQuery']);
  if (isDraftError(flags)) return flags;
  Object.assign(payload, flags.value);

  return Object.keys(payload).length <= 1 ? nothingToUpdate() : { ops: [{ type: 'feature.update', produces: null, payload }] };
}

function updateRelationship(input: Record<string, unknown>, id: string, plan: TurnPlan): DraftResult {
  const stray = strayFields(input, RELATIONSHIP_UPDATE_FIELDS);
  if (stray !== undefined) return stray;

  const ops: DraftOp[] = [];
  if (input['name'] !== undefined) {
    const name = requiredName(input, 'name');
    if (isDraftError(name)) return name;
    ops.push({ type: 'relationship.rename', produces: null, payload: { id, name } });
  }

  const sourceMultiplicity = optionalMultiplicity(input, 'sourceMultiplicity');
  if (sourceMultiplicity !== undefined && isDraftError(sourceMultiplicity)) return sourceMultiplicity;
  if (sourceMultiplicity !== undefined) {
    ops.push({
      type: 'relationshipEnd.setMultiplicity',
      produces: null,
      payload: { relationshipId: id, endIndex: 0, ...sourceMultiplicity },
    });
  }

  const targetMultiplicity = optionalMultiplicity(input, 'targetMultiplicity');
  if (targetMultiplicity !== undefined && isDraftError(targetMultiplicity)) return targetMultiplicity;
  if (targetMultiplicity !== undefined) {
    ops.push({
      type: 'relationshipEnd.setMultiplicity',
      produces: null,
      payload: { relationshipId: id, endIndex: 1, ...targetMultiplicity },
    });
  }

  if (input['aggregation'] !== undefined) {
    const aggregation = optionalEnum(input, 'aggregation', AGGREGATIONS);
    if (isDraftError(aggregation)) return aggregation;
    const targetUpper =
      targetMultiplicity?.upperBound ??
      (id.startsWith('new:') ? 1 : plan.relationshipEnd(id, 1)?.upperBound ?? null);
    if (aggregation === 'COMPOSITE' && targetUpper !== 1) {
      return compositeMultiplicityError();
    }
    if (aggregation !== undefined) {
      ops.push({
        type: 'relationshipEnd.setAggregation',
        produces: null,
        payload: { relationshipId: id, endIndex: 1, aggregation },
      });
    }
  }

  return ops.length === 0 ? nothingToUpdate() : { ops };
}

function buildEnds(
  source: { lowerBound: number; upperBound: number | null } | undefined,
  target: { lowerBound: number; upperBound: number | null } | undefined,
  aggregation: AggregationKind | undefined,
): { value: unknown[] } | DraftError {
  const sourceEnd = source ?? { lowerBound: 1, upperBound: 1 };
  const targetEnd = target ?? { lowerBound: 1, upperBound: 1 };
  if (aggregation === 'COMPOSITE' && targetEnd.upperBound !== 1) {
    return compositeMultiplicityError();
  }
  return {
    value: [
      { ...sourceEnd, isNavigable: false, aggregation: 'NONE' as AggregationKind },
      {
        ...targetEnd,
        isNavigable: false,
        aggregation: aggregation ?? ('NONE' as AggregationKind),
      },
    ],
  };
}

function compositeMultiplicityError(): DraftError {
  return draftError(
    'invalid_multiplicity',
    'Una composición exige que el extremo destino tenga multiplicidad con tope 1 (por ejemplo "1" o "0..1").',
  );
}

function nothingToUpdate(): DraftError {
  return draftError('nothing_to_update', 'La llamada no cambia ningún campo.');
}

function strayFields(input: Record<string, unknown>, allowed: readonly string[]): DraftError | undefined {
  const stray = Object.keys(input).filter((key) => key !== 'target' && !allowed.includes(key));
  if (stray.length === 0) return undefined;
  return draftError(
    'field_not_applicable',
    `Estos campos no aplican a este destino: ${stray.join(', ')}.`,
  );
}

function readFlags(
  input: Record<string, unknown>,
  fields: readonly string[],
): { value: Record<string, boolean> } | DraftError {
  const value: Record<string, boolean> = {};
  for (const field of fields) {
    if (input[field] === undefined) continue;
    const flag = optionalBoolean(input, field);
    if (isDraftError(flag)) return flag;
    if (flag !== undefined) value[field] = flag;
  }
  return { value };
}

function typeFields(
  type: TypeResolution | DraftError | undefined,
): Record<string, string> {
  if (type === undefined || isDraftError(type)) return {};
  return type.kind === 'element' ? { typeElementId: type.token } : { typeName: type.name };
}

function aliasField(
  input: Record<string, unknown>,
  field: string,
  expected: RefKind,
  plan: TurnPlan,
): AliasLookup | DraftError {
  const raw = input[field];
  if (typeof raw !== 'string' || raw.length === 0) {
    return draftError('invalid_input', `\`${field}\` es obligatorio: es un alias (e:3, f:7, r:2 o new:1).`);
  }
  return plan.resolveAliasOf(raw, expected, field);
}

const CLASSIFIER_KINDS: ElementKind[] = [
  'CLASS',
  'INTERFACE',
  'ENUMERATION',
  'DATATYPE',
  'PRIMITIVE_TYPE',
  'PACKAGE',
];

const VISIBILITIES: Visibility[] = ['PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE'];

const RELATIONSHIP_KINDS: RelationshipKind[] = [
  'ASSOCIATION',
  'GENERALIZATION',
  'INTERFACE_REALIZATION',
  'DEPENDENCY',
  'USAGE',
];

const AGGREGATIONS: AggregationKind[] = ['NONE', 'SHARED', 'COMPOSITE'];

const PARAMETER_DIRECTIONS = ['IN', 'OUT', 'INOUT'] as const;

/** El catálogo de validadores, para el bucle de la rebanada 3. */
export function hasValidator(toolName: string): boolean {
  return VALIDATORS[toolName] !== undefined;
}

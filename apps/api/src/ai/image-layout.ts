import type { AiImageMode, Rect } from '@umlive/contracts';
import { DEFAULT_ELEMENT_HEIGHT, DEFAULT_ELEMENT_WIDTH } from './ai-turn-plan';

/**
 * La posición de la foto al lienzo (M6, rebanada 3/4 — `ai-image-input`,
 * diseño D7). Función PURA y determinista: mismos ítems, mismas dimensiones y
 * mismos layouts existentes dan siempre el mismo resultado.
 *
 * ── Por qué el modelo no devuelve coordenadas del lienzo ────────────────────
 *
 * El modelo ve la FOTO, no el diagrama: lo único que puede decir con sentido es
 * «esta clase está al 62% del ancho y al 30% del alto». Pasarlo a coordenadas
 * del lienzo es cuenta del servidor, y hacerla acá —y no en el prompt— es lo que
 * permite verificar la conversión sin llamar a ningún proveedor.
 *
 * ── Tres respuestas, en este orden ──────────────────────────────────────────
 *
 * 1. **Posición normalizada válida** (`nx`/`ny` finitos dentro de `[0, 1]`): el
 *    rectángulo se CENTRA en `origen + (nx·W, ny·H)`.
 * 2. **Sin posición, o fuera de rango**: grilla de respaldo, en orden de plan.
 *    Es el respaldo de las posiciones que el modelo no pudo estimar; nunca se
 *    inventa una posición fina a partir de un dato dudoso.
 * 3. **Choque** (separación menor a `COLLISION_GAP` con algo ya ubicado): se
 *    empuja hacia abajo, como máximo `MAX_COLLISION_PUSHES` veces.
 *
 * En modo `modify` el origen se corre a la derecha de lo que ya existe y NUNCA
 * se toca un layout existente: el turno de imagen es de solo creación (PO-3).
 *
 * Especificación: `.../ai-image-input-backend/spec.md`, "Nada se escribe en
 * `diagram_operations` hasta la confirmación explícita" y FR-D22. Diseño:
 * `design.md` D7. `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Ancho del lienzo de la conversión. El alto sale del aspecto de la foto. */
export const IMAGE_CANVAS_WIDTH = 1600;

/** Origen del recuadro nuevo: mismo criterio que `ai-turn-plan.ts`. */
export const LAYOUT_ORIGIN_X = 40;
export const LAYOUT_ORIGIN_Y = 40;

/** Separación con lo que ya existe, en modo modificar. */
const EXISTING_COLUMN_GAP = 160;

/** Grilla de respaldo: 4 columnas, y una fila por debajo del lienzo. */
export const GRID_COLUMNS = 4;
export const GRID_COLUMN_STEP = 260;
export const GRID_ROW_STEP = 180;
export const GRID_TOP_OFFSET = 80;

/** Separación mínima entre dos rectángulos antes de considerarlos en choque. */
export const COLLISION_GAP = 40;

/** Tope de empujones hacia abajo: sin tope, un diagrama denso sería un bucle largo. */
export const MAX_COLLISION_PUSHES = 20;

/** Un rectángulo ya ubicado: alcanza con la geometría, sin saber de qué se trata. */
export interface LayoutObstacle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** La esquina del recuadro nuevo, ya en coordenadas del lienzo. */
interface LayoutOrigin {
  readonly x: number;
  readonly y: number;
}

/** La posición normalizada del centro de un ítem en la foto: `0..1` en los dos ejes. */
export interface ImagePosition {
  readonly nx: number;
  readonly ny: number;
}

/** Un ítem que necesita lugar en el lienzo, en orden de plan. */
export interface ImageLayoutItem {
  readonly index: number;
  /** `null` cuando el modelo no dio posición (o la dio fuera de rango). */
  readonly position: ImagePosition | null;
}

/** El lugar que le tocó a un ítem. */
export interface ImageLayoutPlacement {
  readonly index: number;
  readonly rect: Rect;
}

export interface ImageLayoutInput {
  readonly items: readonly ImageLayoutItem[];
  /** Dimensiones de la IMAGEN (ya orientadas por el cliente, D3). */
  readonly imageWidth: number;
  readonly imageHeight: number;
  /** Los layouts que ya existen en el diagrama. */
  readonly existing: readonly LayoutObstacle[];
  readonly mode: AiImageMode;
}

/**
 * Ubica los ítems nuevos en el lienzo. Devuelve una entrada por ítem, en el
 * mismo orden en que llegaron.
 */
export function layoutImageItems(input: ImageLayoutInput): readonly ImageLayoutPlacement[] {
  const canvasHeight = canvasHeightOf(input.imageWidth, input.imageHeight);
  const origin = originOf(input.existing, input.mode);

  // Los rectángulos ya ubicados son el obstáculo contra el que se resuelven los
  // choques: lo que existía más lo que este mismo turno fue ubicando.
  const placed: LayoutObstacle[] = [...input.existing];
  const placements: ImageLayoutPlacement[] = [];
  let unplaced = 0;

  for (const item of input.items) {
    const rect = isUsablePosition(item.position)
      ? centredRect(item.position!, origin, canvasHeight)
      : gridRect(unplaced++, origin, canvasHeight);

    const resolved = pushOutOfCollisions(rect, placed);
    placed.push(resolved);
    placements.push({ index: item.index, rect: resolved });
  }

  return placements;
}

/**
 * Alto del lienzo con el aspecto de la foto. Una dimensión inválida cae a un
 * cuadrado de 1600: la conversión no puede depender de un dato roto, y las
 * dimensiones reales ya las validó `readImageDimensions`.
 */
function canvasHeightOf(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return IMAGE_CANVAS_WIDTH;
  }
  return Math.round((IMAGE_CANVAS_WIDTH * height) / width);
}

/**
 * El origen del recuadro nuevo: esquina del lienzo en modo crear, y a la derecha
 * de todo lo que ya existe en modo modificar. Un diagrama sin layouts existentes
 * usa la esquina en los dos modos.
 */
function originOf(existing: readonly LayoutObstacle[], mode: AiImageMode): LayoutOrigin {
  if (mode === 'create' || existing.length === 0) {
    return { x: LAYOUT_ORIGIN_X, y: LAYOUT_ORIGIN_Y };
  }
  const right = Math.max(...existing.map((rect) => rect.x + rect.width));
  const top = Math.min(...existing.map((rect) => rect.y));
  return { x: right + EXISTING_COLUMN_GAP, y: top };
}

/** Posición utilizable: finita y dentro del rango que declara el contrato. */
function isUsablePosition(position: ImagePosition | null): boolean {
  if (position === null) return false;
  const { nx, ny } = position;
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
  return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
}

/** Rectángulo centrado en `origen + (nx·W, ny·H)`, con el tamaño por defecto. */
function centredRect(position: ImagePosition, origin: LayoutOrigin, canvasHeight: number): Rect {
  const centreX = origin.x + position.nx * IMAGE_CANVAS_WIDTH;
  const centreY = origin.y + position.ny * canvasHeight;
  return {
    // Nunca una coordenada negativa: un elemento que nace fuera del lienzo es un
    // elemento que no se puede ver ni agarrar con el mouse.
    x: Math.max(0, Math.round(centreX - DEFAULT_ELEMENT_WIDTH / 2)),
    y: Math.max(0, Math.round(centreY - DEFAULT_ELEMENT_HEIGHT / 2)),
    width: DEFAULT_ELEMENT_WIDTH,
    height: DEFAULT_ELEMENT_HEIGHT,
  };
}

/**
 * La `i`-ésima casilla de la grilla de respaldo, por debajo del lienzo y en
 * columnas de `GRID_COLUMNS` (D7).
 */
function gridRect(index: number, origin: LayoutOrigin, canvasHeight: number): Rect {
  return {
    x: Math.round(origin.x + (index % GRID_COLUMNS) * GRID_COLUMN_STEP),
    y: Math.round(origin.y + canvasHeight + GRID_TOP_OFFSET + Math.floor(index / GRID_COLUMNS) * GRID_ROW_STEP),
    width: DEFAULT_ELEMENT_WIDTH,
    height: DEFAULT_ELEMENT_HEIGHT,
  };
}

/**
 * Baja el rectángulo hasta que no choque con nada ya ubicado, como máximo
 * `MAX_COLLISION_PUSHES` veces. El orden de plan decide quién se mueve: el que
 * llega después se corre, el que ya estaba no se toca.
 */
function pushOutOfCollisions(rect: Rect, obstacles: readonly LayoutObstacle[]): Rect {
  let current = rect;
  for (let pushes = 0; pushes < MAX_COLLISION_PUSHES && collides(current, obstacles); pushes += 1) {
    current = { ...current, y: current.y + DEFAULT_ELEMENT_HEIGHT + COLLISION_GAP };
  }
  return current;
}

/** Choque AABB con `COLLISION_GAP` de separación mínima en los dos ejes. */
function collides(rect: Rect, obstacles: readonly LayoutObstacle[]): boolean {
  return obstacles.some(
    (other) =>
      Math.abs(centreOf(rect.x, rect.width) - centreOf(other.x, other.width)) <
        (rect.width + other.width) / 2 + COLLISION_GAP &&
      Math.abs(centreOf(rect.y, rect.height) - centreOf(other.y, other.height)) <
        (rect.height + other.height) / 2 + COLLISION_GAP,
  );
}

function centreOf(start: number, size: number): number {
  return start + size / 2;
}

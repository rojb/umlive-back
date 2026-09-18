import type { ElementLayoutView } from '@umlive/contracts';

/**
 * Auto-layout determinista (D8, FR-E13) — Fase 3, tarea 3.1.
 *
 * **Por qué es obligatorio y no un adorno de FR-E13**: `ElementsService`
 * mantiene la invariante de que TODO `UmlElement` tiene su fila en
 * `element_layouts`, sin excepción de `kind` — incluidos `PACKAGE` y
 * `COMMENT` (`uml/elements.service.ts:28-31`, con el comentario que lo dice:
 * *«un `UmlElement` sin fila de layout es un elemento que el lienzo no puede
 * ubicar»*). El importador escribe por Prisma directo y **esquiva ese
 * servicio**, así que la única forma de no dejar un paquete sin layout es que
 * el lector resuelva una geometría para cada fila.
 *
 * **Determinismo por índice de orden de documento, nunca por contador**: el
 * índice se asigna recorriendo el árbol en pre-orden (el orden del archivo).
 * Un contador que dependiera del orden de iteración de un `Map` haría que dos
 * imports del MISMO archivo dieran posiciones distintas, y el segundo export
 * de SC-E08 dejaría de coincidir (propiedad inversa de D8 del exportador).
 *
 * Propiedad de Fase 4 (`import-plan.ts`) que esta firma documenta: **toda
 * fila insertada en `uml_elements` lleva su fila en `element_layouts`; el
 * escritor no decide, copia el `geometry` que el lector ya resolvió.**
 */

/** `cols`, paso y tamaño del lienzo de la grilla (D8). Valores fijos, no configurables. */
export const AUTO_LAYOUT_COLS = 6;
export const AUTO_LAYOUT_X_STEP = 260;
export const AUTO_LAYOUT_Y_STEP = 180;
export const AUTO_LAYOUT_X_ORIGIN = 40;
export const AUTO_LAYOUT_Y_ORIGIN = 40;
export const AUTO_LAYOUT_WIDTH = 200;
export const AUTO_LAYOUT_HEIGHT = 120;

/**
 * Una celda de la grilla para el elemento en la posición `documentIndex`.
 * `x`/`y` pueden ser positivos siempre (origen `40`); nada acá restringe el
 * signo — la restricción real es `ck_layout_size`, solo sobre el tamaño.
 */
export function autoLayoutAt(documentIndex: number): Pick<ElementLayoutView, 'x' | 'y' | 'width' | 'height'> {
  const index = Number.isFinite(documentIndex) && documentIndex > 0 ? Math.floor(documentIndex) : 0;
  const column = index % AUTO_LAYOUT_COLS;
  const row = Math.floor(index / AUTO_LAYOUT_COLS);
  return {
    x: AUTO_LAYOUT_X_ORIGIN + column * AUTO_LAYOUT_X_STEP,
    y: AUTO_LAYOUT_Y_ORIGIN + row * AUTO_LAYOUT_Y_STEP,
    width: AUTO_LAYOUT_WIDTH,
    height: AUTO_LAYOUT_HEIGHT,
  };
}

/**
 * El texto del conflicto de lock, en UN solo lugar (`concurrency-ux` D5).
 *
 * Existe porque el MISMO aviso lo tienen que producir dos consumidores que no
 * comparten interfaz: la Web (aviso del gesto cortado, acuse del diálogo de
 * borrado, traducción de `op:rejected ELEMENT_LOCKED`) y el script de
 * verificación de la defensa (C08, que corre fuera del repo con el `dist` CJS
 * de este paquete). Si el formateador viviera solo en la Web, el criterio de
 * éxito "el aviso de la interfaz es idéntico al del script" sería falso por
 * construcción: estaría comparando dos implementaciones distintas que hoy
 * coinciden por casualidad.
 *
 * Función PURA y sin dependencias de ejecución, mismo criterio que
 * `presenceColor` (`events.ts`): el `import type` se borra al compilar, así
 * que este archivo no arrastra nada en runtime y lo puede consumir el script
 * con `require('@umlive/contracts')` sin levantar la Web.
 *
 * No vive en el servidor a propósito: `OperationRejected.message` y
 * `lock:denied` no llevan el nombre del elemento (el servidor tendría que
 * releerlo después del rollback, y `lock:denied` no tiene `message`), así que
 * el nombre lo resuelve cada cliente desde su propio estado.
 */

import type { LockHolder } from './operations';

/**
 * Qué se está señalando, ya resuelto por el cliente desde su store.
 *
 * `null` significa "el cliente no pudo resolver el objetivo" (elemento que ya
 * no está en su estado, por ejemplo): el mensaje tiene que salir igual, con el
 * texto de relleno, nunca con un hueco ni con un `[object Object]`.
 *
 * El nombre lleva `Conflict` y no es el `LockTarget` de `tasks.md` 1.1 / D5: ese
 * nombre ya está tomado en la raíz del paquete por `element-lock-enforcement`
 * (`operations.ts`, `LockTarget<T extends OperationType>`, cómo se resuelve el
 * id que exige cada operación). Con `export *` en `index.ts`, dos tipos
 * homónimos no compilan (TS2308) — y dejar uno de los dos detrás de un alias
 * daría dos nombres para el mismo tipo. Desviación fechada 2026-09-18 en
 * `tasks.md` 1.1.
 */
export type LockConflictTarget = { kind: 'element' | 'relationship'; name: string | null } | null;

/** Texto de relleno cuando el cliente no tiene el nombre — mismo criterio para elemento y relación sin nombre. */
const UNNAMED_ELEMENT = 'Un elemento de este diagrama';
const UNNAMED_RELATIONSHIP = 'Una relación';

/**
 * «Cliente» lo está editando Diego Rojas
 *
 * Una sola oración, sin prefijo y sin punto final: el llamador que necesite
 * encabezarla (el diálogo de borrado: «No se puede borrar «ventas»: …») le
 * antepone su texto, y la oración central queda idéntica byte por byte a la
 * del script. Los guillemets son parte de la oración, no decoración del
 * llamador.
 */
export function describeLockConflict(holder: LockHolder, target: LockConflictTarget): string {
  return `${describeTarget(target)} lo está editando ${holder.displayName}`;
}

/**
 * Sujeto de la oración. Los dos textos de relleno —y la rama `null`— existen
 * para que NUNCA se lea «null lo está editando …»: un elemento recién creado
 * (todavía sin nombre) o una relación anónima son casos normales, no errores.
 */
function describeTarget(target: LockConflictTarget): string {
  if (!target) return UNNAMED_ELEMENT;
  if (target.name === null || target.name.length === 0) {
    return target.kind === 'relationship' ? UNNAMED_RELATIONSHIP : UNNAMED_ELEMENT;
  }
  return `«${target.name}»`;
}

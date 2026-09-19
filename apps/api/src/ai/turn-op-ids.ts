import { createHash } from 'node:crypto';

/**
 * Identificadores deterministas de un lote (M6, rebanada 2/4 —
 * `ai-text-instructions`, diseño D4).
 *
 * ── Por qué deterministas ──────────────────────────────────────────────────
 *
 * El `opId` de un lote se DERIVA del turno, no se inventa: `uuidV5(turnId,
 * 'apply:i')`. Con eso, reintentar el mismo turno produce exactamente el mismo
 * `op_id`, y la idempotencia del lote es la MISMA consulta `(diagramId, opId)`
 * que ya usa el pipeline humano (D6 de `operations-pipeline`): la segunda
 * corrida lee la fila y devuelve el eco sin escribir nada.
 *
 * Un `opId` aleatorio rompería eso justo en el caso que importa: el cliente
 * reintenta después de una conexión cortada y el diagrama queda con las
 * operaciones duplicadas.
 *
 * `uuidV5` es RFC 4122: SHA-1 de los 16 bytes del namespace concatenados con el
 * nombre, primeros 16 bytes del digest, con los bits de versión (5) y variante
 * fijados. ~10 líneas con `node:crypto`; no vale la pena una dependencia.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */

/** Espacio de nombres en bytes. Un namespace mal formado falla ACÁ, no en PostgreSQL. */
function namespaceBytes(namespace: string): Buffer {
  const hex = namespace.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`uuidV5: el espacio de nombres "${namespace}" no es un UUID.`);
  }
  return Buffer.from(hex, 'hex');
}

/** UUID v5 (SHA-1) del par namespace/nombre. Determinista y estable entre corridas. */
export function uuidV5(namespace: string, name: string): string {
  const digest = createHash('sha1').update(namespaceBytes(namespace)).update(name, 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // versión 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * El `opId` de la operación `index` de un lote. `prefix` distingue los dos
 * lotes que cuelgan del mismo `turnId`: `apply` es el turno y `undo` su
 * deshacer, así que `undo:0` es la marca de "este turno ya se deshizo" (D5).
 */
export function batchOpId(batchKey: string, prefix: string, index: number): string {
  return uuidV5(batchKey, `${prefix}:${index}`);
}

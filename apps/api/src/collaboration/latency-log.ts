import { Logger } from '@nestjs/common';

/**
 * Línea de latencia por operación y por transición de lock (D7 de
 * `nfr-verification-and-security-hardening/design.md`, fila de Observability
 * de `PRD.md` §7).
 *
 * **Siempre activa**, porque el PRD pide «every operation». Su costo de stdout
 * queda incluido en lo que se mide, y eso es lo honesto: lo que el presupuesto
 * mide es el trabajo real del servidor, no el trabajo del servidor menos su
 * propio log.
 *
 * Formato (una línea por evento, `kind=op` para operaciones y `kind=lock` para
 * transiciones de bloqueo):
 *
 *   [Latency] v=1 kind=op   corr=<opId>     actor=<userId> diagram=<id> type=element.move   outcome=committed|echo|rejected:<code> ms=3.42
 *   [Latency] v=1 kind=lock corr=<socketId> actor=<userId> diagram=<id> type=lock.request    outcome=granted|denied|frozen       el=<elementId|n> ms=0.08
 *   [Latency] v=1 kind=lock corr=-          actor=-         diagram=<id> type=lock.release    outcome=released|expired|…           el=<elementId> ms=-
 *
 * `ms` sale de `process.hrtime.bigint()`, que es monótono — un ajuste de reloj
 * de pared a mitad de la corrida no puede producir un tiempo negativo. Las
 * liberaciones no llevan `ms`: no hay una petición del cliente que medir.
 *
 * Procesamiento: `rg -o "kind=op .*ms=([0-9.]+)" -r '$1' api.log`, ordenar y
 * tomar p95/p99. Lo hace un script descartable, fuera del repo.
 */

const logger = new Logger('Latency');

function msSince(t0: bigint): string {
  return (Number(process.hrtime.bigint() - t0) / 1_000_000).toFixed(2);
}

export interface OpLatencyFields {
  /** `opId` de la operación — el identificador de correlación del log de operaciones. */
  corr: string;
  actor: string;
  diagram: string;
  type: string;
  /** `committed`, `echo` o `rejected:<reason>`. */
  outcome: string;
}

export interface LockLatencyFields extends OpLatencyFields {
  /** `elementId` de la transición, o ausente para un lote / una liberación sin id único. */
  elementId?: string;
}

/** `t0` se toma al ENTRAR al handler y la llamada va DESPUÉS de emitir. */
export function logOpLatency(t0: bigint, fields: OpLatencyFields): void {
  logger.log(
    `v=1 kind=op corr=${fields.corr} actor=${fields.actor} diagram=${fields.diagram} type=${fields.type} outcome=${fields.outcome} ms=${msSince(t0)}`,
  );
}

/** `t0` en `null` = transición sin petición propia (liberación): `ms=-`. */
export function logLockLatency(t0: bigint | null, fields: LockLatencyFields): void {
  const ms = t0 === null ? '-' : msSince(t0);
  logger.log(
    `v=1 kind=lock corr=${fields.corr} actor=${fields.actor} diagram=${fields.diagram} type=${fields.type} outcome=${fields.outcome} el=${fields.elementId ?? 'n'} ms=${ms}`,
  );
}

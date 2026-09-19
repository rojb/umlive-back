import { Logger } from '@nestjs/common';
import * as dns from 'dns/promises';

/**
 * Diagnóstico de INV-H1: «en todo momento hay a lo sumo un proceso de la API
 * aceptando conexiones» (`hosted-deployment` D4).
 *
 * **Solo loguea, nunca hace `exit`.** Media sala y la presencia, los locks
 * (`locks.service.ts`), el turno de IA en curso y el plan de vista previa viven
 * en la memoria de ESTE proceso: si el sondeo terminara el proceso por un falso
 * positivo, tiraría la única máquina en vivo. Una línea de monitoreo que mata la
 * app es peor que no tener monitoreo.
 *
 * Sin `FLY_APP_NAME` (dev y offline) es un no-op: no hay DNS privado que
 * resolver fuera de la plataforma.
 */

/**
 * Retardo del sondeo, medido desde que `listen` resolvió (D4).
 *
 * No es decorativo: la máquina recién arrancó, el proxy puede estar todavía
 * asentándose y `<app>.internal` solo resuelve máquinas encendidas. Sondear en
 * el mismo tick que el arranque reportaría lo que todavía no está listo.
 */
const PROBE_DELAY_MS = 60_000;

/**
 * Arranca el sondeo. `main.ts` la llama DESPUÉS de `listen` y con `void`: es un
 * diagnóstico, no bloquea el arranque ni participa del ciclo de vida.
 */
export async function logSingleInstance(): Promise<void> {
  const appName = process.env.FLY_APP_NAME;
  if (!appName) return;

  await delay(PROBE_DELAY_MS);

  try {
    const addresses = await dns.resolve6(`${appName}.internal`);
    if (addresses.length > 1) {
      Logger.error(`INV-H1 violado: N máquinas detectadas: ${addresses.length}`);
    } else {
      Logger.log(
        `INV-H1 ok: FLY_MACHINE_ID=${process.env.FLY_MACHINE_ID} FLY_REGION=${process.env.FLY_REGION}`
      );
    }
  } catch (err) {
    // Un fallo del DNS privado no prueba que haya dos máquinas: se reporta y se
    // sigue sirviendo. Ver la cabecera.
    Logger.error('Fallo al verificar singularidad de instancia', err);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

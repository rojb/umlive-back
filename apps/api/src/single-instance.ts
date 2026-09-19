import { Logger } from '@nestjs/common';
import * as dns from 'dns/promises';

export async function logSingleInstance() {
  const appName = process.env.FLY_APP_NAME;
  if (!appName) return;

  try {
    const addresses = await dns.resolve6(`${appName}.internal`);
    if (addresses.length > 1) {
      Logger.error(`INV-H1 violado: N máquinas detectadas: ${addresses.length}`);
    } else {
      Logger.log(
        `Hosteado: FLY_MACHINE_ID=${process.env.FLY_MACHINE_ID} FLY_REGION=${process.env.FLY_REGION}`
      );
    }
  } catch (err) {
    Logger.error('Fallo al verificar singularidad de instancia', err);
  }
}

import { config as loadEnv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Prisma 7 cambió a carga explícita de entorno: ya no lee `.env` solo.
 * Se carga a mano y desde una ruta anclada a este archivo, para que los
 * comandos funcionen igual si se corren desde `apps/api` o desde la raíz
 * vía `npm run --workspace`.
 */
loadEnv({ path: resolve(here, '.env') });

export default defineConfig({
  schema: resolve(here, 'prisma/schema.prisma'),
  migrations: {
    path: resolve(here, 'prisma/migrations'),
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});

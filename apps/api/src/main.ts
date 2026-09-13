import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AppModule } from './app.module.js';

/**
 * ORIGEN ÚNICO (PRD §9, Apéndice B.7).
 *
 * Esta misma aplicación sirve la API, el WebSocket y el bundle de React.
 * No es preferencia: con orígenes separados la cookie de refresh pasa a ser
 * cross-site, necesita `SameSite=None` y queda sujeta a las restricciones de
 * cookies de terceros. El modo de falla es el peor — anda en el navegador del
 * que desarrolla y falla en silencio en el del evaluador, deslogueando a mitad
 * de demo.
 *
 * Con un solo origen: cookie first-party `SameSite=Lax`, sin CORS, WebSocket
 * same-origin, y un solo artefacto que desplegar.
 */

/**
 * Se resuelve contra este archivo y no contra `process.cwd()`, para que el
 * proceso arranque igual desde la raíz, desde `apps/api` o desde un contenedor.
 * Compilado queda en `apps/api/dist/main.js`, así que `../../web/dist` apunta
 * a `apps/web/dist`.
 */
const webRoot =
  process.env.WEB_DIST_PATH ??
  fileURLToPath(new URL('../../web/dist/', import.meta.url));

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['health'] });

  // El bundle de la web, servido desde acá. Sin CORS porque no hay otro origen.
  app.useStaticAssets(webRoot, { index: false });

  // Fallback de SPA: cualquier ruta que no sea API ni socket devuelve el index.
  app.use((req: any, res: any, next: any) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(join(webRoot, 'index.html'));
  });

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();

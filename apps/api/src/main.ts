import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { join } from 'node:path';
import { AppModule } from './app.module';

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
  process.env.WEB_DIST_PATH ?? join(__dirname, '..', '..', 'web', 'dist');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(cookieParser());

  // D3 (xmi-import): el limite del body JSON **se declara**, no se hereda.
  // El XMI NO viaja por `json()` —viaja como multipart, y multer lo consume
  // antes de que body-parser lo vea—, pero un default invisible es como nacio
  // el riesgo de la compuerta [0]: nadie sabia que regia 100 kB hasta que un
  // archivo de 1.2 MB respondio 413. 256 kB es holgado para los DTOs reales y
  // no compite con el tope de 50 MB de la subida.
  app.useBodyParser('json', { limit: '256kb' });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['health'] });

  // El bundle de la web, servido desde acá. Sin CORS porque no hay otro origen.
  app.useStaticAssets(webRoot, { index: false });

  // Fallback de SPA: cualquier ruta que no sea API, socket ni sonda devuelve
  // el index.
  //
  // `|| req.path === '/health'` (offline-docker-compose, tarea 2.3, 2026-09-19).
  // Este middleware se registra ANTES de que Nest monte el router, así que sin
  // la exclusión `GET /health` respondía el `index.html` de la SPA con 200 y el
  // healthcheck del compose pasaba con la base caída.
  //
  // ⚠️ CONFLICTO CONOCIDO: `nfr-verification-and-security-hardening` toca esta
  // misma línea (404 para `/assets/*` y `*.map`). La rebanada que se aplique
  // SEGUNDA tiene que rebasar/mergear este bloque a mano antes de commitear,
  // sin pisar el cambio de la otra.
  app.use((req: any, res: any, next: any) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/socket.io') ||
      req.path === '/health'
    ) {
      return next();
    }
    res.sendFile(join(webRoot, 'index.html'));
  });

  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();

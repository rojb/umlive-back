import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

/**
 * Headers de seguridad (D3 de `nfr-verification-and-security-hardening/design.md`).
 *
 * `helmet` con configuración EXPLÍCITA, no los defaults:
 *
 *   · **CSP propia sin `upgrade-insecure-requests`.** El default de `helmet`
 *     incluye esa directiva, y rompe la demo offline por `http://<IP-LAN>`: el
 *     navegador reescribiría cada subrecurso a `https://` y nada cargaría.
 *   · **HSTS fuera de este middleware.** En `http://` el navegador lo ignora
 *     (RFC 6797 §8.1), pero emitirlo igual en la demo LAN es ruido y, si algún
 *     día se sirviera por un nombre de host, una promesa de HTTPS que no existe.
 *     Se aplica aparte y **solo cuando `req.secure`**.
 *   · **`frame-ancestors 'none'` y `frameguard: deny`** cubren el framing por
 *     CSP3 y por el header clásico, para los navegadores que todavía usan el
 *     segundo.
 *
 * El `X-Powered-By` lo saca `helmet.hidePoweredBy` (default de `helmet`).
 */
export function applyHttpSecurity(app: INestApplication): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Sin `https:`: no hay estilos externos. `'unsafe-inline'` cubre los
          // `<style>` que alguna librería del lienzo pueda inyectar; React
          // aplica `style={{}}` por CSSOM, que la CSP no controla.
          styleSrc: ["'self'", "'unsafe-inline'"],
          // `blob:` lo usa la vista previa de `ai-image-input`.
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          // `null` = no incluir la directiva (PO-1: rompería `http://<IP-LAN>`).
          upgradeInsecureRequests: null,
        },
      },
      // Desactivado acá: se aplica condicionalmente abajo.
      strictTransportSecurity: false,
      frameguard: { action: 'deny' },
    }),
  );

  // HSTS solo bajo un request resuelto como seguro. `maxAge` de 180 días e
  // `includeSubDomains: false` — el dominio padre de la plataforma no es
  // nuestro. Con `TRUST_PROXY_HOPS ≥ 1`, `req.secure` lee `X-Forwarded-Proto`
  // del salto confiable; sin configurar (0), nunca se emite en HTTP plano.
  const hsts = helmet.strictTransportSecurity({ maxAge: 15_552_000, includeSubDomains: false });
  app.use((req: Request, res: Response, next: NextFunction) => (req.secure ? hsts(req, res, next) : next()));
}

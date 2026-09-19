import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Plazo de la sonda. `pg` no fija `connectionTimeoutMillis` por defecto: sin un
 * tope propio, una base colgada deja el healthcheck del compose esperando y
 * `up --wait` no vuelve nunca. El modo de falla es peor que un 503.
 */
const DB_PING_TIMEOUT_MS = 2000;

/**
 * `GET /health` — sonda de vida de la base (design.md · D3).
 *
 * `@Public()` es obligatorio: `JwtAuthGuard` es global. `ProjectAccessGuard`
 * la deja pasar porque la ruta no trae `projectId`.
 *
 * Esta ruta NO puede caer en el fallback de SPA de `main.ts`: ese middleware se
 * registra antes de que Nest monte el router, así que sin la exclusión un
 * `/health` devolvía el `index.html` con 200 aunque la base estuviera caída —
 * el healthcheck del compose pasaría siempre. Ver `main.ts`.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    if (!(await this.ping())) {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok' };
  }

  private async ping(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), DB_PING_TIMEOUT_MS);
      // No mantiene vivo el event loop si la query ganó la carrera.
      timer.unref?.();
    });

    try {
      const probe = this.prisma.$queryRaw`SELECT 1`.then(
        () => true,
        (error: unknown) => {
          this.logger.warn(`la base no responde: ${(error as Error).message}`);
          return false;
        },
      );
      return await Promise.race([probe, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

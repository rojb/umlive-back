import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Inyectado como proveedor de Nest. Los servicios lo usan directo — no hay
 * interfaces de repositorio envolviendo al ORM (PRD §9: arquitectura por
 * defecto de NestJS, sin hexagonal).
 *
 * ── Por qué hay un adapter explícito ────────────────────────────────────────
 *
 * **Prisma 7 lo exige.** Hasta la versión 6, `new PrismaClient()` sin argumentos
 * funcionaba: Prisma manejaba la conexión internamente desde su query engine.
 * La 7 pasó a una arquitectura de adapters y ahora el constructor **falla** si
 * no recibe `adapter` o `accelerateUrl`:
 *
 *   PrismaClient needs to be constructed with a non-empty, valid
 *   PrismaClientOptions
 *
 * El síntoma es tardío y despista: compila sin una queja y revienta recién al
 * instanciar el módulo, o sea al arrancar el proceso.
 *
 * ── Por qué el connectionString sale de ConfigService y no de process.env ───
 *
 * Para que la ausencia de `DATABASE_URL` falle **acá**, con un mensaje que la
 * nombra, en vez de más adelante como un error de conexión sin causa aparente.
 * `getOrThrow` es justamente eso.
 *
 * Usar un parámetro del constructor dentro de `super()` es legal — lo prohibido
 * es tocar `this` antes de que `super()` termine.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

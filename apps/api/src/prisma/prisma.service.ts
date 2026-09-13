import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Inyectado como proveedor de Nest. Los servicios lo usan directo — no hay
 * interfaces de repositorio envolviendo al ORM (PRD §9: arquitectura por
 * defecto de NestJS, sin hexagonal).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

import { Module } from '@nestjs/common';
import { LocksService } from './locks.service';

/**
 * Tiempo real y concurrencia. Es el hito M4 y el de mayor riesgo del proyecto.
 *
 * Piezas previstas:
 *   locks.service.ts       exclusión por elemento — hecho
 *   operations.service.ts  validación, orden y persistencia del log
 *   presence.service.ts    cursores y selección
 *   collaboration.gateway.ts  el WebSocket que las une
 */
@Module({ providers: [LocksService], exports: [LocksService] })
export class CollaborationModule {}

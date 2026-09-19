import { Module } from '@nestjs/common';
import { AiCallService } from './ai-call.service';
import { AiConfigService } from './ai-config.service';
import { AiController } from './ai.controller';
import { AiSpendService } from './ai-spend.service';
import { AiToolsService } from './ai-tools';
import { AI_ENV, aiEnvProvider } from './providers/llm-provider.factory';

/**
 * Módulo de la capa de proveedores de IA (M6, rebanada 1/4).
 *
 * Reúne las tres fases del backend: el entorno resuelto `AI_ENV` (fase 3), el
 * libro de gasto `AiSpendService` (fase 4) y la orquestación `AiCallService` +
 * `AiConfigService` con sus rutas (fase 5).
 *
 * **Sin imports**: `PrismaModule` y `ConfigModule` son globales (design D5),
 * así que no hace falta traerlos acá. Exporta los tres servicios para que la
 * rebanada 2 (chat) los consuma sin volver a montarlos.
 *
 * `AiToolsService` se registra para que su `onModuleInit` corra: la guarda de
 * palabras clave del catálogo (D6 de `ai-text-instructions`) audita los siete
 * esquemas al arrancar, no en el primer turno real. Traer `UmlModule` y
 * `CollaborationModule` es de la fase 5 de esa rebanada.
 */
@Module({
  controllers: [AiController],
  providers: [aiEnvProvider, AiSpendService, AiConfigService, AiCallService, AiToolsService],
  exports: [AI_ENV, AiSpendService, AiConfigService, AiCallService, AiToolsService],
})
export class AiModule {}

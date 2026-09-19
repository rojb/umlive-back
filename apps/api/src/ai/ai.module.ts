import { Module } from '@nestjs/common';
import { CollaborationModule } from '../collaboration/collaboration.module';
import { UmlModule } from '../uml/uml.module';
import { AiCallService } from './ai-call.service';
import { AiConfigService } from './ai-config.service';
import { AiController } from './ai.controller';
import { AiPreviewStore } from './ai-preview.store';
import { AiSpendService } from './ai-spend.service';
import { AiToolsService } from './ai-tools';
import { AiTranscriptionService } from './ai-transcription.service';
import { AiTranscriptionsController } from './ai-transcriptions.controller';
import { AiTurnService } from './ai-turn.service';
import { AiTurnsController } from './ai-turns.controller';
import { AI_ENV, aiEnvProvider } from './providers/llm-provider.factory';

/**
 * Módulo de la capa de proveedores de IA (M6, rebanada 1/4) y del turno de
 * texto/voz (rebanada 2/4).
 *
 * Reúne las tres fases del backend: el entorno resuelto `AI_ENV` (fase 3), el
 * libro de gasto `AiSpendService` (fase 4), la orquestación `AiCallService` +
 * `AiConfigService` con sus rutas (fase 5) y, desde `ai-text-instructions`,
 * `AiTurnService` con las dos rutas del turno (D9). Desde `ai-image-input`,
 * `AiPreviewStore` guarda en memoria el plan del turno de foto hasta que el
 * humano lo confirma o vence (D8). Desde `ai-voice-server-fallback`,
 * `AiTranscriptionService` sirve la ruta de transcripción de voz (FR-D20).
 *
 * `AiToolsService` se registra para que su `onModuleInit` corra: la guarda de
 * palabras clave del catálogo (D6 de `ai-text-instructions`) audita los siete
 * esquemas al arrancar, no en el primer turno real.
 *
 * **Imports (tarea 5.10).** `CollaborationModule` presta lo que el turno
 * necesita para escribir por la MISMA puerta que un humano —`OperationsService`
 * (`applyBatch`), `LocksService` (`acquireAllTracked`) y `CollaborationGateway`
 * (la difusión posterior al `COMMIT`)— y `UmlModule` presta
 * `DiagramContentService`, la foto con la que se planifica. **Sin ciclo**: la
 * dependencia va en un solo sentido, nadie importa `AiModule`.
 *
 * `PrismaModule` y `ConfigModule` son globales (design D5), así que no hacen
 * falta acá.
 */
@Module({
  imports: [CollaborationModule, UmlModule],
  controllers: [AiController, AiTurnsController, AiTranscriptionsController],
  providers: [aiEnvProvider, AiSpendService, AiConfigService, AiCallService, AiToolsService, AiTurnService, AiPreviewStore, AiTranscriptionService],
  exports: [AI_ENV, AiSpendService, AiConfigService, AiCallService, AiToolsService],
})
export class AiModule {}

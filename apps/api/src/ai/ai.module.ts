import { Module } from '@nestjs/common';
import { AI_ENV, aiEnvProvider } from './providers/llm-provider.factory';

/**
 * Módulo de la capa de proveedores de IA (M6, rebanada 1/4).
 *
 * Por ahora exporta solo el entorno resuelto `AI_ENV` (fase 3: interfaz,
 * catálogo, adaptador y fábrica). Los servicios del libro de gasto y de
 * orquestación (`AiSpendService`, `AiCallService`, `AiConfigService`) y sus
 * rutas llegan en las fases 4/5 de esta misma rebanada, dentro de este módulo.
 *
 * Sin imports: `PrismaModule` y `ConfigModule` son globales (design D5), así
 * que no hace falta traerlos acá. Tampoco se importa este módulo todavía desde
 * `app.module.ts` — eso es la tarea 5.7.
 */
@Module({
  providers: [aiEnvProvider],
  exports: [AI_ENV],
})
export class AiModule {}

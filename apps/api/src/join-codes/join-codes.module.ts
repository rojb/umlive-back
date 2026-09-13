import { Module } from '@nestjs/common';
import { JoinCodesController } from './join-codes.controller';
import { JoinCodesService } from './join-codes.service';
import { RedemptionAttemptsService } from './redemption-attempts.service';
import { RedemptionController } from './redemption.controller';
import { RedemptionThrottleGuard } from './redemption-throttle.guard';
import { RedemptionService } from './redemption.service';

/**
 * Módulo propio, no dentro de `ProjectsModule` (design.md §1): la redención
 * no es una ruta de proyecto — meter en `ProjectsModule` un controlador
 * cuyo prefijo no es `/projects` y cuya autorización no es la matriz
 * escondería la excepción dentro del módulo cuya regla rompe.
 *
 * No importa `ProjectsModule`: `PrismaModule` es `@Global()` y
 * `@RequiresProjectAction` se importa por ruta relativa — no hace falta y
 * no se introduce ningún ciclo (design.md §1, costo declarado).
 */
@Module({
  controllers: [JoinCodesController, RedemptionController],
  providers: [JoinCodesService, RedemptionService, RedemptionAttemptsService, RedemptionThrottleGuard],
})
export class JoinCodesModule {}

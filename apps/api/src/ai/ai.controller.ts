import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { AI_ERROR, type AiConfigView, type AiSpendView } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { AiConfigService } from './ai-config.service';
import { AiSpendService, type SpendRejection } from './ai-spend.service';
import { UpdateAiConfigDto } from './dto/update-ai-config.dto';

/**
 * Las rutas de D6, todas bajo `/projects/:projectId/...` → pasan por
 * `ProjectAccessGuard` (design §1) y declaran su acción con
 * `@RequiresProjectAction`. Una ruta de alcance de proyecto sin esa acción
 * responde `403`: el olvido cierra, nunca abre.
 *
 * | Ruta | Acción |
 * |---|---|
 * | `GET .../ai/config` | `ai.use` |
 * | `PUT .../ai/config` | `ai.configure` |
 * | `DELETE .../ai/config` | `ai.configure` |
 * | `GET .../ai/spend` | `ai.use` |
 *
 * `POST .../ai/health-check` (`ai.configure`) es la tarea 7.8 (Fase 7, fuera de
 * alcance) y no se registra acá.
 *
 * Ninguna respuesta expone una clave: `AiConfigView` solo dice
 * `hasProjectKey` (SC-D05).
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Gasto y
 * configuración visibles solo a miembros…". `apps/api` CommonJS: sin `.js`.
 */
@Controller('projects/:projectId/ai')
export class AiController {
  constructor(
    private readonly config: AiConfigService,
    private readonly spend: AiSpendService,
  ) {}

  @Get('config')
  @RequiresProjectAction('ai.use')
  getConfig(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<AiConfigView> {
    return this.config.resolve(projectId);
  }

  @Put('config')
  @RequiresProjectAction('ai.configure')
  putConfig(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateAiConfigDto,
  ): Promise<AiConfigView> {
    return this.config.update(projectId, dto);
  }

  @Delete('config')
  @RequiresProjectAction('ai.configure')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteConfig(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<void> {
    return this.config.clear(projectId);
  }

  @Get('spend')
  @RequiresProjectAction('ai.use')
  getSpend(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<AiSpendView> {
    return this.spend.spendView(projectId);
  }
}

/**
 * Traducción HTTP de un rechazo del libro de gasto (tarea 5.5).
 *
 * Se devuelve el `status`, el cuerpo y los encabezados en vez de lanzar una
 * `HttpException` porque `Retry-After` viaja por encabezado y la
 * `HttpException` de Nest 12 ya no acepta `headers` en sus opciones. La
 * consumen las rutas que ABREN un turno —`POST .../ai/health-check` (Fase 7) y
 * el chat de la rebanada 2—, no las cuatro rutas de configuración y gasto, que
 * no reservan nada.
 *
 * - `rate_limited` → `429`, `Retry-After` en segundos hasta `retryAt`.
 * - `ceiling` / `ceiling_not_configured` → `409`: el entorno no deja gastar más
 *   (o no declaró techo), que es un conflicto con el estado del servidor, no
 *   un pedido mal formado.
 */
export function spendRejectionToHttp(rejection: SpendRejection): {
  readonly status: number;
  readonly body: Record<string, string>;
  readonly headers: Record<string, string>;
} {
  if (rejection.reason === 'rate_limited') {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((rejection.retryAt.getTime() - Date.now()) / 1000),
    );
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: { code: AI_ERROR.RATE_LIMITED, retryAt: rejection.retryAt.toISOString() },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    };
  }

  return {
    status: HttpStatus.CONFLICT,
    body: {
      code:
        rejection.reason === 'ceiling'
          ? AI_ERROR.SPEND_CEILING_REACHED
          : AI_ERROR.CEILING_NOT_CONFIGURED,
    },
    headers: {},
  };
}

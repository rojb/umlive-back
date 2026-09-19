import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { AI_ERROR, type AiConfigView, type AiHealthCheckResult, type AiSpendView } from '@umlive/contracts';
import type { Response } from 'express';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { AiCallService } from './ai-call.service';
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
 * | `POST .../ai/health-check` | `ai.configure` |
 *
 * Ninguna respuesta expone una clave: `AiConfigView` solo dice
 * `hasProjectKey` (SC-D05). La clave BYO viaja en el `PUT` y no vuelve.
 *
 * Especificación: `.../ai-provider-layer-backend/spec.md`, "Gasto y
 * configuración visibles solo a miembros…" y "Prueba de conexión por
 * proveedor". `apps/api` CommonJS: sin `.js`.
 */
@Controller('projects/:projectId/ai')
export class AiController {
  constructor(
    private readonly config: AiConfigService,
    private readonly spend: AiSpendService,
    private readonly calls: AiCallService,
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

  /**
   * `POST .../ai/health-check` (tarea 7.8, FR-D13): solo el host.
   *
   * Traducción de los rechazos, igual que el chat de la rebanada 2:
   *
   * | Caso | Respuesta |
   * |---|---|
   * | corrido (aunque un paso falle) | `200` con `AiHealthCheckResult` |
   * | sin diagramas | `409 ai_health_check_needs_diagram` |
   * | techo / sin techo | `409` de `spendRejectionToHttp` |
   * | límite de ritmo | `429` con `Retry-After` |
   *
   * El `@HttpCode(200)` es explícito: sin él Nest responde `201 Created`, que
   * para una prueba de conexión es una mentira — no se creó ningún recurso.
   *
   * Se usa `@Res({ passthrough: true })` en vez de lanzar una `HttpException`
   * por la misma razón que `spendRejectionToHttp` devuelve encabezados: Nest 12
   * ya no acepta `headers` en las opciones de la excepción.
   */
  @Post('health-check')
  @RequiresProjectAction('ai.configure')
  @HttpCode(HttpStatus.OK)
  async healthCheck(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiHealthCheckResult | Record<string, string>> {
    const outcome = await this.calls.healthCheck(projectId, user.id);

    if (outcome.kind === 'needs_diagram') {
      res.status(HttpStatus.CONFLICT);
      return { code: AI_ERROR.HEALTH_CHECK_NEEDS_DIAGRAM };
    }

    if (outcome.kind === 'rejected') {
      const http = spendRejectionToHttp(outcome.rejection);
      res.status(http.status);
      for (const [name, value] of Object.entries(http.headers)) res.setHeader(name, value);
      return http.body;
    }

    return outcome.result;
  }
}

/**
 * Traducción HTTP de un rechazo del libro de gasto (tarea 5.5).
 *
 * Se devuelve el `status`, el cuerpo y los encabezados en vez de lanzar una
 * `HttpException` porque `Retry-After` viaja por encabezado y la
 * `HttpException` de Nest 12 ya no acepta `headers` en sus opciones. La
 * consumen las rutas que ABREN un turno —`POST .../ai/health-check` (tarea 7.8)
 * y el chat de la rebanada 2—, no las rutas de configuración y gasto, que no
 * reservan nada.
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

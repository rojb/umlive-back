import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { AI_TURN_ERROR, type AiTurnResult, type AiUndoResult } from '@umlive/contracts';
import type { Response } from 'express';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { AiTurnService, type AiTurnOutcome, type AiUndoOutcome } from './ai-turn.service';
import { spendRejectionToHttp } from './ai.controller';
import { AiTurnRequestDto } from './dto/ai-turn-request.dto';

/**
 * Las dos rutas del turno (M6, rebanada 2/4 — `ai-text-instructions`, D9, tarea
 * 5.9):
 *
 * | Ruta | Acción |
 * |---|---|
 * | `POST .../diagrams/:diagramId/ai/turns` | `ai.use` |
 * | `POST .../diagrams/:diagramId/ai/turns/:turnId/undo` | `ai.use` |
 *
 * El prefijo es DISTINTO del de `ai.controller.ts` (`projects/:projectId/ai`),
 * así que ese archivo no se toca: `ProjectAccessGuard` lee `:diagramId`, lo
 * valida contra el proyecto y resuelve la membresía en las dos rutas igual que
 * en el resto de la API.
 *
 * ── Por qué el `@Res({ passthrough: true })` ─────────────────────────────────
 *
 * Es el mismo patrón que `POST .../ai/health-check`: `Retry-After` viaja por
 * encabezado y la `HttpException` de Nest 12 ya no acepta `headers` en sus
 * opciones. Y hace falta `res` además para la CANCELACIÓN: `res.on('close')` es
 * el único lugar donde se ve que el cliente cortó.
 *
 * ── Qué responde cada camino (D10) ───────────────────────────────────────────
 *
 * Los rechazos ANTES del proveedor son errores HTTP y no escriben fila en
 * `ai_turns`: `423 diagram_frozen`, `409 ai_turn_in_progress`, `409
 * ai_tool_calling_unavailable`, y el `429`/`409` del libro de gasto. Todo turno
 * que llegó al proveedor responde `200` con su `AiTurnResult`, incluido el
 * `REJECTED`: ese ya pagó su costo y su fila existe.
 *
 * `apps/api` es CommonJS: imports relativos sin `.js`.
 */
@Controller('projects/:projectId/diagrams/:diagramId/ai')
export class AiTurnsController {
  constructor(private readonly turns: AiTurnService) {}

  @Post('turns')
  @RequiresProjectAction('ai.use')
  @HttpCode(HttpStatus.OK)
  async createTurn(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: AiTurnRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiTurnResult | Record<string, string>> {
    // La cancelación (D9): el cliente corta la conexión y el turno queda
    // `CANCELLED`. `!res.writableEnded` distingue "el cliente se fue" de "la
    // respuesta terminó bien", que también dispara `close` en algunos runtimes.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const outcome = await this.turns.runTurn(projectId, diagramId, user, dto, abort.signal);
    return turnHttp(outcome, res);
  }

  @Post('turns/:turnId/undo')
  @RequiresProjectAction('ai.use')
  @HttpCode(HttpStatus.OK)
  async undoTurn(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiUndoResult | Record<string, unknown>> {
    const outcome = await this.turns.undo(diagramId, user, turnId);

    if (outcome.kind === 'result') return outcome.result;
    if (outcome.kind === 'frozen') {
      res.status(HttpStatus.LOCKED);
      return { code: AI_TURN_ERROR.DIAGRAM_FROZEN };
    }
    // El deshacer tomó la unión de locks de sus inversas y no la pudo tomar
    // entera: nada se aplicó. El cuerpo es el `OperationRejected` del pipeline,
    // el MISMO que ya conoce el cliente en el socket, así que el motivo, el
    // titular y el elemento viajan tipados.
    res.status(HttpStatus.CONFLICT);
    return { ...outcome.rejection };
  }
}

/**
 * Traducción HTTP del resultado de un turno. Los tres rechazos de guarda y los
 * dos del libro de gasto comparten la forma `{ code }` que ya usa el resto de la
 * superficie de IA.
 */
function turnHttp(outcome: AiTurnOutcome, res: Response): AiTurnResult | Record<string, string> {
  if (outcome.kind === 'result') return outcome.result;

  if (outcome.kind === 'frozen') {
    res.status(HttpStatus.LOCKED);
    return { code: AI_TURN_ERROR.DIAGRAM_FROZEN };
  }
  if (outcome.kind === 'in_progress') {
    res.status(HttpStatus.CONFLICT);
    return { code: AI_TURN_ERROR.TURN_IN_PROGRESS };
  }
  if (outcome.kind === 'tool_calling_unavailable') {
    res.status(HttpStatus.CONFLICT);
    return { code: AI_TURN_ERROR.TOOL_CALLING_UNAVAILABLE };
  }

  const http = spendRejectionToHttp(outcome.rejection);
  res.status(http.status);
  for (const [name, value] of Object.entries(http.headers)) res.setHeader(name, value);
  return http.body;
}

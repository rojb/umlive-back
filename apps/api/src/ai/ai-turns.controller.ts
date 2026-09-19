import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  AI_TURN_ERROR,
  type AiImageConfirmResult,
  type AiImagePreview,
  type AiTurnResult,
  type AiUndoResult,
} from '@umlive/contracts';
import type { Response } from 'express';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import {
  AiTurnService,
  type AiImageConfirmOutcome,
  type AiImagePlanOutcome,
  type AiTurnOutcome,
  type AiUndoOutcome,
} from './ai-turn.service';
import { spendRejectionToHttp } from './ai.controller';
import { AiConfirmTurnDto } from './dto/ai-confirm-turn.dto';
import { AiImageTurnDto } from './dto/ai-image-turn.dto';
import { AiTurnRequestDto } from './dto/ai-turn-request.dto';
import { ImageUploadFilter, IMAGE_MULTER_OPTIONS, type UploadedImage } from './image-upload.filter';

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

  /**
   * `POST .../ai/turns/image` (D1, D4, tarea 4.6): planifica un turno de foto y
   * devuelve la vista previa. **No escribe ninguna operación.**
   *
   * El `FileInterceptor` va acá y no en `AiModule`: multer con los límites de
   * `IMAGE_MULTER_OPTIONS`, **sin `storage`** (memoria, nunca disco) y con el
   * `ImageUploadFilter` que traduce el `413`. El orden de Nest es el que pide D1:
   * primero el guard de `ai.use` —un no miembro recibe `403` sin que multer lea
   * un byte—, después el interceptor.
   */
  @Post('turns/image')
  @RequiresProjectAction('ai.use')
  @UseInterceptors(FileInterceptor('image', IMAGE_MULTER_OPTIONS))
  @UseFilters(ImageUploadFilter)
  @HttpCode(HttpStatus.OK)
  async createImageTurn(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
    @UploadedFile() image: UploadedImage | undefined,
    @Body() dto: AiImageTurnDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiImagePreview | AiTurnResult | Record<string, unknown>> {
    const outcome = await this.turns.planImageTurn(projectId, diagramId, user, dto, image);
    return imagePlanHttp(outcome, res);
  }

  /**
   * `POST .../ai/turns/:turnId/confirm` (D8, tarea 4.6): recalcula el cierre,
   * revalida el modo dentro del `FOR UPDATE` y aplica en un lote. Sin cuerpo
   * JSON propio más allá de `excluded`.
   */
  @Post('turns/:turnId/confirm')
  @RequiresProjectAction('ai.use')
  @HttpCode(HttpStatus.OK)
  async confirmImageTurn(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: AiConfirmTurnDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiImageConfirmResult | Record<string, unknown>> {
    const outcome = await this.turns.confirmImageTurn(diagramId, user, turnId, dto);
    return confirmHttp(outcome, res);
  }

  /** `POST .../ai/turns/:turnId/discard` (D8, tarea 4.6): cancela sin aplicar nada. */
  @Post('turns/:turnId/discard')
  @RequiresProjectAction('ai.use')
  @HttpCode(HttpStatus.NO_CONTENT)
  async discardImageTurn(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('turnId', ParseUUIDPipe) turnId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void | Record<string, string>> {
    const outcome = await this.turns.discardImageTurn(diagramId, user, turnId);
    if (outcome.kind === 'not_owner') {
      res.status(HttpStatus.FORBIDDEN);
      return { code: AI_TURN_ERROR.AI_TURN_NOT_OWNER };
    }
    return undefined;
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

/**
 * Traducción HTTP de la planificación de imagen (D4). Todas las guardas viajan
 * como error HTTP `{ code }`: ninguna escribió una fila en `ai_turns` ni llamó
 * al proveedor. Lo único que responde `200` con `AiTurnResult` es un fallo del
 * proveedor DESPUÉS de reservar, que ya tiene su costo y su fila.
 */
function imagePlanHttp(
  outcome: AiImagePlanOutcome,
  res: Response,
): AiImagePreview | AiTurnResult | Record<string, unknown> {
  switch (outcome.kind) {
    case 'preview':
      return outcome.preview;
    case 'failed':
      return outcome.result;
    case 'image_rejected':
      res.status(outcome.status);
      return outcome.body;
    case 'frozen':
      res.status(HttpStatus.LOCKED);
      return { code: AI_TURN_ERROR.DIAGRAM_FROZEN };
    case 'in_progress':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_TURN_ERROR.TURN_IN_PROGRESS };
    case 'vision_unavailable':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_TURN_ERROR.AI_VISION_UNAVAILABLE };
    case 'create_requires_empty':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_TURN_ERROR.AI_IMAGE_CREATE_REQUIRES_EMPTY_DIAGRAM };
    case 'spend_rejected': {
      const http = spendRejectionToHttp(outcome.rejection);
      res.status(http.status);
      for (const [name, value] of Object.entries(http.headers)) res.setHeader(name, value);
      return http.body;
    }
  }
}

/**
 * Traducción HTTP de la confirmación (D8). Los tres rechazos que importan:
 *
 * - `stale` → `409 ai_preview_stale { reason }`: el diagrama cambió en el medio.
 * - `expired` → `410 ai_preview_expired`: la vista previa se perdió (reinicio o
 *   TTL) y el costo queda en su fila.
 * - `item_unknown` → `400 ai_preview_item_unknown`: la lista traía un índice que
 *   el plan no tiene.
 *
 * Un `423` o un lock ajeno SE CONSERVAN la vista previa (el servicio ya hizo el
 * `restore`) para reintentar dentro del TTL.
 */
function confirmHttp(
  outcome: AiImageConfirmOutcome,
  res: Response,
): AiImageConfirmResult | Record<string, unknown> {
  switch (outcome.kind) {
    case 'result':
      return outcome.result;
    case 'frozen':
      res.status(HttpStatus.LOCKED);
      return { code: AI_TURN_ERROR.DIAGRAM_FROZEN };
    case 'in_progress':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_TURN_ERROR.TURN_IN_PROGRESS };
    case 'locked':
      res.status(HttpStatus.CONFLICT);
      return { ...outcome.rejection };
    case 'stale':
      res.status(HttpStatus.CONFLICT);
      return { code: AI_TURN_ERROR.AI_PREVIEW_STALE, reason: outcome.reason };
    case 'item_unknown':
      res.status(HttpStatus.BAD_REQUEST);
      return { code: AI_TURN_ERROR.AI_PREVIEW_ITEM_UNKNOWN };
    case 'expired':
      res.status(HttpStatus.GONE);
      return { code: AI_TURN_ERROR.AI_PREVIEW_EXPIRED };
    case 'not_owner':
      res.status(HttpStatus.FORBIDDEN);
      return { code: AI_TURN_ERROR.AI_TURN_NOT_OWNER };
  }
}

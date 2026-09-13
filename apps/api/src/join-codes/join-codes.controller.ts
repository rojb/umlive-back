import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { JoinCodeView } from '@umlive/contracts';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { GenerateJoinCodeDto } from './dto/generate-join-code.dto';
import { JoinCodesService } from './join-codes.service';

/**
 * Bajo `/projects/:projectId/...` → pasa por `ProjectAccessGuard`
 * (design.md §1, §3). Generar cuelga de `:diagramId` a propósito: el guard
 * ya resuelve el diagrama con su `findUnique` y rechaza `404
 * diagram_not_found` gratis, sin código propio (design.md §3).
 */
@Controller('projects/:projectId')
export class JoinCodesController {
  constructor(private readonly joinCodes: JoinCodesService) {}

  @Post('diagrams/:diagramId/join-codes')
  @RequiresProjectAction('joinCode.generate')
  @HttpCode(HttpStatus.CREATED)
  generate(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: GenerateJoinCodeDto,
  ): Promise<JoinCodeView> {
    return this.joinCodes.generate(diagramId, user.id, dto);
  }

  @Get('join-codes')
  @RequiresProjectAction('joinCode.list')
  list(@Param('projectId', ParseUUIDPipe) projectId: string): Promise<JoinCodeView[]> {
    return this.joinCodes.list(projectId);
  }

  /** Revocar cuelga de `:projectId`, no de `:diagramId` (design.md §3): B1 opera sobre la lista completa del proyecto. */
  @Delete('join-codes/:codeId')
  @RequiresProjectAction('joinCode.revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('codeId', ParseUUIDPipe) codeId: string,
  ): Promise<void> {
    return this.joinCodes.revoke(projectId, codeId);
  }
}

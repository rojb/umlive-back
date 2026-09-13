import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { RedeemJoinCodeResponse } from '@umlive/contracts';
import type { Request } from 'express';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator';
import { RedeemJoinCodeDto } from './dto/redeem-join-code.dto';
import { RedemptionThrottleGuard } from './redemption-throttle.guard';
import { RedemptionService } from './redemption.service';

/**
 * `POST /api/join-codes/redeem` — cuerpo `{ code }`, sin `:projectId` ni
 * `:diagramId` en ninguna forma (design.md §2.1). `ProjectAccessGuard` ve
 * una ruta sin esos params y devuelve `true` sin consultar nada
 * (`project-access.guard.ts:72`) — NO hace falta tocarlo ni agregarle una
 * excepción.
 *
 * Toda la autorización de esta ruta es «autenticado (`JwtAuthGuard`, global,
 * SIN `@Public()`) + código activo». Si alguien en M2 le agrega un
 * `:projectId` a esta ruta, `ProjectAccessGuard` se despierta y la rompe
 * ruidosamente — ese es el modo de falla correcto, no un olvido.
 */
@Controller('join-codes')
export class RedemptionController {
  constructor(private readonly redemption: RedemptionService) {}

  @UseGuards(RedemptionThrottleGuard)
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  redeem(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: RedeemJoinCodeDto,
    @Req() req: Request,
  ): Promise<RedeemJoinCodeResponse> {
    return this.redemption.redeem(user.id, req.ip ?? 'unknown', dto.code);
  }
}

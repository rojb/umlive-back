import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import type { AuthUser, MeResponse } from '@umlive/contracts';
import { CurrentUser, type CurrentUserPayload } from '../auth/current-user.decorator.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { UsersService } from './users.service.js';

/** Todo protegido por el `JwtAuthGuard` global (sin `@Public()`) — design.md §5. */
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: CurrentUserPayload): Promise<MeResponse> {
    return this.users.me(user.id);
  }

  @Patch('me')
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: UpdateMeDto,
  ): Promise<AuthUser> {
    return this.users.update(user.id, dto);
  }

  /** SC-A07 / SC-A08. `sid` es la sesión actual — la única que sobrevive. */
  @Post('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.users.changePassword(user.id, user.sid, dto);
  }
}

import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import type { ProjectMemberView } from '@umlive/contracts';
import { AddMemberDto } from './dto/add-member.dto';
import { RequiresProjectAction } from './guards/requires-project-action.decorator';
import { MembersService } from './members.service';

@Controller('projects/:projectId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Post()
  @RequiresProjectAction('member.add')
  @HttpCode(HttpStatus.CREATED)
  add(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AddMemberDto,
  ): Promise<ProjectMemberView> {
    return this.members.add(projectId, dto);
  }

  @Delete(':userId')
  @RequiresProjectAction('member.remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.members.remove(projectId, userId);
  }
}

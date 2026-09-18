import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import type { ValidationReport } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { ValidationService } from './validation.service';

/**
 * `GET .../validation` (design.md D6, §3; tasks.md 2.4). `diagram.view`, no
 * `diagram.edit` — es una lectura, igual que `DiagramContentController`.
 */
@Controller('projects/:projectId/diagrams')
export class ValidationController {
  constructor(private readonly validation: ValidationService) {}

  @Get(':diagramId/validation')
  @RequiresProjectAction('diagram.view')
  get(@Param('diagramId', ParseUUIDPipe) diagramId: string): Promise<ValidationReport> {
    return this.validation.validate(diagramId);
  }
}

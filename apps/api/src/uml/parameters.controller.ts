import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import type { UmlEnumLiteralView, UmlParameterView } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { AddEnumLiteralDto } from './dto/add-enum-literal.dto';
import { AddParameterDto } from './dto/add-parameter.dto';
import { ReorderEnumLiteralsDto } from './dto/reorder-enum-literals.dto';
import { ReorderParametersDto } from './dto/reorder-parameters.dto';
import { UpdateParameterDto } from './dto/update-parameter.dto';
import { ParametersService } from './parameters.service';

/**
 * Comparte prefijo con `ElementsController`/`FeaturesController`/
 * `DiagramContentController` — sin colisión de método+ruta (design.md §2,
 * §8). Parámetros cuelgan de `/features/:operationId/parameters...`;
 * literales, de `/elements/:enumId/literals...`.
 */
@Controller('projects/:projectId/diagrams/:diagramId')
export class ParametersController {
  constructor(private readonly parameters: ParametersService) {}

  @Post('features/:operationId/parameters')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.CREATED)
  addParameter(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('operationId', ParseUUIDPipe) operationId: string,
    @Body() dto: AddParameterDto,
  ): Promise<UmlParameterView> {
    return this.parameters.addParameter(diagramId, operationId, dto);
  }

  @Patch('parameters/:parameterId')
  @RequiresProjectAction('diagram.edit')
  updateParameter(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('parameterId', ParseUUIDPipe) parameterId: string,
    @Body() dto: UpdateParameterDto,
  ): Promise<UmlParameterView> {
    return this.parameters.updateParameter(diagramId, parameterId, dto);
  }

  @Delete('parameters/:parameterId')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeParameter(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('parameterId', ParseUUIDPipe) parameterId: string,
  ): Promise<void> {
    return this.parameters.removeParameter(diagramId, parameterId);
  }

  @Put('features/:operationId/parameters/order')
  @RequiresProjectAction('diagram.edit')
  reorderParameters(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('operationId', ParseUUIDPipe) operationId: string,
    @Body() dto: ReorderParametersDto,
  ): Promise<UmlParameterView[]> {
    return this.parameters.reorderParameters(diagramId, operationId, dto);
  }

  @Post('elements/:enumId/literals')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.CREATED)
  addEnumLiteral(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('enumId', ParseUUIDPipe) enumId: string,
    @Body() dto: AddEnumLiteralDto,
  ): Promise<UmlEnumLiteralView> {
    return this.parameters.addEnumLiteral(diagramId, enumId, dto);
  }

  @Delete('literals/:literalId')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeEnumLiteral(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('literalId', ParseUUIDPipe) literalId: string,
  ): Promise<void> {
    return this.parameters.removeEnumLiteral(diagramId, literalId);
  }

  @Put('elements/:enumId/literals/order')
  @RequiresProjectAction('diagram.edit')
  reorderEnumLiterals(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('enumId', ParseUUIDPipe) enumId: string,
    @Body() dto: ReorderEnumLiteralsDto,
  ): Promise<UmlEnumLiteralView[]> {
    return this.parameters.reorderEnumLiterals(diagramId, enumId, dto);
  }
}

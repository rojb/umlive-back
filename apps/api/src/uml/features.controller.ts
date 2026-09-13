import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import type { UmlFeatureView } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { AddFeatureDto } from './dto/add-feature.dto';
import { ReorderFeaturesDto } from './dto/reorder-features.dto';
import { UpdateFeatureDto } from './dto/update-feature.dto';
import { FeaturesService } from './features.service';

/**
 * Comparte prefijo con `ElementsController`, `ParametersController` y
 * `DiagramContentController` — NestJS lo admite mientras método+ruta no
 * colisionen (design.md §8, §2). `addFeature`/`reorderFeatures` cuelgan de
 * `/elements/:elementId/...`; `updateFeature`/`removeFeature` son planas por
 * `:featureId` (el objetivo es la entidad concreta, no la colección).
 */
@Controller('projects/:projectId/diagrams/:diagramId')
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @Post('elements/:elementId/features')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.CREATED)
  add(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: AddFeatureDto,
  ): Promise<UmlFeatureView> {
    return this.features.addFeature(diagramId, elementId, dto);
  }

  @Patch('features/:featureId')
  @RequiresProjectAction('diagram.edit')
  update(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
    @Body() dto: UpdateFeatureDto,
  ): Promise<UmlFeatureView> {
    return this.features.updateFeature(diagramId, featureId, dto);
  }

  @Delete('features/:featureId')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('featureId', ParseUUIDPipe) featureId: string,
  ): Promise<void> {
    return this.features.removeFeature(diagramId, featureId);
  }

  @Put('elements/:elementId/features/order')
  @RequiresProjectAction('diagram.edit')
  reorder(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('elementId', ParseUUIDPipe) elementId: string,
    @Body() dto: ReorderFeaturesDto,
  ): Promise<UmlFeatureView[]> {
    return this.features.reorderFeatures(diagramId, elementId, dto);
  }
}

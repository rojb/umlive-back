import { Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { RelationshipLayoutView, UmlRelationshipEndView, UmlRelationshipView } from '@umlive/contracts';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { RenameRelationshipDto } from './dto/rename-relationship.dto';
import { RerouteRelationshipEndDto } from './dto/reroute-relationship-end.dto';
import { SetAssociationClassDto } from './dto/set-association-class.dto';
import { SetEndAggregationDto } from './dto/set-end-aggregation.dto';
import { SetEndMultiplicityDto } from './dto/set-end-multiplicity.dto';
import { SetEndNavigabilityDto } from './dto/set-end-navigability.dto';
import { SetEndRoleNameDto } from './dto/set-end-role-name.dto';
import { SetRelationshipAnchorsDto } from './dto/set-relationship-anchors.dto';
import { SetRelationshipStereotypeDto } from './dto/set-relationship-stereotype.dto';
import { SetRelationshipWaypointsDto } from './dto/set-relationship-waypoints.dto';
import { RelationshipsService, type RelationshipMutationResult } from './relationships.service';

/**
 * Las once mutaciones (design.md §3 "Superficie HTTP"; tasks.md 2.8). Mismo
 * criterio que `ElementsController`: `:projectId`/`:diagramId` los valida
 * `ProjectAccessGuard` (global); `:relationshipId` lo valida
 * `assertRelationshipInDiagram` dentro del servicio, en la misma transacción
 * que la escritura. El cuerpo NUNCA lleva el verbo ni el tipo del objetivo
 * — eso vive en el método HTTP y en la ruta.
 *
 * No hace falta `assertEndInDiagram` (design.md §3): el extremo se
 * direcciona por `:endIndex` dentro de la ruta de su propia relación, así
 * que `assertRelationshipInDiagram` + `endIndex` ya lo aíslan por completo
 * — `ParseIntPipe` valida forma; si el valor no es `0`/`1`, la fila
 * simplemente no existe y el servicio responde `404`.
 */
@Controller('projects/:projectId/diagrams/:diagramId/relationships')
export class RelationshipsController {
  constructor(private readonly relationships: RelationshipsService) {}

  @Post()
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.CREATED)
  create(@Param('diagramId', ParseUUIDPipe) diagramId: string, @Body() dto: CreateRelationshipDto): Promise<RelationshipMutationResult> {
    return this.relationships.createRelationship(diagramId, dto);
  }

  @Delete(':relationshipId')
  @RequiresProjectAction('diagram.edit')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
  ): Promise<void> {
    return this.relationships.deleteRelationship(diagramId, relationshipId);
  }

  @Patch(':relationshipId/name')
  @RequiresProjectAction('diagram.edit')
  rename(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: RenameRelationshipDto,
  ): Promise<UmlRelationshipView> {
    return this.relationships.renameRelationship(diagramId, relationshipId, dto);
  }

  /** `uml-validation` fase 1 (design.md D10, Hallazgo "la propuesta se olvidó de una ruta"; tasks.md 1.8). */
  @Patch(':relationshipId/stereotype')
  @RequiresProjectAction('diagram.edit')
  setStereotype(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: SetRelationshipStereotypeDto,
  ): Promise<UmlRelationshipView> {
    return this.relationships.setRelationshipStereotype(diagramId, relationshipId, dto);
  }

  @Patch(':relationshipId/source')
  @RequiresProjectAction('diagram.edit')
  rerouteSource(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: RerouteRelationshipEndDto,
  ): Promise<RelationshipMutationResult> {
    return this.relationships.rerouteRelationshipSource(diagramId, relationshipId, dto);
  }

  @Patch(':relationshipId/target')
  @RequiresProjectAction('diagram.edit')
  rerouteTarget(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: RerouteRelationshipEndDto,
  ): Promise<RelationshipMutationResult> {
    return this.relationships.rerouteRelationshipTarget(diagramId, relationshipId, dto);
  }

  @Patch(':relationshipId/ends/:endIndex/role-name')
  @RequiresProjectAction('diagram.edit')
  setEndRoleName(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Param('endIndex', ParseIntPipe) endIndex: number,
    @Body() dto: SetEndRoleNameDto,
  ): Promise<UmlRelationshipEndView> {
    return this.relationships.setEndRoleName(diagramId, relationshipId, endIndex, dto);
  }

  @Patch(':relationshipId/ends/:endIndex/multiplicity')
  @RequiresProjectAction('diagram.edit')
  setEndMultiplicity(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Param('endIndex', ParseIntPipe) endIndex: number,
    @Body() dto: SetEndMultiplicityDto,
  ): Promise<UmlRelationshipEndView> {
    return this.relationships.setEndMultiplicity(diagramId, relationshipId, endIndex, dto);
  }

  @Patch(':relationshipId/ends/:endIndex/navigability')
  @RequiresProjectAction('diagram.edit')
  setEndNavigability(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Param('endIndex', ParseIntPipe) endIndex: number,
    @Body() dto: SetEndNavigabilityDto,
  ): Promise<UmlRelationshipEndView> {
    return this.relationships.setEndNavigability(diagramId, relationshipId, endIndex, dto);
  }

  @Patch(':relationshipId/ends/:endIndex/aggregation')
  @RequiresProjectAction('diagram.edit')
  setEndAggregation(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Param('endIndex', ParseIntPipe) endIndex: number,
    @Body() dto: SetEndAggregationDto,
  ): Promise<UmlRelationshipEndView> {
    return this.relationships.setEndAggregation(diagramId, relationshipId, endIndex, dto);
  }

  @Patch(':relationshipId/waypoints')
  @RequiresProjectAction('diagram.edit')
  setWaypoints(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: SetRelationshipWaypointsDto,
  ): Promise<RelationshipLayoutView> {
    return this.relationships.setRelationshipWaypoints(diagramId, relationshipId, dto);
  }

  @Patch(':relationshipId/anchors')
  @RequiresProjectAction('diagram.edit')
  setAnchors(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: SetRelationshipAnchorsDto,
  ): Promise<RelationshipLayoutView> {
    return this.relationships.setRelationshipAnchors(diagramId, relationshipId, dto);
  }

  /** FR-B10 (`association-class`, D5; design.md §4). Ligar y desligar comparten un solo verbo. */
  @Patch(':relationshipId/association-class')
  @RequiresProjectAction('diagram.edit')
  setAssociationClass(
    @Param('diagramId', ParseUUIDPipe) diagramId: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
    @Body() dto: SetAssociationClassDto,
  ): Promise<UmlRelationshipView> {
    return this.relationships.setAssociationClass(diagramId, relationshipId, dto);
  }
}

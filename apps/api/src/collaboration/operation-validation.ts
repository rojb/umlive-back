import { plainToInstance } from 'class-transformer';
import { isUUID, validate, type ValidationError } from 'class-validator';
import type { OperationType, RelationshipCreateEnd } from '@umlive/contracts';
import { AddEnumLiteralDto } from '../uml/dto/add-enum-literal.dto';
import { AddFeatureDto } from '../uml/dto/add-feature.dto';
import { AddParameterDto } from '../uml/dto/add-parameter.dto';
import { CreateElementDto } from '../uml/dto/create-element.dto';
import { CreateRelationshipDto } from '../uml/dto/create-relationship.dto';
import { MoveElementDto } from '../uml/dto/move-element.dto';
import { RenameElementDto } from '../uml/dto/rename-element.dto';
import { RenameRelationshipDto } from '../uml/dto/rename-relationship.dto';
import { ReorderEnumLiteralsDto } from '../uml/dto/reorder-enum-literals.dto';
import { ReorderFeaturesDto } from '../uml/dto/reorder-features.dto';
import { ReorderParametersDto } from '../uml/dto/reorder-parameters.dto';
import { RerouteRelationshipEndDto } from '../uml/dto/reroute-relationship-end.dto';
import { ResizeElementDto } from '../uml/dto/resize-element.dto';
import { SetAssociationClassDto } from '../uml/dto/set-association-class.dto';
import { SetElementAbstractDto } from '../uml/dto/set-element-abstract.dto';
import { SetElementBodyDto } from '../uml/dto/set-element-body.dto';
import { SetElementParentDto } from '../uml/dto/set-element-parent.dto';
import { SetElementStereotypeDto } from '../uml/dto/set-element-stereotype.dto';
import { SetEndAggregationDto } from '../uml/dto/set-end-aggregation.dto';
import { SetEndMultiplicityDto } from '../uml/dto/set-end-multiplicity.dto';
import { SetEndNavigabilityDto } from '../uml/dto/set-end-navigability.dto';
import { SetEndRoleNameDto } from '../uml/dto/set-end-role-name.dto';
import { SetRelationshipAnchorsDto } from '../uml/dto/set-relationship-anchors.dto';
import { SetRelationshipStereotypeDto } from '../uml/dto/set-relationship-stereotype.dto';
import { SetRelationshipWaypointsDto } from '../uml/dto/set-relationship-waypoints.dto';
import { UpdateFeatureDto } from '../uml/dto/update-feature.dto';
import { UpdateParameterDto } from '../uml/dto/update-parameter.dto';

/**
 * Validación de borde del camino del socket (design.md D11, verify-report
 * 2026-09-18 W-1/W-2/C-1). El camino HTTP valida con `class-validator` ANTES
 * de tocar el servicio (`ValidationPipe` global, `main.ts:37`:
 * `whitelist: true, forbidNonWhitelisted: true, transform: true`); el camino
 * del socket no tenía nada de eso — un payload con forma arbitraria llegaba
 * directo al despachador. Este módulo corre la MISMA validación, con los
 * MISMOS DTOs, en el mismo lugar del pipeline: antes de `$transaction`
 * (`operations.service.ts#submit`), nunca adentro.
 *
 * Lo que devuelve `validateOperationPayload` en el caso `ok: true` es el
 * payload CANÓNICO — reconstruido a partir de la instancia validada, no el
 * crudo que mandó el cliente. Es ese valor, y no `req.payload`, el que sigue
 * viaje hacia el despachador: lo que se loguea y se difunde es lo que pasó la
 * validación, nunca lo que llegó sin pasar por ella (cierra W-1: un `junk`,
 * o un `isAbstract` en un `element.rename`, quedan `forbidNonWhitelisted` →
 * `MALFORMED`, jamás loggeados ni aplicados).
 */
export type OperationValidationOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

type FieldError = { error: string };

function isFieldError(x: unknown): x is FieldError {
  return typeof x === 'object' && x !== null && 'error' in x;
}

function asRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
}

/** Separa `keys` del resto — mismo patrón que ya usan `feature.update`/`parameter.update` en el despachador (`const { id, ...rest } = payload`), pero reusable para las 32 formas. */
function splitFields(record: Record<string, unknown>, keys: string[]): { picked: Record<string, unknown>; rest: Record<string, unknown> } {
  const picked: Record<string, unknown> = {};
  const rest: Record<string, unknown> = { ...record };
  for (const key of keys) {
    if (key in rest) {
      picked[key] = rest[key];
      delete rest[key];
    }
  }
  return { picked, rest };
}

function requireUuid4(value: unknown, field: string): string | FieldError {
  if (typeof value !== 'string' || !isUUID(value, '4')) return { error: `\`${field}\` no es un UUID válido.` };
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string | FieldError {
  if (typeof value !== 'string' || value.length === 0) return { error: `\`${field}\` es obligatorio.` };
  return value;
}

function requireEndIndex(value: unknown): 0 | 1 | FieldError {
  return value === 0 || value === 1 ? value : { error: '`endIndex` debe ser 0 o 1.' };
}

function noExtraFields(rest: Record<string, unknown>): FieldError | undefined {
  const extra = Object.keys(rest);
  return extra.length > 0 ? { error: `Campos no reconocidos: ${extra.join(', ')}.` } : undefined;
}

/**
 * Corre el mismo par `plainToInstance` + `validate` que `ValidationPipe`
 * global (`main.ts:37`), con las MISMAS opciones (`whitelist: true,
 * forbidNonWhitelisted: true`). Sin `transform: true` explícito porque acá no
 * hace falta: el payload ya llega como JSON nativo (Socket.IO), igual que un
 * body HTTP con `Content-Type: application/json` — `transform: true` en Nest
 * solo importa para params y query (siempre strings) y para clases
 * anidadas con `@Type()`, que los DTOs de este árbol ya declaran donde hace
 * falta (`CreateElementDto`, `CreateRelationshipDto`, `SetRelationshipWaypointsDto`).
 */
async function checkDto<T extends object>(cls: new () => T, data: Record<string, unknown>): Promise<T | FieldError> {
  const instance = plainToInstance(cls, data);
  const errors = await validate(instance as object, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) return { error: summarizeErrors(errors) };
  return instance;
}

function summarizeErrors(errors: ValidationError[]): string {
  const messages = errors.map((e) => Object.values(e.constraints ?? {}).join('; ') || `\`${e.property}\` es inválido.`);
  return messages.join(' | ') || 'El payload no tiene una forma válida.';
}

type Validator = (payload: unknown) => Promise<OperationValidationOutcome>;

function fail(message: string): OperationValidationOutcome {
  return { ok: false, message };
}

function ok(value: Record<string, unknown>): OperationValidationOutcome {
  return { ok: true, value };
}

/** Colecta los primeros errores de forma (id-like, `endIndex`, arrays de uuid) antes de gastar un `checkDto`. */
function collectErrors(...values: unknown[]): FieldError | undefined {
  return values.find(isFieldError) as FieldError | undefined;
}

const VALIDATORS: { [T in OperationType]: Validator } = {
  'element.create': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const id = requireNonEmptyString(record.id, 'id');
    const layout = asRecord(record.layout);
    const err = collectErrors(id);
    if (err) return fail(err.error);
    const { rest } = splitFields(record, ['id', 'layout']);
    const flat = { ...rest, x: layout?.x, y: layout?.y, width: layout?.width, height: layout?.height };
    const dto = await checkDto(CreateElementDto, flat);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({
      id,
      kind: dto.kind,
      name: dto.name,
      parentId: dto.parentId,
      isAbstract: dto.isAbstract,
      stereotype: dto.stereotype,
      body: dto.body,
      layout: { x: dto.x, y: dto.y, width: dto.width, height: dto.height },
    });
  },

  'element.rename': async (payload) => withIdAnd(payload, RenameElementDto, (id, dto) => ({ id, name: dto.name })),
  'element.setAbstract': async (payload) => withIdAnd(payload, SetElementAbstractDto, (id, dto) => ({ id, isAbstract: dto.isAbstract })),
  'element.setParent': async (payload) => withIdAnd(payload, SetElementParentDto, (id, dto) => ({ id, parentId: dto.parentId })),
  'element.setStereotype': async (payload) => withIdAnd(payload, SetElementStereotypeDto, (id, dto) => ({ id, stereotype: dto.stereotype })),
  'element.setBody': async (payload) => withIdAnd(payload, SetElementBodyDto, (id, dto) => ({ id, body: dto.body })),
  'element.move': async (payload) => withIdAnd(payload, MoveElementDto, (id, dto) => ({ id, x: dto.x, y: dto.y })),
  'element.resize': async (payload) => withIdAnd(payload, ResizeElementDto, (id, dto) => ({ id, width: dto.width, height: dto.height })),

  'element.delete': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id', 'expectedIncidentRelationshipIds']);
    const id = requireUuid4(picked.id, 'id');
    const list = picked.expectedIncidentRelationshipIds;
    const idErr = collectErrors(id);
    if (idErr) return fail(idErr.error);
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string' && isUUID(v, '4'))) {
      return fail('`expectedIncidentRelationshipIds` debe ser un arreglo de UUID.');
    }
    const extra = noExtraFields(rest);
    if (extra) return fail(extra.error);
    return ok({ id, expectedIncidentRelationshipIds: list });
  },

  'feature.create': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id', 'ownerId', 'position']);
    const id = requireNonEmptyString(picked.id, 'id');
    const ownerId = requireUuid4(picked.ownerId, 'ownerId');
    const err = collectErrors(id, ownerId);
    if (err) return fail(err.error);
    const dto = await checkDto(AddFeatureDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ ...dto, id, ownerId, position: picked.position });
  },

  'feature.update': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    // `position` es un campo TIPADO en `FeatureUpdate` (`Partial<Omit<FeatureCreate,'id'|'ownerId'|'kind'>>`)
    // que `updateFeatureIn` no usa — verify-report W-1. Se acepta y se
    // descarta acá, igual que `baseVersion` (D10): no es un campo
    // desconocido, es uno tipado sin efecto.
    const { picked, rest } = splitFields(record, ['id', 'position']);
    const id = requireUuid4(picked.id, 'id');
    if (isFieldError(id)) return fail(id.error);
    const dto = await checkDto(UpdateFeatureDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ id, ...dto });
  },

  'feature.delete': async (payload) => idOnly(payload),
  'feature.reorder': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['ownerId', 'orderedIds']);
    const ownerId = requireUuid4(picked.ownerId, 'ownerId');
    if (isFieldError(ownerId)) return fail(ownerId.error);
    const dto = await checkDto(ReorderFeaturesDto, { orderedFeatureIds: picked.orderedIds });
    if (isFieldError(dto)) return fail(dto.error);
    const extra = noExtraFields(rest);
    if (extra) return fail(extra.error);
    return ok({ ownerId, orderedIds: dto.orderedFeatureIds });
  },

  'parameter.add': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id', 'operationId', 'position']);
    const id = requireNonEmptyString(picked.id, 'id');
    const operationId = requireUuid4(picked.operationId, 'operationId');
    const err = collectErrors(id, operationId);
    if (err) return fail(err.error);
    const dto = await checkDto(AddParameterDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ ...dto, id, operationId, position: picked.position });
  },

  'parameter.update': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id']);
    const id = requireUuid4(picked.id, 'id');
    if (isFieldError(id)) return fail(id.error);
    const dto = await checkDto(UpdateParameterDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ id, ...dto });
  },

  'parameter.remove': async (payload) => idOnly(payload),
  'parameter.reorder': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['operationId', 'orderedIds']);
    const operationId = requireUuid4(picked.operationId, 'operationId');
    if (isFieldError(operationId)) return fail(operationId.error);
    const dto = await checkDto(ReorderParametersDto, { orderedParameterIds: picked.orderedIds });
    if (isFieldError(dto)) return fail(dto.error);
    const extra = noExtraFields(rest);
    if (extra) return fail(extra.error);
    return ok({ operationId, orderedIds: dto.orderedParameterIds });
  },

  'literal.add': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id', 'enumerationId', 'position']);
    const id = requireNonEmptyString(picked.id, 'id');
    const enumerationId = requireUuid4(picked.enumerationId, 'enumerationId');
    const err = collectErrors(id, enumerationId);
    if (err) return fail(err.error);
    const dto = await checkDto(AddEnumLiteralDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ ...dto, id, enumerationId, position: picked.position });
  },

  'literal.remove': async (payload) => idOnly(payload),
  'literal.reorder': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['enumerationId', 'orderedIds']);
    const enumerationId = requireUuid4(picked.enumerationId, 'enumerationId');
    if (isFieldError(enumerationId)) return fail(enumerationId.error);
    const dto = await checkDto(ReorderEnumLiteralsDto, { orderedLiteralIds: picked.orderedIds });
    if (isFieldError(dto)) return fail(dto.error);
    const extra = noExtraFields(rest);
    if (extra) return fail(extra.error);
    return ok({ enumerationId, orderedIds: dto.orderedLiteralIds });
  },

  'relationship.create': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id']);
    const id = requireNonEmptyString(picked.id, 'id');
    if (isFieldError(id)) return fail(id.error);
    const dto = await checkDto(CreateRelationshipDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({
      id,
      kind: dto.kind,
      sourceElementId: dto.sourceElementId,
      targetElementId: dto.targetElementId,
      name: dto.name,
      ends: dto.ends as [RelationshipCreateEnd, RelationshipCreateEnd] | undefined,
    });
  },

  'relationship.rename': async (payload) => withIdAnd(payload, RenameRelationshipDto, (id, dto) => ({ id, name: dto.name })),
  'relationship.setStereotype': async (payload) => withIdAnd(payload, SetRelationshipStereotypeDto, (id, dto) => ({ id, stereotype: dto.stereotype })),
  'relationship.setAssociationClass': async (payload) => withIdAnd(payload, SetAssociationClassDto, (id, dto) => ({ id, elementId: dto.elementId })),

  'relationship.reroute': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['id', 'endIndex']);
    const id = requireUuid4(picked.id, 'id');
    const endIndex = requireEndIndex(picked.endIndex);
    const err = collectErrors(id, endIndex);
    if (err) return fail(err.error);
    const dto = await checkDto(RerouteRelationshipEndDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ id, endIndex, elementId: dto.elementId, anchor: dto.anchor });
  },

  'relationship.delete': async (payload) => idOnly(payload),

  'relationshipEnd.setRoleName': async (payload) => withRelEndAnd(payload, SetEndRoleNameDto, (relationshipId, endIndex, dto) => ({ relationshipId, endIndex, roleName: dto.roleName })),
  'relationshipEnd.setMultiplicity': async (payload) =>
    withRelEndAnd(payload, SetEndMultiplicityDto, (relationshipId, endIndex, dto) => ({ relationshipId, endIndex, lowerBound: dto.lowerBound, upperBound: dto.upperBound })),
  'relationshipEnd.setNavigability': async (payload) =>
    withRelEndAnd(payload, SetEndNavigabilityDto, (relationshipId, endIndex, dto) => ({ relationshipId, endIndex, isNavigable: dto.isNavigable })),
  'relationshipEnd.setAggregation': async (payload) =>
    withRelEndAnd(payload, SetEndAggregationDto, (relationshipId, endIndex, dto) => ({ relationshipId, endIndex, aggregation: dto.aggregation })),

  'layout.waypoints': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['relationshipId']);
    const relationshipId = requireUuid4(picked.relationshipId, 'relationshipId');
    if (isFieldError(relationshipId)) return fail(relationshipId.error);
    const dto = await checkDto(SetRelationshipWaypointsDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ relationshipId, waypoints: dto.waypoints });
  },

  'layout.anchors': async (payload) => {
    const record = asRecord(payload);
    if (!record) return fail('El payload no es un objeto.');
    const { picked, rest } = splitFields(record, ['relationshipId']);
    const relationshipId = requireUuid4(picked.relationshipId, 'relationshipId');
    if (isFieldError(relationshipId)) return fail(relationshipId.error);
    const dto = await checkDto(SetRelationshipAnchorsDto, rest);
    if (isFieldError(dto)) return fail(dto.error);
    return ok({ relationshipId, sourceAnchor: dto.sourceAnchor, targetAnchor: dto.targetAnchor });
  },
};

/** `id` (UUID de una entidad EXISTENTE) + un único DTO existente — el patrón que repiten 13 de las 32 entradas. */
async function withIdAnd<T extends object>(payload: unknown, cls: new () => T, build: (id: string, dto: T) => Record<string, unknown>): Promise<OperationValidationOutcome> {
  const record = asRecord(payload);
  if (!record) return fail('El payload no es un objeto.');
  const { picked, rest } = splitFields(record, ['id']);
  const id = requireUuid4(picked.id, 'id');
  if (isFieldError(id)) return fail(id.error);
  const dto = await checkDto(cls, rest);
  if (isFieldError(dto)) return fail(dto.error);
  return ok(build(id, dto));
}

/** `relationshipId` + `endIndex` + un único DTO existente — las cuatro mutaciones de `relationshipEnd.*`. */
async function withRelEndAnd<T extends object>(
  payload: unknown,
  cls: new () => T,
  build: (relationshipId: string, endIndex: 0 | 1, dto: T) => Record<string, unknown>,
): Promise<OperationValidationOutcome> {
  const record = asRecord(payload);
  if (!record) return fail('El payload no es un objeto.');
  const { picked, rest } = splitFields(record, ['relationshipId', 'endIndex']);
  const relationshipId = requireUuid4(picked.relationshipId, 'relationshipId');
  const endIndex = requireEndIndex(picked.endIndex);
  const err = collectErrors(relationshipId, endIndex);
  if (err) return fail(err.error);
  const dto = await checkDto(cls, rest);
  if (isFieldError(dto)) return fail(dto.error);
  return ok(build(relationshipId as string, endIndex as 0 | 1, dto));
}

/** `feature.delete` / `parameter.remove` / `literal.remove` / `relationship.delete` — los cuatro `IdOnly`. */
async function idOnly(payload: unknown): Promise<OperationValidationOutcome> {
  const record = asRecord(payload);
  if (!record) return fail('El payload no es un objeto.');
  const { picked, rest } = splitFields(record, ['id']);
  const id = requireUuid4(picked.id, 'id');
  if (isFieldError(id)) return fail(id.error);
  const extra = noExtraFields(rest);
  if (extra) return fail(extra.error);
  return ok({ id });
}

/**
 * Punto de entrada único (`operations.service.ts#submit`, ANTES de
 * `$transaction`). `type` ya pasó `OperationDispatcher.isKnownType` cuando
 * esto se llama — acá solo se valida la FORMA del payload para ese tipo.
 */
export async function validateOperationPayload<T extends OperationType>(type: T, payload: unknown): Promise<OperationValidationOutcome> {
  return VALIDATORS[type](payload);
}

import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, ValidateNested } from 'class-validator';
import type { SetRelationshipWaypointsRequest, Waypoint } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';

/**
 * `ck_waypoints_array` solo exige `jsonb_typeof(waypoints) = 'array'`
 * (design.md D7) — la forma `{x, y}` de cada elemento la impone este DTO,
 * no la base. `@IsInt32Range()` (verify-report 2026-09-18, RW-4): sin cota,
 * un waypoint fuera de rango pasaba y reventaba recién al persistir.
 */
export class WaypointDto implements Waypoint {
  @IsInt()
  @IsInt32Range()
  x!: number;

  @IsInt()
  @IsInt32Range()
  y!: number;
}

export class SetRelationshipWaypointsDto implements SetRelationshipWaypointsRequest {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints!: Waypoint[];
}

import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, ValidateNested } from 'class-validator';
import type { SetRelationshipWaypointsRequest, Waypoint } from '@umlive/contracts';

/**
 * `ck_waypoints_array` solo exige `jsonb_typeof(waypoints) = 'array'`
 * (design.md D7) — la forma `{x, y}` de cada elemento la impone este DTO,
 * no la base.
 */
export class WaypointDto implements Waypoint {
  @IsInt()
  x!: number;

  @IsInt()
  y!: number;
}

export class SetRelationshipWaypointsDto implements SetRelationshipWaypointsRequest {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WaypointDto)
  waypoints!: Waypoint[];
}

import { IsIn } from 'class-validator';
import type { AggregationKind, SetEndAggregationRequest } from '@umlive/contracts';

const AGGREGATION_KINDS: AggregationKind[] = ['NONE', 'SHARED', 'COMPOSITE'];

/**
 * Sin `upperBound` (D2, deliberado): este DTO no puede ver el `upperBound`
 * ya guardado, y `ck_composite_multiplicity` es el ÚNICO punto de aplicación
 * de SC-B09 — un guard de campo cruzado acá lo evitaría.
 */
export class SetEndAggregationDto implements SetEndAggregationRequest {
  @IsIn(AGGREGATION_KINDS)
  aggregation!: AggregationKind;
}

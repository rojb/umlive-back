import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { CreateElementRequest, ElementKind } from '@umlive/contracts';
import { IsInt32Range } from './int32-range.decorator';
import { NoNulBytes } from './no-nul-bytes.decorator';

const ELEMENT_KINDS: ElementKind[] = ['PACKAGE', 'CLASS', 'INTERFACE', 'ENUMERATION', 'DATATYPE', 'PRIMITIVE_TYPE', 'COMMENT'];

/**
 * Geometría inicial en la misma petición (design.md §2.1): el elemento nace
 * completo, con su layout, en una transacción (tasks.md 3.2). El mínimo se
 * aplica SOLO al tamaño — `ck_layout_size` es `CHECK (width > 0 AND height >
 * 0)`, nunca sobre la posición. `x`/`y` llevan `@IsInt()` y ningún mínimo: el
 * lienzo usa el origen y coordenadas negativas normalmente (design.md §3,
 * corregido 2026-09-13 — ver spec, requisito "El servidor no calcula ni
 * completa la geometría del nodo").
 */
export class CreateElementDto implements CreateElementRequest {
  @IsIn(ELEMENT_KINDS)
  kind!: ElementKind;

  /** `null` solo para `kind: 'COMMENT'` (ck_element_named exige lo contrario para el resto). */
  @ValidateIf((o: CreateElementDto) => o.name !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoNulBytes()
  name!: string | null;

  @ValidateIf((o: CreateElementDto) => o.parentId !== null)
  @IsUUID('4')
  parentId!: string | null;

  @IsOptional()
  @IsBoolean()
  isAbstract?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @NoNulBytes()
  stereotype?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @NoNulBytes()
  body?: string;

  // RW-4 (verify-report 2026-09-18): `int4` es el tipo real de la columna
  // (`Int` de Prisma) — `@IsInt()` solo (sin cota) deja pasar `3e9`/`1e308`
  // y revienta en la escritura con `P2020`, nunca con un `400`/`MALFORMED`.
  @IsInt()
  @IsInt32Range()
  x!: number;

  @IsInt()
  @IsInt32Range()
  y!: number;

  @IsInt()
  @Min(1)
  @IsInt32Range()
  width!: number;

  @IsInt()
  @Min(1)
  @IsInt32Range()
  height!: number;
}

/**
 * Subconjunto del metamodelo UML 2.5 que soporta el producto.
 *
 * Espeja las enumeraciones nativas de PostgreSQL de `apps/api/prisma/schema.prisma`.
 * Si divergen, el compilador no avisa y el bug aparece al exportar XMI.
 * Cuando se toque una, se toca la otra.
 *
 * Especificación: SPECS.md §3 (SPEC-B)
 */

export type ElementKind =
  | 'PACKAGE' | 'CLASS' | 'INTERFACE' | 'ENUMERATION'
  | 'DATATYPE' | 'PRIMITIVE_TYPE' | 'COMMENT';

export type FeatureKind = 'ATTRIBUTE' | 'OPERATION';

export type RelationshipKind =
  | 'ASSOCIATION' | 'GENERALIZATION' | 'INTERFACE_REALIZATION'
  | 'DEPENDENCY' | 'USAGE';

export type Visibility = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'PACKAGE';
export type AggregationKind = 'NONE' | 'SHARED' | 'COMPOSITE';
export type ParameterDirection = 'IN' | 'OUT' | 'INOUT' | 'RETURN';

/** Marcas de visibilidad en notación UML 2.5. */
export const VISIBILITY_MARK: Record<Visibility, string> = {
  PUBLIC: '+', PRIVATE: '-', PROTECTED: '#', PACKAGE: '~',
};

/**
 * Multiplicidad. `upper: null` es `*`.
 *
 * Deliberadamente sin centinelas: un `-1` que signifique infinito se filtra
 * a las comparaciones y produce resultados absurdos en silencio.
 */
export interface Multiplicity {
  lower: number;
  upper: number | null;
}

export function formatMultiplicity(m: Multiplicity): string {
  const upper = m.upper === null ? '*' : String(m.upper);
  return m.lower === m.upper ? upper : `${m.lower}..${upper}`;
}

/**
 * Tipos primitivos reconocidos. Todo lo demás debe resolver a un elemento
 * modelado; si no resuelve, se REPORTA, no se adivina (SC-F09).
 */
export const PRIMITIVE_TYPES = [
  'String', 'int', 'Integer', 'long', 'Long', 'double', 'Double',
  'decimal', 'BigDecimal', 'boolean', 'Boolean',
  'date', 'LocalDate', 'datetime', 'LocalDateTime', 'uuid', 'UUID',
] as const;

export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export function isPrimitive(name: string): name is PrimitiveType {
  return (PRIMITIVE_TYPES as readonly string[]).includes(name);
}

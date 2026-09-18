/**
 * Tabla de tipos de D5: los 17 `PRIMITIVE_TYPES` del metamodelo
 * (`packages/contracts/src/uml.ts:61-65`) resuelven a 9 pares Java/SQL.
 *
 * `example` es el valor que va al cuerpo de ejemplo de Postman. `imports` son
 * las importaciones Java que exige el tipo (vacío para los de `java.lang`).
 *
 * Los tipos SQL son los que `V1__init.sql` escribe y los que `ddl-auto=validate`
 * verifica contra PostgreSQL 17. `numeric` y `timestamp` van SIN precisión
 * explícita: el paso 0 (golden, 2026-09-18) confirmó que Hibernate 7.4.1 los
 * acepta así — es el único contrato que la IR y el DDL comparten (D4).
 */

import { PRIMITIVE_TYPES, type PrimitiveType } from '@umlive/contracts';

/** Una fila de la tabla: los dos tipos más lo que necesita la emisión. */
export interface TypeMappingRow {
  /** Tipo Java (siempre envoltorio: nunca `int`/`long`/`boolean` primitivos). */
  java: string;
  /** Tipo SQL tal como aparece en `V1__init.sql`. */
  sql: string;
  /** Importaciones Java que requiere el tipo, ya ordenadas. */
  imports: readonly string[];
  /** Valor de ejemplo para el cuerpo de Postman. */
  example: string | number | boolean;
}

/**
 * Las 9 filas. Cada uno de los 17 primitivos apunta a una de ellas:
 * `int`→`Integer`, `long`→`Long`, `double`→`Double`, `decimal`→`BigDecimal`,
 * `boolean`→`Boolean`, `date`→`LocalDate`, `datetime`→`LocalDateTime`,
 * `uuid`→`UUID`. Los envoltorios son deliberados: una entidad JPA con un
 * campo primitivo no puede distinguir «nulo» de «cero» y `NOT NULL` pasa a
 * depender del valor, no de la multiplicidad.
 */
export const TYPE_TABLE = {
  String: { java: 'String', sql: 'varchar(255)', imports: [], example: 'texto' },
  Integer: { java: 'Integer', sql: 'integer', imports: [], example: 1 },
  Long: { java: 'Long', sql: 'bigint', imports: [], example: 1 },
  Double: { java: 'Double', sql: 'double precision', imports: [], example: 1.5 },
  BigDecimal: { java: 'BigDecimal', sql: 'numeric', imports: ['java.math.BigDecimal'], example: 1.5 },
  Boolean: { java: 'Boolean', sql: 'boolean', imports: [], example: true },
  LocalDate: { java: 'LocalDate', sql: 'date', imports: ['java.time.LocalDate'], example: '2026-01-01' },
  LocalDateTime: {
    java: 'LocalDateTime',
    sql: 'timestamp',
    imports: ['java.time.LocalDateTime'],
    example: '2026-01-01T00:00:00',
  },
  UUID: { java: 'UUID', sql: 'uuid', imports: ['java.util.UUID'], example: '00000000-0000-0000-0000-000000000000' },
} as const satisfies Record<string, TypeMappingRow>;

/** Uno de los 9 nombres Java canónicos (clave de la tabla). */
export type MappedTypeName = keyof typeof TYPE_TABLE;

/**
 * Alias de los 17 primitivos a su fila. `int` y `Integer` comparten fila, y esa
 * es justamente la razón de la contradicción 2: `foo(int)` y `foo(Integer)`
 * son firmas distintas para `uml-validation` y **la misma** en Java.
 */
const PRIMITIVE_ALIASES: Record<PrimitiveType, MappedTypeName> = {
  String: 'String',
  int: 'Integer',
  Integer: 'Integer',
  long: 'Long',
  Long: 'Long',
  double: 'Double',
  Double: 'Double',
  decimal: 'BigDecimal',
  BigDecimal: 'BigDecimal',
  boolean: 'Boolean',
  Boolean: 'Boolean',
  date: 'LocalDate',
  LocalDate: 'LocalDate',
  datetime: 'LocalDateTime',
  LocalDateTime: 'LocalDateTime',
  uuid: 'UUID',
  UUID: 'UUID',
};

/**
 * Resuelve un nombre de tipo primitivo a su fila. `null` si no es uno de los 17
 * — el llamador lo reporta como `unknown_type` y **nunca** asume `String`
 * (SC-F09). Sin centinelas ni valores por defecto silenciosos.
 */
export function mapPrimitive(name: string): TypeMappingRow | null {
  if (!(PRIMITIVE_TYPES as readonly string[]).includes(name)) return null;
  return TYPE_TABLE[PRIMITIVE_ALIASES[name as PrimitiveType]];
}

/** Fila a partir del nombre Java canónico (para la PK inyectada y el enum). */
export function rowFor(java: MappedTypeName): TypeMappingRow {
  return TYPE_TABLE[java];
}

/** Los 9 tipos Java que la tabla puede producir. Útil para validar el mapeo. */
export const MAPPED_JAVA_TYPES: readonly string[] = Object.values(TYPE_TABLE).map((row) => row.java);

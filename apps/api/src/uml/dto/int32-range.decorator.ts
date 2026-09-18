import { Max, Min } from 'class-validator';

/**
 * Cota de FORMA para toda coordenada/tamaño/multiplicidad que Prisma
 * escribe en una columna `Int` (`int4` de Postgres, verify-report
 * 2026-09-18, RW-4). Sin esto, `x: 3e9` o `width: 2^40` pasan `@IsInt()`
 * (son enteros JS válidos) y revientan recién en la escritura con `P2020`
 * (`value out of range for type Int`) — `INTERNAL` + `Logger.error` por el
 * camino del socket, `500` por HTTP. Un solo decorador combinado para no
 * repetir `@Max(2147483647) @Min(-2147483648)` en cada campo.
 */
export function IsInt32Range(): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    Max(2147483647)(target, propertyKey);
    Min(-2147483648)(target, propertyKey);
  };
}

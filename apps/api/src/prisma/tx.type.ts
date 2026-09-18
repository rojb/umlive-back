import type { Prisma } from '../generated/prisma/client';

/**
 * Alias único para el cliente transaccional de Prisma (design.md D2 de
 * `operations-pipeline`). Antes duplicado en `elements.service.ts:14` y
 * `relationships.service.ts:18` — este archivo es el primer consumidor fuera
 * de `uml/` (`operations/collaboration/operation-dispatch.ts`), y una
 * dependencia `collaboration/ → ../uml/elements.service` para un simple alias
 * de tipo sería una dependencia al revés. Alias de tipo puro: cero efecto en
 * runtime.
 */
export type Tx = Prisma.TransactionClient;

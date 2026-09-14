import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * Aislamiento por diagrama para entidades direccionadas por su propio UUID
 * (design.md §1, tasks.md 2.3; spec: "Aislamiento por diagrama para
 * entidades direccionadas por su propio UUID").
 *
 * `ProjectAccessGuard` resuelve `:projectId`/`:diagramId` ANTES de que corra
 * el handler, pero no conoce `:elementId`, `:featureId`, `:parameterId` ni
 * `:literalId`. Sin esta comprobación, cualquier miembro de cualquier
 * proyecto podría editar los miembros de un diagrama ajeno poniendo su
 * propio `projectId`/`diagramId` en la URL y el UUID ajeno del recurso.
 *
 * Por qué esto NO es un guard global: la comprobación tiene que correr
 * DENTRO de la misma transacción que la escritura (design.md §1) — un
 * `CanActivate` corre antes de que el service abra ningún `$transaction`, así
 * que no tiene forma de compartir esa transacción. Tiene que vivir del lado
 * del service, llamado con su propio `tx`.
 *
 * Implementadas acá como funciones exportadas — no un método privado
 * duplicado por servicio, pese a que design.md §1 dice "un helper privado
 * por servicio". Esta unidad de trabajo (fase 2) las crea ANTES de que
 * exista ningún servicio consumidor (`ElementsService`/`FeaturesService`/
 * `ParametersService` son fase 3/4): no hay clase todavía en la que
 * anidarlas como método privado. Cada servicio de fase 3/4 importa la que
 * necesita y la llama con su propio `tx`. Funcionalmente es lo mismo que
 * pide el diseño (misma consulta, misma transacción, mismo resultado);
 * cambia solo dónde vive el código, no el comportamiento.
 *
 * `404`, nunca `403` ante discrepancia: confirmar que el recurso existe pero
 * es de otro diagrama es un oráculo. Mismo criterio que
 * `ProjectAccessGuard` ya aplica para `diagramId` ↔ `projectId`.
 */

type Tx = Prisma.TransactionClient;

export async function assertElementInDiagram(tx: Tx, elementId: string, diagramId: string): Promise<void> {
  const row = await tx.umlElement.findFirst({
    where: { id: elementId, diagramId },
    select: { id: true },
  });
  if (!row) throw new NotFoundException();
}

export async function assertFeatureInDiagram(tx: Tx, featureId: string, diagramId: string): Promise<void> {
  const row = await tx.umlFeature.findFirst({
    where: { id: featureId, owner: { diagramId } },
    select: { id: true },
  });
  if (!row) throw new NotFoundException();
}

export async function assertParameterInDiagram(tx: Tx, parameterId: string, diagramId: string): Promise<void> {
  const row = await tx.umlParameter.findFirst({
    where: { id: parameterId, operation: { owner: { diagramId } } },
    select: { id: true },
  });
  if (!row) throw new NotFoundException();
}

export async function assertLiteralInDiagram(tx: Tx, literalId: string, diagramId: string): Promise<void> {
  const row = await tx.umlEnumLiteral.findFirst({
    where: { id: literalId, enumeration: { diagramId } },
    select: { id: true },
  });
  if (!row) throw new NotFoundException();
}

/**
 * Agregado por `uml-relationships` (design.md §3 "Superficie HTTP"; tasks.md
 * 1.5). Mismo patrón que los cuatro helpers de arriba — `404`, nunca `403`.
 *
 * No hace falta un `assertEndInDiagram` aparte (design.md §3): un extremo se
 * direcciona por `endIndex` dentro de la ruta de su propia relación, así que
 * esta función + `endIndex ∈ {0,1}` ya lo aíslan por completo. Las cuatro
 * mutaciones de extremo (fase 2) cargan la fila `(relationshipId, endIndex)`
 * y responden `404` si no existe — que es también el caso de los cuatro
 * tipos sin extremos (D4); ese `404` no pasa por esta función.
 */
export async function assertRelationshipInDiagram(tx: Tx, relationshipId: string, diagramId: string): Promise<void> {
  const row = await tx.umlRelationship.findFirst({
    where: { id: relationshipId, diagramId },
    select: { id: true },
  });
  if (!row) throw new NotFoundException();
}

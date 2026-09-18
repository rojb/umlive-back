import type { PresenceUser } from '@umlive/contracts';

/**
 * Helpers PUROS de presencia (reconnect-and-presence/design.md §D7-D8) — sin
 * imports de `socket.io`: reciben estructuras planas, devuelven estructuras
 * planas. El gateway es el único que conoce sockets/salas.
 */

/**
 * Color por sala (§D7), hash de último recurso. Tres pasos, en orden:
 * 1. Mismas ventanas de la MISMA persona → copiar su color (cuatro ventanas
 *    del mismo usuario deben verse como una sola persona, no como cuatro).
 * 2. Primer color LIBRE de la paleta.
 * 3. Si los seis están tomados, `presenceColor(userId)` — último recurso,
 *    colisiona 72,2 % de las veces con 4 usuarios; el llamador lo provee
 *    para no importar `packages/contracts` acá adentro de más de lo
 *    necesario (recibe la función, no la reimplementa).
 */
export function pickColor(
  ownColorInRoom: string | undefined,
  takenInRoom: readonly string[],
  palette: readonly string[],
  fallback: () => string,
): string {
  if (ownColorInRoom) return ownColorInRoom;
  const free = palette.find((c) => !takenInRoom.includes(c));
  if (free) return free;
  return fallback();
}

/**
 * Roster deduplicado por `userId` (§D8) — `PresenceUser` no tiene identidad
 * de socket, así que cuatro ventanas del mismo usuario producirían cuatro
 * entradas idénticas sin este paso. Primera aparición gana (también la que
 * trae el color de referencia — `entries` debe venir en el mismo orden en
 * que el gateway recorrió `fetchSockets()`).
 */
export function buildRoster(
  entries: ReadonlyArray<{ userId: string; displayName: string; color: string }>,
  heldBy: (userId: string) => string[],
): PresenceUser[] {
  const seen = new Set<string>();
  const roster: PresenceUser[] = [];
  for (const entry of entries) {
    if (seen.has(entry.userId)) continue;
    seen.add(entry.userId);
    roster.push({
      userId: entry.userId,
      displayName: entry.displayName,
      color: entry.color,
      heldElementIds: heldBy(entry.userId),
    });
  }
  return roster;
}

import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, PASSWORD_MIN_LENGTH } from '@umlive/contracts';
import { randomBytes } from 'node:crypto';
import { ARGON2_PARAMS } from '../auth/password.constants';
import { PrismaClient, ProjectRole } from '../generated/prisma/client';

/**
 * Seed de la demo — `offline-docker-compose`, tarea 2.5 · design.md D5.
 *
 * **No es un módulo de Nest.** Es un script de una sola corrida que ejecuta el
 * servicio `migrate` del compose después de `prisma migrate deploy`. La app no
 * lo importa; `nest build` lo emite en `dist/seed/seed.js` porque vive bajo
 * `src/` (el runtime no tiene `tsx`).
 *
 * ── Idempotencia ────────────────────────────────────────────────────────────
 *
 * `Project` y `Diagram` no tienen clave natural única (`schema.prisma`) y
 * agregarla sería una migración, que esta rebanada no puede tocar. La centinela
 * es entonces la clave natural del host: `User.email` (`@unique`, citext). Si
 * ese email ya existe, el seed no escribe nada y sale 0.
 *
 * Todo lo demás vive en UNA sola transacción: un seed a medias no puede existir.
 * Los triggers de coherencia host/owner son diferidos a COMMIT, así que crear el
 * proyecto y su fila HOST en la misma transacción es lo correcto, no un atajo.
 *
 * ── Contraseña ──────────────────────────────────────────────────────────────
 *
 * `SEED_DEMO_PASSWORD` sale de `.env.offline` y es una sola para los cuatro
 * usuarios (PO-B). Faltante o por debajo del mínimo de `register.dto.ts` termina
 * con código 1 y la API no arranca: mejor no tener demo que tener una con la
 * contraseña de relleno de la plantilla.
 */

const SEED_HOST_EMAIL = process.env.SEED_HOST_EMAIL ?? 'mariana@umlive.test';

/** Mismo orden que la tabla de ventanas del acto 1 (`concurrency-ux`). */
const HOST_DISPLAY_NAME = 'Mariana';
const PARTICIPANTS: readonly { email: string; displayName: string }[] = [
  { email: 'diego@umlive.test', displayName: 'Diego' },
  { email: 'sofia@umlive.test', displayName: 'Sofía' },
  { email: 'tomas@umlive.test', displayName: 'Tomás' },
];

const PROJECT_NAME = 'Defensa';
const DIAGRAM_NAME = 'Defensa';

function fail(message: string): never {
  console.error(`seed: ${message}`);
  process.exit(1);
}

/** Mismo sesgo cero que `join-codes.service.ts`: 32 divide 256 exactamente. */
function randomJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += JOIN_CODE_ALPHABET[byte & 31]!;
  return code;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('falta DATABASE_URL');

  const demoPassword = process.env.SEED_DEMO_PASSWORD;
  if (!demoPassword) {
    fail('falta SEED_DEMO_PASSWORD (la contraseña única de los cuatro usuarios de la demo)');
  }
  if (demoPassword.length < PASSWORD_MIN_LENGTH) {
    fail(
      `SEED_DEMO_PASSWORD tiene ${demoPassword.length} caracteres y el mínimo de registro es ${PASSWORD_MIN_LENGTH}`,
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const sentinel = await tx.user.findUnique({
        where: { email: SEED_HOST_EMAIL },
        select: { id: true },
      });
      if (sentinel) return { applied: false as const };

      // Un solo hash: los cuatro usuarios de la demo comparten la contraseña.
      const passwordHash = await hash(demoPassword, ARGON2_PARAMS);

      const host = await tx.user.create({
        data: { email: SEED_HOST_EMAIL, displayName: HOST_DISPLAY_NAME, passwordHash },
      });

      const participantIds: string[] = [];
      for (const participant of PARTICIPANTS) {
        const created = await tx.user.create({
          data: {
            email: participant.email,
            displayName: participant.displayName,
            passwordHash,
          },
        });
        participantIds.push(created.id);
      }

      const project = await tx.project.create({
        data: {
          ownerId: host.id,
          name: PROJECT_NAME,
          description: 'Proyecto de demostración de la defensa (seed offline).',
        },
      });

      // Los triggers `trg_members_host_is_owner` son diferidos: el COMMIT es
      // donde se comprueba que `owner_id` y la fila HOST coinciden.
      await tx.projectMember.create({
        data: { projectId: project.id, userId: host.id, role: ProjectRole.HOST },
      });
      for (const userId of participantIds) {
        await tx.projectMember.create({
          data: { projectId: project.id, userId, role: ProjectRole.PARTICIPANT },
        });
      }

      const diagram = await tx.diagram.create({
        data: { projectId: project.id, name: DIAGRAM_NAME },
      });

      const code = randomJoinCode();
      await tx.diagramJoinCode.create({
        data: { diagramId: diagram.id, code, createdBy: host.id },
      });

      return { applied: true as const, code };
    });

    if (outcome.applied) {
      console.log(`seed: aplicado, código ${outcome.code}`);
    } else {
      console.log('seed: ya aplicado');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`seed: falló — ${message}`);
  process.exit(1);
});

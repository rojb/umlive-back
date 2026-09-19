import { Injectable } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, PASSWORD_MIN_LENGTH, type XmiImportResult } from '@umlive/contracts';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARGON2_PARAMS } from '../auth/password.constants';
import { Prisma, ProjectRole } from '../generated/prisma/client';
import { XmiImportService } from '../interop/xmi-import.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Bloques idempotentes del seed de la demo — `seed-data-and-demo-script`
 * Fase 2 (B1 a B6), design.md D2.
 *
 * Cada bloque se ejecuta en su propia transacción (o en la del importador) y
 * tiene **su propia centinela**. Un bloque ya aplicado no vuelve a escribir y
 * no duplica filas: correr el seed dos veces deja los conteos iguales. La
 * centinela del seed viejo (`offline-docker-compose` D5) era el email del host
 * para TODO el seed; con esa única guarda, un `Ventas` vacío dejado por esa
 * corrida sobreviviría y el acto 1 arrancaría sin `Cliente`.
 *
 * ── Por qué «a través de centinelas y no de INSERTs ciegos» ─────────────────
 *
 * - B1 usa `findUnique` por email (`@unique`) y **nunca pisa la contraseña de
 *   un usuario existente**: re-sembrar en medio de la defensa y resetear la
 *   contraseña de la demo es exactamente cómo una demo se deja afuera a sí
 *   misma.
 * - B4/B5 exigen **diagrama vivo + fila en `xmi_imports`**. Un diagrama con el
 *   nombre pero sin fila de import es una importación que nunca terminó; se
 *   borra de forma suave y se reimporta.
 * - El import usa el camino REAL de la app (`preview` → `confirm`), no
 *   `INSERT`s escritos a mano, así que la geometría y la validación son las
 *   mismas que las de la interfaz.
 *
 * ── Contraseña ──────────────────────────────────────────────────────────────
 *
 * `SEED_DEMO_PASSWORD` se lee del proceso **solo si falta algún usuario** y su
 * valor no aparece jamás en un log. Así el hosteado corre sin ella después de
 * `fly secrets unset` (`hosted-deployment` D-1.185).
 *
 * ── Fixtures ────────────────────────────────────────────────────────────────
 *
 * `ventas.xmi` y `reference.xmi` los produce una persona (Fase 1). Si faltan,
 * el bloque correspondiente falla con un mensaje que NOMBRA el archivo y una
 * salida distinta de cero, antes de crear el diagrama: nunca queda un diagrama
 * a medio importar. `SEED_FIXTURES_DIR` permite apuntar a otra carpeta — un
 * punto de verificación para cuando la Fase 1 aún no corrió; en la imagen el
 * default es `apps/api/fixtures/demo`.
 */

export const DEMO_PASSWORD_ENV = 'SEED_DEMO_PASSWORD';
export const FIXTURES_DIR_ENV = 'SEED_FIXTURES_DIR';

export const SEED_HOST_DISPLAY_NAME = 'Mariana';
export const SEED_PARTICIPANTS: readonly { email: string; displayName: string }[] = [
  { email: 'diego@umlive.test', displayName: 'Diego' },
  { email: 'sofia@umlive.test', displayName: 'Sofía' },
  { email: 'tomas@umlive.test', displayName: 'Tomás' },
];

export const SEED_PROJECT_NAME = 'Defensa';
export const VENTAS_DIAGRAM_NAME = 'Ventas';
export const REFERENCIA_DIAGRAM_NAME = 'Referencia';
export const VENTAS_FIXTURE = 'ventas.xmi';
export const REFERENCIA_FIXTURE = 'reference.xmi';

/** PO-6: el código del seed vence; un código sin vencimiento es una puerta abierta toda la cursada. */
const JOIN_CODE_TTL_MS = 48 * 60 * 60 * 1000;

export type SeedBlockId = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6';

export interface SeedBlockOutcome {
  readonly id: SeedBlockId;
  /** `true` = el bloque escribió; `false` = «ya aplicado». */
  readonly applied: boolean;
  readonly detail: string;
}

/**
 * Falla de un bloque concreto. `seed.ts` la traduce a una línea de log que
 * nombra el bloque y a `process.exit(1)`.
 */
export class SeedBlockError extends Error {
  constructor(
    readonly block: SeedBlockId,
    message: string,
  ) {
    super(message);
    this.name = 'SeedBlockError';
  }
}

function hostEmail(): string {
  return process.env.SEED_HOST_EMAIL ?? 'mariana@umlive.test';
}

/** Default = donde el Dockerfile deja los fixtures (`apps/api/fixtures/demo`). */
function fixturesDir(): string {
  return process.env[FIXTURES_DIR_ENV] ?? join(__dirname, '..', '..', 'fixtures', 'demo');
}

/** Mismo sesgo cero que `join-codes.service.ts`: 32 divide 256 exactamente. */
function randomJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += JOIN_CODE_ALPHABET[byte & 31]!;
  return code;
}

function describeUnsupported(item: { xmiId: string | null; name: string | null; type: string }): string {
  return `${item.name ?? '(sin nombre)'} (${item.type}${item.xmiId === null ? '' : `, ${item.xmiId}`})`;
}

@Injectable()
export class SeedBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly xmi: XmiImportService,
  ) {}

  // ── B1 · Usuarios ─────────────────────────────────────────────────────────
  // Centinela: `User.email` (`@unique`). Crea SOLO los que faltan y pide la
  // contraseña únicamente si falta alguno.
  async users(): Promise<{ outcome: SeedBlockOutcome; hostId: string }> {
    const host = { email: hostEmail(), displayName: SEED_HOST_DISPLAY_NAME };
    const identities = [host, ...SEED_PARTICIPANTS];

    const existing = new Map<string, string>();
    for (const who of identities) {
      const row = await this.prisma.user.findUnique({ where: { email: who.email }, select: { id: true } });
      if (row) existing.set(who.email, row.id);
    }

    const existingHostId = existing.get(host.email);
    if (existing.size === identities.length && existingHostId !== undefined) {
      return {
        outcome: {
          id: 'B1',
          applied: false,
          detail: `los ${identities.length} usuarios de la demo ya existen; no se consulta ${DEMO_PASSWORD_ENV}`,
        },
        hostId: existingHostId,
      };
    }

    const missing = identities.filter((who) => !existing.has(who.email));
    const password = process.env[DEMO_PASSWORD_ENV];
    if (password === undefined) {
      throw new SeedBlockError(
        'B1',
        `falta ${DEMO_PASSWORD_ENV} y hay ${missing.length} usuario(s) por crear (${missing.map((who) => who.email).join(', ')}): la contraseña es obligatoria para crearlos y jamás se escribe en un log`,
      );
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      throw new SeedBlockError(
        'B1',
        `${DEMO_PASSWORD_ENV} tiene ${password.length} caracteres y el mínimo de registro es ${PASSWORD_MIN_LENGTH}`,
      );
    }

    // Un solo hash: los usuarios de la demo comparten la contraseña.
    const passwordHash = await hash(password, ARGON2_PARAMS);
    let hostId = existingHostId ?? '';
    for (const who of missing) {
      const created = await this.prisma.user.create({
        data: { email: who.email, displayName: who.displayName, passwordHash },
        select: { id: true },
      });
      if (who.email === host.email) hostId = created.id;
    }

    return {
      outcome: {
        id: 'B1',
        applied: true,
        detail: `${missing.length} usuario(s) creado(s) de ${identities.length}; los existentes conservan su contraseña`,
      },
      hostId,
    };
  }

  // ── B2 · Proyecto «Defensa» + miembro HOST ───────────────────────────────
  // Centinela: `(ownerId = host, name = 'Defensa', deletedAt IS NULL)`. El
  // proyecto y su fila HOST se crean en la MISMA transacción: los triggers de
  // coherencia son diferidos y se comprueban en el COMMIT.
  async project(hostId: string): Promise<{ outcome: SeedBlockOutcome; projectId: string }> {
    const existing = await this.prisma.project.findFirst({
      where: { ownerId: hostId, name: SEED_PROJECT_NAME, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      return {
        outcome: { id: 'B2', applied: false, detail: `el proyecto «${SEED_PROJECT_NAME}» ya existe` },
        projectId: existing.id,
      };
    }

    const project = await this.prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          ownerId: hostId,
          name: SEED_PROJECT_NAME,
          description: 'Proyecto de demostración de la defensa (seed).',
        },
        select: { id: true },
      });
      await tx.projectMember.create({ data: { projectId: created.id, userId: hostId, role: ProjectRole.HOST } });
      return created;
    });

    return {
      outcome: { id: 'B2', applied: true, detail: `proyecto «${SEED_PROJECT_NAME}» creado con su miembro HOST` },
      projectId: project.id,
    };
  }

  // ── B3 · Miembros PARTICIPANT ─────────────────────────────────────────────
  // Centinela: la PK compuesta `(projectId, userId)`. `upsert`, nunca insert
  // ciego: es lo que devuelve a Diego después del paso 15 del acto 1.
  async members(projectId: string): Promise<SeedBlockOutcome> {
    const participants = await this.prisma.user.findMany({
      where: { email: { in: SEED_PARTICIPANTS.map((who) => who.email) } },
      select: { id: true },
    });

    let created = 0;
    for (const user of participants) {
      const before = await this.prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId: user.id } },
        select: { userId: true },
      });
      await this.prisma.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        create: { projectId, userId: user.id, role: ProjectRole.PARTICIPANT },
        update: { role: ProjectRole.PARTICIPANT },
      });
      if (before === null) created += 1;
    }

    return {
      id: 'B3',
      applied: created > 0,
      detail: created > 0 ? `${created} miembro(s) PARTICIPANT agregado(s)` : 'los miembros PARTICIPANT ya existen',
    };
  }

  // ── B4 · Diagrama `Ventas` ────────────────────────────────────────────────
  // Centinela: diagrama vivo CON fila en `xmi_imports`. Sin la fila, la
  // importación no terminó: se borra de forma suave y se reimporta.
  async ventasDiagram(projectId: string, hostId: string): Promise<{ outcome: SeedBlockOutcome; diagramId: string }> {
    const live = await this.prisma.diagram.findFirst({
      where: { projectId, name: VENTAS_DIAGRAM_NAME, deletedAt: null },
      select: { id: true },
    });

    if (live !== null) {
      const imports = await this.prisma.xmiImport.count({ where: { diagramId: live.id } });
      if (imports > 0) {
        return {
          outcome: {
            id: 'B4',
            applied: false,
            detail: `el diagrama «${VENTAS_DIAGRAM_NAME}» y su fila de import ya existen`,
          },
          diagramId: live.id,
        };
      }
      await this.softDeleteDiagram(live.id);
      const repaired = await this.importDiagram(projectId, hostId, VENTAS_DIAGRAM_NAME, VENTAS_FIXTURE, 'B4', false);
      return {
        outcome: {
          id: 'B4',
          applied: true,
          detail: `«${VENTAS_DIAGRAM_NAME}» estaba sin fila de import: borrado suave y reimportado (${repaired.elementCount} elemento(s))`,
        },
        diagramId: repaired.diagramId,
      };
    }

    const imported = await this.importDiagram(projectId, hostId, VENTAS_DIAGRAM_NAME, VENTAS_FIXTURE, 'B4', false);
    return {
      outcome: {
        id: 'B4',
        applied: true,
        detail: `«${VENTAS_DIAGRAM_NAME}» importado (${imported.elementCount} elemento(s))`,
      },
      diagramId: imported.diagramId,
    };
  }

  // ── B5 · Diagrama `Referencia` ────────────────────────────────────────────
  // Mismo camino que B4, más la regla dura del modelo de referencia: si el
  // pre-vuelo reporta UN solo elemento no soportado, el seed entero sale con
  // código 1 **antes** de crear el diagrama. Un modelo de referencia que
  // perdió elementos en silencio no es el que describe la defensa.
  async referenciaDiagram(projectId: string, hostId: string): Promise<SeedBlockOutcome> {
    const live = await this.prisma.diagram.findFirst({
      where: { projectId, name: REFERENCIA_DIAGRAM_NAME, deletedAt: null },
      select: { id: true },
    });

    if (live !== null) {
      const imports = await this.prisma.xmiImport.count({ where: { diagramId: live.id } });
      if (imports > 0) {
        return {
          id: 'B5',
          applied: false,
          detail: `el diagrama «${REFERENCIA_DIAGRAM_NAME}» y su fila de import ya existen`,
        };
      }
      await this.softDeleteDiagram(live.id);
      const repaired = await this.importDiagram(projectId, hostId, REFERENCIA_DIAGRAM_NAME, REFERENCIA_FIXTURE, 'B5', true);
      return {
        id: 'B5',
        applied: true,
        detail: `«${REFERENCIA_DIAGRAM_NAME}» reimportado limpio: ${repaired.elementCount} elemento(s), unsupported = []`,
      };
    }

    const imported = await this.importDiagram(projectId, hostId, REFERENCIA_DIAGRAM_NAME, REFERENCIA_FIXTURE, 'B5', true);
    return {
      id: 'B5',
      applied: true,
      detail: `«${REFERENCIA_DIAGRAM_NAME}» importado limpio: ${imported.elementCount} elemento(s), unsupported = []`,
    };
  }

  // ── B6 · Código de unión de `Ventas` ──────────────────────────────────────
  // Centinela: código activo (`revokedAt IS NULL` y `expiresAt > now()`). Si
  // falta, se crea con vencimiento a 48 h; nunca sin vencimiento.
  async joinCode(diagramId: string, hostId: string): Promise<SeedBlockOutcome> {
    const now = new Date();
    const active = await this.prisma.diagramJoinCode.findFirst({
      where: { diagramId, revokedAt: null, expiresAt: { gt: now } },
      select: { expiresAt: true },
    });
    if (active !== null) {
      return {
        id: 'B6',
        applied: false,
        detail: `«${VENTAS_DIAGRAM_NAME}» ya tiene un código activo (vence ${active.expiresAt?.toISOString() ?? 'sin fecha'})`,
      };
    }

    const expiresAt = new Date(now.getTime() + JOIN_CODE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomJoinCode();
      try {
        await this.prisma.diagramJoinCode.create({ data: { diagramId, code, createdBy: hostId, expiresAt } });
        return {
          id: 'B6',
          applied: true,
          detail: `código de unión creado, vence a las 48 h (${expiresAt.toISOString()}): ${code}`,
        };
      } catch (error) {
        // `uq_join_code_active` (índice parcial) → P2002. Mismo lazo que el
        // servicio real: a esta escala la colisión es indistinguible de cero,
        // pero sin el lazo el modo de falla es un 500 incomprensible.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    throw new SeedBlockError('B6', 'no se pudo generar un código de unión libre tras 5 intentos');
  }

  // ── `--reset` ─────────────────────────────────────────────────────────────
  // Borra de forma suave TODOS los diagramas vivos de «Defensa» y revoca sus
  // códigos activos, en una transacción. NO toca `ai_turns`: el historial de
  // IA es evidencia de gasto y de auditoría, no estado de demo.
  async reset(): Promise<{ diagrams: number; codes: number }> {
    const host = await this.prisma.user.findUnique({ where: { email: hostEmail() }, select: { id: true } });
    if (host === null) return { diagrams: 0, codes: 0 };

    const project = await this.prisma.project.findFirst({
      where: { ownerId: host.id, name: SEED_PROJECT_NAME, deletedAt: null },
      select: { id: true },
    });
    if (project === null) return { diagrams: 0, codes: 0 };

    const live = await this.prisma.diagram.findMany({
      where: { projectId: project.id, deletedAt: null },
      select: { id: true },
    });
    if (live.length === 0) return { diagrams: 0, codes: 0 };

    const ids = live.map((diagram) => diagram.id);
    const now = new Date();
    const [deleted, revoked] = await this.prisma.$transaction([
      this.prisma.diagram.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now } }),
      this.prisma.diagramJoinCode.updateMany({ where: { diagramId: { in: ids }, revokedAt: null }, data: { revokedAt: now } }),
    ]);

    return { diagrams: deleted.count, codes: revoked.count };
  }

  // ── Auxiliares ────────────────────────────────────────────────────────────

  /**
   * Borrado suave de UN diagrama con la revocación de sus códigos activos en
   * la MISMA transacción — la invariante de `join-codes-backend`: un diagrama
   * borrado no puede dejar un código activo apuntándole.
   */
  private async softDeleteDiagram(diagramId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.diagram.update({ where: { id: diagramId }, data: { deletedAt: now } }),
      this.prisma.diagramJoinCode.updateMany({ where: { diagramId, revokedAt: null }, data: { revokedAt: now } }),
    ]);
  }

  /**
   * Importa un fixture por el camino REAL de la app: admisión → `preview` (sin
   * escribir) → `confirm` (transaccional). El `preview` corre antes de
   * cualquier escritura, así que el chequeo de `unsupported` de B5 aborta sin
   * haber creado el diagrama.
   */
  private async importDiagram(
    projectId: string,
    actorId: string,
    diagramName: string,
    filename: string,
    block: SeedBlockId,
    requireClean: boolean,
  ): Promise<XmiImportResult> {
    const path = join(fixturesDir(), filename);
    if (!existsSync(path)) {
      throw new SeedBlockError(
        block,
        `falta el fixture ${filename}: se esperaba en ${path} (lo produce la Fase 1, [HUMAN]). No se crea «${diagramName}» a medias`,
      );
    }

    const buffer = readFileSync(path);
    const target = { projectId, diagramId: null, sourceFilename: filename };
    const preview = await this.xmi.preview(buffer, target);

    if (requireClean && preview.unsupported.length > 0) {
      const shown = preview.unsupported.slice(0, 3).map(describeUnsupported).join('; ');
      throw new SeedBlockError(
        block,
        `la importación de «${diagramName}» reporta ${preview.unsupported.length} elemento(s) no soportado(s) [${shown}]: se aborta ANTES de crear el diagrama (el modelo de referencia entra limpio o no entra)`,
      );
    }

    return this.xmi.confirm(buffer, {
      ...target,
      contentDigest: preview.contentDigest,
      diagramName,
      actorId,
    });
  }
}

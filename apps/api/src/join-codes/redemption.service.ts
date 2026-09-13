import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { JOIN_CODE_ERROR, normalizeJoinCode, type ProjectSummary, type RedeemJoinCodeResponse } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedemptionAttemptsService } from './redemption-attempts.service';

/**
 * Nombre de la restricción CHECK que arbitra el empate del último uso
 * (design.md §4). Prisma no la tipa como sí tipa `P2002` — hay que
 * reconocerla por el nombre en el error crudo de PostgreSQL (SQLSTATE
 * 23514). La constante vive acá, al lado del único `catch` que la usa, para
 * que un `rg ck_join_code_uses` encuentre las dos puntas.
 */
const CK_JOIN_CODE_USES = 'ck_join_code_uses';

/** Señal interna: el `updateMany` condicionado no tocó ninguna fila — el código se revocó o venció entre la lectura y la transacción. */
class StaleJoinCodeError extends Error {}

/**
 * Redención (design.md §2.1, §4, §6.2). Advertencia obligatoria heredada de
 * la propuesta/diseño: `schema.prisma:295` declara `code String @db.Citext`
 * **SIN `@unique`** — el único es el índice parcial `uq_join_code_active`,
 * invisible para Prisma. `findUnique({ where: { code } })` **NO COMPILA**;
 * toda búsqueda por código usa `findFirst`.
 */
@Injectable()
export class RedemptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attempts: RedemptionAttemptsService,
  ) {}

  async redeem(userId: string, ip: string, rawCode: string): Promise<RedeemJoinCodeResponse> {
    const code = normalizeJoinCode(rawCode);
    const actorKey = this.attempts.actorKey(userId);
    const ipKey = this.attempts.ipKey(ip);
    const codeKey = this.attempts.codeKey(code);

    try {
      return await this.attemptRedeem(userId, code);
    } catch (err) {
      // Ciego a la existencia del código (design.md §5.1): el mismo fallo se
      // registra para inexistente, revocado, vencido y agotado. `429` no
      // pasa por acá — lo corta el guard antes de llegar al servicio, y no
      // hay `reset()` acá arriba tampoco: acertar no perdona los fallos
      // anteriores (trampa #4).
      this.attempts.registerFailure(actorKey);
      this.attempts.registerFailure(ipKey);
      this.attempts.registerFailure(codeKey);
      throw err;
    }
  }

  private async attemptRedeem(userId: string, code: string): Promise<RedeemJoinCodeResponse> {
    // 1 — camino feliz: pega en el índice parcial uq_join_code_active.
    const active = await this.prisma.diagramJoinCode.findFirst({
      where: { code, revokedAt: null },
      select: {
        id: true,
        expiresAt: true,
        diagram: {
          select: { projectId: true, deletedAt: true, project: { select: { deletedAt: true } } },
        },
      },
    });

    if (!active) {
      // 2 — SOLO si la anterior dio null: distinguir "revocado" de
      // "inválido" (SC-A14). Scan sin índice, deuda aceptada y acotada: solo
      // corre en el camino de fallo, que el limitador de §5 acota
      // (design.md §4.1).
      const anyRow = await this.prisma.diagramJoinCode.findFirst({ where: { code }, select: { id: true } });
      if (anyRow) throw new GoneException({ code: JOIN_CODE_ERROR.REVOKED });
      throw new NotFoundException({ code: JOIN_CODE_ERROR.INVALID });
    }

    // Diagrama/proyecto borrado suavemente → mismo predicado que una
    // revocación manual (design.md §2.5): "este código ya no puede otorgar
    // nada", un solo código de error.
    if (active.diagram.deletedAt || active.diagram.project.deletedAt) {
      throw new GoneException({ code: JOIN_CODE_ERROR.REVOKED });
    }
    if (active.expiresAt && active.expiresAt.getTime() <= Date.now()) {
      throw new GoneException({ code: JOIN_CODE_ERROR.EXPIRED });
    }

    const projectId = active.diagram.projectId;

    const result = await this.runTransaction(projectId, userId, active.id).catch((err: unknown) =>
      this.reclassify(err, active.id),
    );

    const project = await this.toProjectSummary(projectId, userId);
    return { project, alreadyMember: result.alreadyMember };
  }

  /**
   * Orden FIJO, no negociable (design.md §4, trampa #2 y #3):
   *
   * 1) Membresía previa ANTES del incremento. Un `HOST` que redime su
   *    propio código sale por acá sin tocar `use_count` ni `role` — al
   *    revés, se degradaría a `PARTICIPANT` y perdería su propio proyecto,
   *    en silencio.
   * 2) `updateMany` con `useCount: { increment: 1 }` — SET, nunca
   *    leer-modificar-escribir. El `WHERE` NO filtra por `use_count`/
   *    `maxUses` a propósito: el árbitro del empate es `ck_join_code_uses`
   *    en la base, no esta consulta. Con leer-modificar-escribir, dos
   *    redenciones simultáneas contra `max_uses: 1` leerían las dos
   *    `use_count = 0` y pasarían las dos.
   * 3) Alta de `PARTICIPANT`. `P2002` acá es la otra petición del mismo
   *    usuario ganando la carrera — `alreadyMember`, no un error.
   */
  private async runTransaction(
    projectId: string,
    userId: string,
    codeId: string,
  ): Promise<{ alreadyMember: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      });
      if (existing) return { alreadyMember: true };

      const updated = await tx.diagramJoinCode.updateMany({
        where: {
          id: codeId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        data: { useCount: { increment: 1 } },
      });
      if (updated.count === 0) throw new StaleJoinCodeError();

      try {
        await tx.projectMember.create({ data: { projectId, userId, role: 'PARTICIPANT' } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          return { alreadyMember: true };
        }
        throw err;
      }
      return { alreadyMember: false };
    });
  }

  /** Reclasifica un rollback de la transacción en el `code` de error correcto. Siempre lanza. */
  private async reclassify(err: unknown, codeId: string): Promise<never> {
    if (this.isCheckViolation(err, CK_JOIN_CODE_USES)) {
      throw new GoneException({ code: JOIN_CODE_ERROR.EXHAUSTED });
    }
    if (err instanceof StaleJoinCodeError) {
      const fresh = await this.prisma.diagramJoinCode.findUnique({
        where: { id: codeId },
        select: { revokedAt: true, expiresAt: true },
      });
      if (!fresh || fresh.revokedAt) throw new GoneException({ code: JOIN_CODE_ERROR.REVOKED });
      if (fresh.expiresAt && fresh.expiresAt.getTime() <= Date.now()) {
        throw new GoneException({ code: JOIN_CODE_ERROR.EXPIRED });
      }
      // Ni revocado ni vencido y aun así el UPDATE no tocó la fila: solo
      // queda agotado (la carrera del último uso, perdida).
      throw new GoneException({ code: JOIN_CODE_ERROR.EXHAUSTED });
    }
    throw err;
  }

  /**
   * Prisma no tipa las violaciones de `CHECK` (design.md §4): se reconocen
   * por el nombre de la restricción en el error crudo, sea cual sea la
   * forma exacta que tome (`meta` o el mensaje). Verificado contra la base
   * real en la Fase 3 — no se asume.
   */
  private isCheckViolation(err: unknown, constraintName: string): boolean {
    if (!(err instanceof Error)) return false;
    const meta = (err as { meta?: unknown }).meta;
    const haystack = `${err.message} ${meta ? JSON.stringify(meta) : ''}`;
    return haystack.includes(constraintName);
  }

  /**
   * Duplica ~20 líneas de `ProjectsService` a propósito (mismo criterio que
   * `RedemptionAttemptsService` vs. `LoginAttemptsService`, design.md §5):
   * `JoinCodesModule` no importa `ProjectsModule` — es un costo declarado
   * del diseño (§1), no un olvido. Si aparece un tercer consumidor, ahí se
   * extrae.
   */
  private async toProjectSummary(projectId: string, userId: string): Promise<ProjectSummary> {
    const [project, diagrams, members] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          id: true,
          name: true,
          description: true,
          updatedAt: true,
          owner: { select: { id: true, displayName: true, avatarUrl: true } },
        },
      }),
      this.prisma.diagram.findMany({
        where: { projectId, deletedAt: null },
        select: { name: true, updatedAt: true },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId },
        select: { role: true, user: { select: { id: true, displayName: true, avatarUrl: true } } },
        orderBy: { joinedAt: 'asc' },
      }),
    ]);

    const role = members.find((m) => m.user.id === userId)?.role ?? 'PARTICIPANT';

    let lastActivityAt = project.updatedAt;
    for (const d of diagrams) {
      if (d.updatedAt > lastActivityAt) lastActivityAt = d.updatedAt;
    }

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      role,
      owner: project.owner,
      diagramCount: diagrams.length,
      memberCount: members.length,
      members: members.slice(0, 3).map((m) => m.user),
      diagramNames: diagrams.map((d) => d.name),
      lastActivityAt: lastActivityAt.toISOString(),
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { JOIN_CODE_ALPHABET, JOIN_CODE_ERROR, JOIN_CODE_LENGTH, type JoinCodeView } from '@umlive/contracts';
import { randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { GenerateJoinCodeDto } from './dto/generate-join-code.dto';

/** A esta escala la probabilidad de colisión es indistinguible de cero, pero el lazo se escribe igual (design.md §2.4). */
const MAX_GENERATE_RETRIES = 5;

interface JoinCodeRow {
  id: string;
  code: string;
  diagramId: string;
  createdAt: Date;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  diagram: { name: string };
}

@Injectable()
export class JoinCodesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-A10, design.md §6.1. Un diagrama, a lo sumo un código activo:
   * revoca el anterior en la MISMA transacción antes de crear el nuevo.
   * `randomBytes(8) & 31` indexa el alfabeto de 32 símbolos — 32 divide 256
   * exactamente, sin sesgo, sin muestreo por rechazo (design.md §2.4).
   */
  async generate(diagramId: string, userId: string, dto: GenerateJoinCodeDto): Promise<JoinCodeView> {
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    const maxUses = dto.maxUses ?? null;

    for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt++) {
      const code = this.randomCode();
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          await tx.diagramJoinCode.updateMany({
            where: { diagramId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return tx.diagramJoinCode.create({
            data: { diagramId, code, createdBy: userId, expiresAt, maxUses },
            include: { diagram: { select: { name: true } } },
          });
        });
        return this.toView(created);
      } catch (err) {
        // uq_join_code_active (índice parcial) → P2002. Colisión de 40 bits
        // contra el resto de códigos activos: reintentar con otro código.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }

    // Después de 5 intentos esto ya no es una colisión — es un bug. Fallar
    // ruidoso en vez de devolver un 500 incomprensible más adelante.
    throw new Error('join-codes: no se pudo generar un código único tras 5 intentos');
  }

  /**
   * `joinCode.list` — solo HOST vía el guard (design.md §2.3). Filtra
   * diagramas activos: un código de un diagrama borrado ya quedó revocado
   * por `DiagramsService.softDelete()` (design.md §2.5), pero el filtro
   * queda igual como cinturón y tirantes.
   */
  async list(projectId: string): Promise<JoinCodeView[]> {
    const rows = await this.prisma.diagramJoinCode.findMany({
      where: { revokedAt: null, diagram: { projectId, deletedAt: null } },
      include: { diagram: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * FR-A11, design.md §3/§6.3. El guard no conoce `:codeId` — este chequeo
   * residual de pertenencia a `:projectId` es del servicio. Toca SOLO
   * `revoked_at`: `project_members` queda intacto (SC-A15).
   */
  async revoke(projectId: string, codeId: string): Promise<void> {
    const row = await this.prisma.diagramJoinCode.findFirst({
      where: { id: codeId, diagram: { projectId } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ code: JOIN_CODE_ERROR.NOT_FOUND });

    await this.prisma.diagramJoinCode.update({
      where: { id: codeId },
      data: { revokedAt: new Date() },
    });
  }

  private randomCode(): string {
    const bytes = randomBytes(JOIN_CODE_LENGTH);
    let code = '';
    for (const byte of bytes) {
      // biome-ignore lint/style/noNonNullAssertion: byte & 31 siempre indexa dentro de los 32 símbolos del alfabeto.
      code += JOIN_CODE_ALPHABET[byte & 31]!;
    }
    return code;
  }

  private toView(row: JoinCodeRow): JoinCodeView {
    return {
      id: row.id,
      code: row.code,
      diagramId: row.diagramId,
      diagramName: row.diagram.name,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      maxUses: row.maxUses,
      useCount: row.useCount,
    };
  }
}

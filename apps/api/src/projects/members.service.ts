import { ForbiddenException, Injectable } from '@nestjs/common';
import { PROJECT_ERROR } from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SC-A12 (`concurrency-ux` D8). Devuelve los diagramas del proyecto ADEMÁS
   * de sacar la membresía, porque quien llama —`MemberRemovalController`, en
   * `collaboration/`— necesita los ids para soltar los locks del usuario en
   * ESOS diagramas y en ningún otro. El desalojo de los sockets lo hace el
   * gateway en el mismo paso síncrono.
   *
   * Las dos consultas van en UNA transacción y el `DELETE` es idempotente: si
   * el usuario ya no era miembro, igual devuelve los ids, para que los sockets
   * que quedaron de una expulsión anterior se cierren igual. Antes esto era un
   * `delete` pelado que podía tirar `P2025` en la carrera entre dos hosts, y
   * devolvía `void`.
   *
   * Alcance de los locks: por DIAGRAMA del proyecto, nunca
   * `releaseAllForUser(userId)` — alcance global, le soltaría los locks de
   * otros proyectos donde sigue siendo miembro (escenario de aislamiento entre
   * proyectos). El `findMany` NO filtra por `deletedAt`: esto no es un listado
   * para mostrar, es el alcance de una limpieza, y un diagrama borrado con un
   * lock huérfano también hay que soltarlo.
   *
   * MUST rechazar con `403 cannot_remove_host` si `userId` es la fila HOST,
   * sin tocar la fila (design.md §3.1) — quitar al host sería transferir la
   * propiedad (FR-A17), fuera de alcance. `uq_project_single_host` +
   * `trg_members_host_is_owner` son el backstop de base; esto es la ruta de
   * usuario que evita llegar a necesitarlo.
   */
  async remove(projectId: string, userId: string): Promise<{ diagramIds: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
      });

      if (membership?.role === 'HOST') {
        throw new ForbiddenException({ code: PROJECT_ERROR.CANNOT_REMOVE_HOST });
      }

      // Ya no es miembro ⇒ no hay fila que borrar, pero la transacción sigue:
      // el desalojo es idempotente y cierra el caso de los sockets sobrantes.
      if (membership) {
        await tx.projectMember.deleteMany({ where: { projectId, userId } });
      }

      const diagrams = await tx.diagram.findMany({
        where: { projectId },
        select: { id: true },
      });

      return { diagramIds: diagrams.map((d) => d.id) };
    });
  }
}

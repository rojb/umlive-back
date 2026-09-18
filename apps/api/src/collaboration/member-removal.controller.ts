import { Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { MembersService } from '../projects/members.service';
import { RequiresProjectAction } from '../projects/guards/requires-project-action.decorator';
import { CollaborationGateway } from './collaboration.gateway';

/**
 * Quitar a un miembro del proyecto — SC-A12 (`concurrency-ux` D8).
 *
 * **Vive en `collaboration/` y no en `projects/`**, y `projects/members.
 * controller.ts` se BORRÓ: su único método era este. Es el mismo movimiento que
 * D1 de `diagram-freeze` hizo con el interruptor de congelado, y por el mismo
 * motivo: el desalojo necesita el gateway (que está en este módulo), así que
 * con la ruta en `projects/` `ProjectsModule` tendría que importar
 * `CollaborationModule` — que ya lo importa a él — y el ciclo solo se podría
 * tapar con `forwardRef`. La dependencia va en un solo sentido
 * (Collaboration → Projects) y la URL no cambia.
 *
 * Sin DOS handlers para la misma ruta: con el controlador viejo todavía
 * registrado, el que Express registró primero gana y el otro queda muerto sin
 * que nada avise.
 *
 * `ProjectAccessGuard` es `APP_GUARD` y lee la metadata de cualquier
 * controlador, así que `@RequiresProjectAction('member.remove')` (solo HOST)
 * sigue funcionando igual; se importa el decorador **como archivo**, nunca como
 * módulo.
 *
 * El orden del handler es el contrato: primero la transacción (membresía
 * afuera + diagramas del proyecto), y recién DESPUÉS — y sin ningún `await` en
 * el medio — el desalojo. Todo el desalojo pasa dentro de la misma respuesta
 * `DELETE`, así que la cota real es un RTT.
 */
@Controller('projects/:projectId/members')
export class MemberRemovalController {
  constructor(
    private readonly members: MembersService,
    private readonly gateway: CollaborationGateway,
  ) {}

  @Delete(':userId')
  @RequiresProjectAction('member.remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    // El `await` es la transacción. Lo que sigue corre en el mismo tick en que
    // se resolvió: soltar locks, revocar, desconectar y anunciar el
    // `presence:left` sin ceder el hilo (D8).
    const { diagramIds } = await this.members.remove(projectId, userId);
    this.gateway.evictUserFromProject(userId, projectId, diagramIds);
  }
}

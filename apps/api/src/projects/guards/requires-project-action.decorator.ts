import { SetMetadata } from '@nestjs/common';
import type { ProjectAction } from '@umlive/contracts';

/**
 * La contraparte de `ProjectAccessGuard` (design.md §2.2). Una ruta con
 * `projectId`/`diagramId` en los params SIN este decorador responde `403` y
 * loguea el nombre del handler — el olvido CIERRA, nunca abre.
 */
export const PROJECT_ACTION_KEY = 'projectAction';

export const RequiresProjectAction = (action: ProjectAction) =>
  SetMetadata(PROJECT_ACTION_KEY, action);

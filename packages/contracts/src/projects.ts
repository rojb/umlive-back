/**
 * Contrato de proyectos, roles, miembros y diagramas — solo tipos y
 * constantes, sin dependencias de ejecución (misma regla que `auth.ts`).
 *
 * La matriz `PROJECT_PERMISSIONS` es la fuente ÚNICA de la autorización de
 * FR-A13: la consulta tanto `ProjectAccessGuard` en el servidor como `can()`
 * en el cliente (pista visual, nunca la autorización real — design.md §8).
 *
 * Especificación: `openspec/changes/projects/specs/projects-backend/spec.md`,
 * `openspec/changes/projects/specs/projects-frontend/spec.md`.
 * Diseño: `openspec/changes/projects/design.md` §2, §7.3.
 */

export type ProjectRole = 'HOST' | 'PARTICIPANT';

/**
 * Desde qué rebanada/hito existe un llamador real para esta acción. No
 * confundir con "implementado": todas las acciones están en la matriz desde
 * hoy, pero solo las de `enforcedSince: 'projects'` tienen ruta y controlador
 * en esta rebanada (design.md §2.1).
 */
export type EnforcedSince = 'projects' | 'join-codes' | 'M2' | 'M4' | 'M5' | 'M6';

export interface ActionRule {
  readonly roles: readonly ProjectRole[];
  readonly enforcedSince: EnforcedSince;
  /** Fila literal de la tabla de FR-A13 que esta acción implementa. */
  readonly frA13Row: string;
}

/**
 * Granularidad: un verbo, una acción. FR-A13 agrupa varios verbos en una
 * misma fila (p. ej. "crear / renombrar / borrar diagrama"); acá se separan
 * para que M2+ pueda endurecer uno sin tocar los otros, y `frA13Row` conserva
 * la trazabilidad hacia la fila del PRD (design.md §2.1).
 */
export const PROJECT_PERMISSIONS = {
  'project.create': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'projects', frA13Row: 'Create / delete project' },
  'project.delete': { roles: ['HOST'], enforcedSince: 'M5', frA13Row: 'Create / delete project' },
  'project.view': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'projects', frA13Row: '(agregada — ver design.md §2.4)' },
  'member.add': { roles: ['HOST'], enforcedSince: 'projects', frA13Row: 'Add / remove project members' },
  'member.remove': { roles: ['HOST'], enforcedSince: 'projects', frA13Row: 'Add / remove project members' },
  'diagram.create': { roles: ['HOST'], enforcedSince: 'projects', frA13Row: 'Create / rename / delete diagram' },
  'diagram.rename': { roles: ['HOST'], enforcedSince: 'projects', frA13Row: 'Create / rename / delete diagram' },
  'diagram.delete': { roles: ['HOST'], enforcedSince: 'projects', frA13Row: 'Create / rename / delete diagram' },
  'diagram.view': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'projects', frA13Row: 'View diagram' },
  'joinCode.generate': { roles: ['HOST'], enforcedSince: 'join-codes', frA13Row: 'Generate / revoke join code' },
  'joinCode.revoke': { roles: ['HOST'], enforcedSince: 'join-codes', frA13Row: 'Generate / revoke join code' },
  'diagram.lock': { roles: ['HOST'], enforcedSince: 'M4', frA13Row: 'Lock / unlock diagram' },
  'diagram.unlock': { roles: ['HOST'], enforcedSince: 'M4', frA13Row: 'Lock / unlock diagram' },
  'diagram.edit': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'M2', frA13Row: 'Edit diagram content (when unlocked)' },
  'xmi.import': { roles: ['HOST'], enforcedSince: 'M5', frA13Row: 'Import XMI into a diagram' },
  'export.run': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'M5', frA13Row: 'Export XMI / generate code / export Postman' },
  'ai.use': { roles: ['HOST', 'PARTICIPANT'], enforcedSince: 'M6', frA13Row: 'Use the AI assistant on a diagram' },
  'ai.configure': { roles: ['HOST'], enforcedSince: 'M6', frA13Row: "Change the project's AI provider / model" },
} as const satisfies Record<string, ActionRule>;

export type ProjectAction = keyof typeof PROJECT_PERMISSIONS;

/**
 * `role` viene siempre del servidor (nunca calculado ni cacheado aparte en el
 * cliente — design.md §8, FR-A12). El guard del servidor y `can()` del
 * cliente consultan la MISMA tabla: acá no hay margen para que diverjan.
 */
export const can = (role: ProjectRole, action: ProjectAction): boolean =>
  (PROJECT_PERMISSIONS[action].roles as readonly ProjectRole[]).includes(role);

export interface UserRef {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DiagramSummary {
  id: string;
  name: string;
  lockState: 'UNLOCKED' | 'LOCKED_BY_HOST';
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  role: ProjectRole;
  owner: UserRef;
  diagramCount: number;
  memberCount: number;
  /** Recortado a 3 — son los avatares que A3 muestra por proyecto. */
  members: UserRef[];
  /** FR-G06: buscar por nombre de diagrama sin ir al servidor. */
  diagramNames: string[];
  /**
   * `max(diagrams.updatedAt, project.updatedAt)`. Hoy NO es actividad real —
   * la etiqueta visible dice "Actualizado", no "Última actividad", hasta que
   * exista `DiagramOperation` (M2/M3). Ver design.md §5.
   */
  lastActivityAt: string;
}

/** `owned`/`joined` ya vienen partidos por el servidor — SC-G03 (design.md §7.3). */
export interface DashboardResponse {
  owned: ProjectSummary[];
  joined: ProjectSummary[];
}

export interface ProjectMemberView {
  user: UserRef;
  role: ProjectRole;
  joinedAt: string;
}

/**
 * `Omit<ProjectSummary, 'members'>` y no `extends ProjectSummary` liso, como
 * decía design.md §7.3 literalmente: `ProjectSummary.members` es
 * `UserRef[]` (recortado a 3, para los avatares de A3) y acá se necesita
 * `ProjectMemberView[]` completo (con `role` y `joinedAt`, para B1). Un
 * `extends` directo no tipa — TypeScript rechaza sobreescribir una propiedad
 * con un tipo que no es subtipo del original. `Omit` conserva el resto de
 * los campos de `ProjectSummary` sin tocarlos. Desviación de diseño anotada
 * en apply-progress; el conjunto de campos es idéntico al que design.md pide.
 */
export interface ProjectDetail extends Omit<ProjectSummary, 'members'> {
  members: ProjectMemberView[];
  diagrams: DiagramSummary[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
}

/** Solo email — no existe búsqueda por nombre de usuario (FR-A08 corregido). */
export interface AddMemberRequest {
  email: string;
}

export interface RenameDiagramRequest {
  name: string;
}

export const PROJECT_ERROR = {
  PROJECT_NOT_FOUND: 'project_not_found',
  DIAGRAM_NOT_FOUND: 'diagram_not_found',
  INSUFFICIENT_ROLE: 'insufficient_role',
  USER_NOT_FOUND: 'user_not_found',
  ALREADY_MEMBER: 'already_member',
  CANNOT_REMOVE_HOST: 'cannot_remove_host',
} as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR)[keyof typeof PROJECT_ERROR];

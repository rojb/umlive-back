import { SetMetadata } from '@nestjs/common';

/**
 * Excepción explícita al guard de autenticación global (design.md §5). El
 * modo de falla que importa no es un endpoint público protegido de más — es
 * un endpoint privado al que se le olvidó el `@UseGuards`. Con el guard
 * global y esta excepción opt-in, olvidarse CIERRA en vez de abrir.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

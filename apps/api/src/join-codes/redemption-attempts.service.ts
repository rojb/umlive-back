import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

/**
 * Contador de intentos fallidos de redención — en memoria, mismo mecanismo
 * que `LoginAttemptsService` (`auth/login-attempts.service.ts`), pero
 * PROPIO: `auth/` no se toca (design.md §5). PRD §9 dice que la única
 * costura del proyecto es el proveedor de IA — duplicar ~40 líneas se
 * acepta explícitamente en vez de acoplar un módulo de producto a `auth`
 * para conseguir un `Map`, o de extraer una abstracción genérica que
 * arriesgue SC-A04 por una refactorización de código ya verificado
 * (design.md §5, tabla de opciones).
 *
 * **Diferencia deliberada con `auth`: este servicio NO declara `reset()`.**
 * En login, acertar prueba que la cuenta es tuya. Acá, acertar un código de
 * 40 bits prueba que TENÍAS ese código — no excusa los intentos fallidos
 * anteriores contra otros códigos, y no debería devolver presupuesto para
 * seguir probando. La invariante "sin reset al acertar" (design.md §5.1)
 * queda garantizada por construcción: no hay método que un llamador
 * apurado pueda invocar por error.
 *
 * **Diferencia deliberada con `auth`: el pepper NO cae a `''` si falta.**
 * `apps/api/.env` está bloqueada por permisos (deuda #4 de `projects`), así
 * que `AUTH_THROTTLE_PEPPER` se reutiliza (design.md §5) en vez de introducir
 * `JOIN_THROTTLE_PEPPER`. `LoginAttemptsService` cae a `''` si la variable
 * falta; acá se usa `getOrThrow` a propósito — un pepper de relleno en
 * memoria es peor que un arranque que falla ruidoso y nombra la causa.
 *
 * Especificación: `openspec/changes/join-codes/specs/join-codes-backend/spec.md`
 * — "Limitador de redención propio, ciego a la existencia del código y sin
 * reinicio al acertar".
 */
interface Bucket {
  hits: number[];
}

const WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class RedemptionAttemptsService implements OnModuleDestroy {
  private readonly log = new Logger(RedemptionAttemptsService.name);

  private readonly buckets = new Map<string, Bucket>();
  private readonly pepper: string;
  private readonly sweeper: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.pepper = config.getOrThrow<string>('AUTH_THROTTLE_PEPPER');
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /** Cubeta por actor — la defensa PRINCIPAL (design.md §5.1): redimir exige sesión, a diferencia de `auth`. */
  actorKey(userId: string): string {
    return `jc:user:${userId}`;
  }

  /** Cubeta por IP. Sin HMAC: la IP no delata cuentas, solo origen de red. */
  ipKey(ip: string): string {
    return `jc:ip:${ip}`;
  }

  /**
   * Cubeta por texto del código, ya normalizado — la MÁS DÉBIL (design.md
   * §5.1, al revés que en `auth`): un atacante prueba un código distinto
   * cada vez, así que esta cubeta nunca se llena sola contra enumeración.
   */
  codeKey(normalizedCode: string): string {
    const mac = createHmac('sha256', this.pepper).update(normalizedCode).digest('hex');
    return `jc:code:${mac.slice(0, 16)}`;
  }

  countRecent(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const cutoff = Date.now() - WINDOW_MS;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length === 0) {
      this.buckets.delete(key);
      return 0;
    }
    return bucket.hits.length;
  }

  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hits.length === 0) return Math.ceil(WINDOW_MS / 1000);
    const oldest = Math.min(...bucket.hits);
    const remainingMs = oldest + WINDOW_MS - Date.now();
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  /**
   * Registra un fallo. Lo llama `RedemptionService` DESPUÉS de saber que la
   * redención falló — ciego a la existencia del código: el mismo camino se
   * ejerce para inexistente, revocado, vencido y agotado (design.md §5.1).
   */
  registerFailure(key: string): void {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits.push(Date.now());
    this.buckets.set(key, bucket);
  }

  private sweep(): void {
    const cutoff = Date.now() - WINDOW_MS;
    let swept = 0;
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) {
        this.buckets.delete(key);
        swept++;
      }
    }
    if (swept > 0) this.log.debug(`Vencida(s) ${swept} cubeta(s) de intentos de redención`);
  }
}

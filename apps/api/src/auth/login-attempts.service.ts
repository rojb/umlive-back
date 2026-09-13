import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

/**
 * Contador de intentos fallidos de login — en memoria, a propósito.
 *
 * Por qué existe y por qué así (design.md §2.1/§2.2):
 *
 *   FR-A02 exige limitar por cuenta y por IP. SC-A04 exige que un intento
 *   inválido sea indistinguible entre "no existe la cuenta" y "existe pero
 *   la contraseña es incorrecta" — cuerpo, código Y TIEMPO. Un contador que
 *   solo existiera para cuentas reales sería un oráculo de enumeración: a
 *   partir del N-ésimo intento, el servidor empezaría a comportarse distinto
 *   según exista o no la cuenta.
 *
 *   La solución es que el limitador NO CONOZCA usuarios. Se llavea por el
 *   identificador ENVIADO, exista cuenta detrás o no, y el contador se crea
 *   en el primer fallo — el comportamiento observable es idéntico en los dos
 *   casos.
 *
 * Por qué en memoria y no en Redis: PRD §12 Q5 fija una sola instancia de
 * backend, así que un `Map` con barrido por TTL alcanza. Es el mismo patrón
 * que `collaboration/locks.service.ts` — cero dependencias nuevas.
 *
 * Consecuencia aceptada: reiniciar el proceso vacía los contadores. En una
 * instancia única de un proyecto de examen es un intercambio correcto frente
 * a operar una pieza de infraestructura más.
 *
 * Especificación: `openspec/changes/auth/specs/auth-backend/spec.md`
 * — "Limitador ciego a la existencia de la cuenta".
 */

interface Bucket {
  /** Timestamps (ms) de fallos dentro de la ventana vigente. */
  hits: number[];
}

@Injectable()
export class LoginAttemptsService implements OnModuleDestroy {
  private readonly log = new Logger(LoginAttemptsService.name);

  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs = 15 * 60 * 1000;
  private readonly pepper: string;
  private readonly sweeper: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.pepper = config.get<string>('AUTH_THROTTLE_PEPPER') ?? '';
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    // No debe mantener vivo el proceso.
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /** Cubeta por IP. Sin HMAC: la IP no delata cuentas, solo origen de red. */
  ipKey(ip: string): string {
    return `ip:${ip}`;
  }

  /**
   * Cubeta por identificador enviado (exista o no la cuenta).
   *
   * `normalizar` = `trim().toLowerCase()`, el mismo criterio que impone la
   * columna `citext` de `users.email`, para que `MARIANA@UNI.EDU` y
   * `mariana@uni.edu` compartan cubeta y no se puedan usar como dos
   * presupuestos de intentos distintos. El HMAC evita guardar el email en
   * claro en memoria y da claves de largo fijo.
   */
  identifierKey(email: string): string {
    const normalized = email.trim().toLowerCase();
    const mac = createHmac('sha256', this.pepper).update(normalized).digest('hex');
    return `id:${mac.slice(0, 16)}`;
  }

  /**
   * Fallos dentro de la ventana vigente. Poda los vencidos de esta cubeta de
   * paso — no hace falta esperar al barrido periódico para leer un número
   * correcto.
   */
  countRecent(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const cutoff = Date.now() - this.windowMs;
    bucket.hits = bucket.hits.filter((t) => t > cutoff);
    if (bucket.hits.length === 0) {
      this.buckets.delete(key);
      return 0;
    }
    return bucket.hits.length;
  }

  /**
   * Segundos hasta que el fallo más viejo de la cubeta caduque — el valor de
   * `Retry-After`. Solo tiene sentido llamarlo cuando el umbral ya está
   * superado, así que la cubeta existe.
   */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.hits.length === 0) return Math.ceil(this.windowMs / 1000);
    const oldest = Math.min(...bucket.hits);
    const remainingMs = oldest + this.windowMs - Date.now();
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  /**
   * Registra un fallo. Lo llama `AuthService` después de saber que el login
   * falló — este servicio no decide sobre credenciales, solo cuenta.
   * El contador se crea acá, en el primer fallo, exista o no la cuenta.
   */
  registerFailure(key: string): void {
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits.push(Date.now());
    this.buckets.set(key, bucket);
  }

  /** Reinicio explícito tras un login correcto (design.md §2.1, tabla). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    let swept = 0;
    for (const [key, bucket] of this.buckets) {
      bucket.hits = bucket.hits.filter((t) => t > cutoff);
      if (bucket.hits.length === 0) {
        this.buckets.delete(key);
        swept++;
      }
    }
    if (swept > 0) this.log.debug(`Vencida(s) ${swept} cubeta(s) de intentos`);
  }
}

# Variables de entorno — `apps/api`

Copiá el bloque del final a **`apps/api/.env`**. Ese archivo no va al repositorio
(`.gitignore` lo excluye); este `.md` sí, para que quede documentado qué existe.

**Todo vive acá y no en la raíz** porque todo lo consume la API. La web no lee
ninguna variable: con origen único llama a rutas relativas, así que no necesita
saber dónde está el backend.

---

## Paridad por entorno (dev / offline / hosteado)

*(`hosted-deployment` D5/D7, tarea 4.1, 2026-09-19.)*

Los **nombres** de variable son los mismos en los tres entornos; lo que cambia es
el valor y de dónde sale. La verificación V6 compara los nombres de
`.env.offline.example` —sin `POSTGRES_*`, `SEED_*` ni
`AI_OPENAI_COMPATIBLE_*`— contra la unión de `[env]` de `fly.toml` y
`fly secrets list`, sin las `FLY_*` que inyecta la plataforma: el `diff` tiene
que dar vacío.

| Variable | dev | offline | hosteado |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://umlive:umlive@localhost:5434/umlive?schema=public` (compose de `apps/api`) | `…@db:5432/umlive?schema=public` (servicio `db`) | **URL DIRECTA de Neon** —sin `-pooler`— con `sslmode=require`. **Secreto** |
| `NODE_ENV` | `development` | `production` | `production` (`[env]`) |
| `PORT` | `3000` | `3000` | `3000` (`[env]`; coincide con `internal_port`) |
| `COOKIE_SECURE` | sin definir (`false` por `NODE_ENV`) | `false` (LAN por HTTP) | `true` explícito (`[env]`) |
| `TRUST_PROXY_HOPS` | `0` | `0` | `1` (`[env]`; el proxy agrega un salto) |
| `AI_SPEND_CEILING_USD` | `25.00` | `2.00` | **`8.00`** (`[env]`) |
| `NODE_OPTIONS` | — | — | `--max-old-space-size=640` (`[env]`) |
| `JWT_*_SECRET`, `AUTH_THROTTLE_PEPPER`, claves de IA | `.env` local | `.env.offline` | `fly secrets` |

**Por qué la URL es la directa y no la del pooler** (D5): `prisma migrate
  deploy` toma un `pg_advisory_lock` **de sesión** y el pooler en modo
transacción devuelve esa sesión a otro cliente — la migración se rompe. Con una
sola instancia y ≤ 10 conexiones no hay nada que multiplexar, y así no aparece un
`DIRECT_URL` que rompería la paridad con la offline. `sslmode=require`: es el
valor que aceptan los dos consumidores (`prisma.config.ts` y `prisma.service.ts`)
y `pg` lo trata como `verify-full`.

**Qué vive dónde en el hosteado** (D7):

- **`fly.toml [env]`**, versionado y revisado en el PR: `NODE_ENV`, `PORT`,
  `COOKIE_SECURE`, `TRUST_PROXY_HOPS`, `AI_SPEND_CEILING_USD`, `NODE_OPTIONS` y
  los no secretos de este documento (`ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`,
  `AI_DEFAULT_*`, límites de IA, `LOCK_*`, `SNAPSHOT_EVERY_N_OPS`,
  `MAX_RECONNECT_DELTA_OPS`).
- **`fly secrets import`**, desde un archivo que vive FUERA del repo (por
  ejemplo `%USERPROFILE%\umlive-secrets\hosted.env`): `DATABASE_URL`,
  `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AUTH_THROTTLE_PEPPER`,
  `GOOGLE_GENERATIVE_AI_API_KEY` y **solo** las demás claves de IA que se usen.
  `SEED_DEMO_PASSWORD` es temporal: se da de baja apenas termina el seed.
- **Ningún valor secreto se escribe en el repo ni queda en la imagen.**

> **⚠️ Precios y límites del hosteado SIN VERIFICAR (G0.2 y G0.4, 2026-09-19).**
> Las tareas que los verifican siguen abiertas: acá no hay ningún precio
> confirmado. Los supuestos que hay que confirmar en las páginas oficiales antes
> de pagar son: que la región `gru` exista y su precio por región (hay reportes
> de comunidad de un recargo cercano al 25 % en algunas regiones), que
> `shared-cpu-1x` con 1 GB ronda **US$5.70–5.92 por mes** según fuentes de
> terceros (no confirmado en `fly.io/docs/about/pricing`), el egreso en
> Sudamérica, la IPv4 compartida gratuita, y las CU-horas del plan Free de Neon
> (hay un reporte de usuario de que el cómputo incluido bajó de 0.25 a 0.125 CU).
> **La decisión de pagar es del product owner, no de este documento**: el techo
> de US$10/mes de PO-3 es el supuesto de trabajo, no una medición.

---

## Base de datos

| Variable | Qué hace |
|---|---|
| `DATABASE_URL` | Cadena de conexión. La leen el CLI de Prisma (vía `prisma.config.ts`) y la API en ejecución |

El valor por defecto coincide con el `docker-compose.yml` de esta carpeta, así
que `npm run db:up` y listo. Si usás una base gestionada, cambiala.

> **Puerto 5434, no 5432** (descubierto en `sdd-apply` de `auth`, 2026-09-12).
> En esta máquina de desarrollo el 5432 ya lo ocupa un contenedor de otro
> proyecto. `docker-compose.yml` publica `umlive-db` en `5434` del host (el
> contenedor sigue escuchando `5432` puertas adentro). Si tu máquina no tiene
> ese conflicto, `5432:5432` también funciona — solo mantené `DATABASE_URL`
> coherente con el puerto que de verdad publicaste.

> **Prisma 7 no carga el `.env` solo.** `prisma.config.ts` lo carga explícitamente
> con `dotenv`, desde una ruta anclada a sí mismo. Por eso los comandos funcionan
> igual desde `apps/api` o desde donde sea.

## Servidor

| Variable | Por defecto | Qué hace |
|---|---|---|
| `PORT` | `3000` | Puerto único: API, WebSocket y bundle de la web |
| `NODE_ENV` | `development` | |
| `TRUST_PROXY_HOPS` | `0` | Cuántos saltos de proxy confiar para resolver la IP del cliente. **Se pasa como número a `app.set('trust proxy', …)`** (un string sería una lista de IPs, no un conteo). `0` = hoy: `req.ip` es la del socket. `1` = la IP más a la derecha de `X-Forwarded-For`, la que escribió el proxy de la plataforma. Techo de 3; `TRUST_PROXY_HOPS` mayor que los saltos reales deja al cliente elegir su propia IP |
| `WEB_DIST_PATH` | *(vacío)* | Ruta al bundle compilado. Normalmente **no hace falta**: se resuelve relativa al propio archivo compilado. Solo para despliegues raros |

## Sesiones

| Variable | Qué hace |
|---|---|
| `JWT_ACCESS_SECRET` | Firma del access token |
| `JWT_REFRESH_SECRET` | Firma del refresh token. **Distinto del anterior** |
| `ACCESS_TOKEN_TTL` | Vida del access token |
| `REFRESH_TOKEN_TTL` | Vida del refresh token |
| `AUTH_THROTTLE_PEPPER` | Secreto del HMAC que llavea el limitador de intentos de login (`login-attempts.service.ts`). Nunca se guarda el email en claro en memoria — ver `design.md` §2.1 |
| `COOKIE_SECURE` | Fuerza el atributo `Secure` de la cookie de refresh. Sin definir vale `NODE_ENV === 'production'`; definida, **solo** acepta `true` o `false`. Cualquier otro valor (`False`, `0`, `si`) **impide que la API arranque** y nombra la variable |

Generá cada secreto por separado:

```bash
openssl rand -base64 48
```

> El access token dura 15 minutos por diseño (PRD §7). El refresh es rotativo y
> vive en cookie `httpOnly` + `SameSite=Lax`. Ese `Lax` **solo es correcto porque
> el frontend y la API comparten origen**; separarlos obligaría a `SameSite=None`
> y expondría el refresh a las restricciones de cookies de terceros — falla en
> silencio, justo en el navegador del evaluador.
>
> **`Secure` lo decide `COOKIE_SECURE`; sin definir, es `NODE_ENV === 'production'`.**
> No es relajar la seguridad por comodidad: **WebKit no considera a `localhost`
> contexto seguro y descarta las cookies `Secure`**, así que en desarrollo el
> login bajo Safari devolvería 200 y aun así no habría sesión, sin ningún error
> visible. Chrome, Edge y Firefox sí las aceptan. En producción sigue siendo
> `true`, que es donde importa. Por la misma razón no se usa el prefijo
> `__Host-`, que exige `Secure`.
>
> **⚠️ `COOKIE_SECURE=false` manda el refresh token EN CLARO por la red.** En la
> plataforma offline (`docker-compose.yml` de la raíz) el valor baja a `false`
> porque el teléfono entra por `http://<IP-LAN>:3000` y el navegador descarta
> una cookie `Secure` sobre HTTP: el login daría 200 y no quedaría sesión. Eso
> es aceptable **únicamente** en la LAN de la demostración. Fuera de la demo,
> dejá `COOKIE_SECURE` sin definir. Cuando la API arranca con
> `NODE_ENV=production` y `COOKIE_SECURE=false`, registra una advertencia una
> sola vez.

## Validación del arranque

**Desde `nfr-verification-and-security-hardening` (2026-09-19), la API valida el entorno ANTES de aceptar tráfico.** Un valor inválido hace que el proceso **termine con código 1**, nombre **todas** las variables que fallan juntas y no imprima ninguno de sus valores. El mensaje nunca cita el valor de un secreto, porque un error que lo cita lo escribe en el log de arranque.

| Variable | Regla |
|---|---|
| `DATABASE_URL` | No vacía |
| `JWT_ACCESS_SECRET` | ≥ 32 caracteres |
| `JWT_REFRESH_SECRET` | ≥ 32 caracteres, **distinta** de la anterior |
| `AUTH_THROTTLE_PEPPER` | ≥ 32 caracteres |
| `ACCESS_TOKEN_TTL` | Opcional (`15m` por defecto). Formato `15m`/`900s`/`30d`, entre 1 y 900 segundos |
| `REFRESH_TOKEN_TTL` | Opcional. Mismo formato, mayor que 0 |
| `LOCK_TTL_MS` | Opcional (default `15000`). Entero entre **6000 y 15000**. El piso existe porque el latido es cada 5 s: con un TTL menor, el lock vencería entre dos latidos |
| `LOCK_SWEEP_INTERVAL_MS` | Opcional (default `1000`). Entero entre **100 y 1000** |
| `TRUST_PROXY_HOPS` | Opcional. Un dígito de `0` a `3` |
| `PORT` | Opcional. Entero entre 1 y 65535 |
| `NODE_ENV` | Opcional. `development` o `production` |
| `COOKIE_SECURE` | Opcional. Solo `true` o `false` |

> **⚠️ Los placeholders del bloque de abajo FALLAN A PROPÓSITO.** `cambiar-esto`, `cambiar-esto-tambien` y `cambiar-esto-tambien-2` tienen entre 12 y 23 caracteres: están por debajo del mínimo de 32 **para que el arranque no pase** hasta que generes secretos reales con `openssl rand -base64 48`. Antes de esta rebanada arrancaban en silencio con un secreto adivinable.

> **El override por shell también se valida.** `$env:ACCESS_TOKEN_TTL='20m'` desde PowerShell hace fallar el arranque; `'90s'` pasa.

---

## Asistente de IA

| Variable | Por defecto | Qué hace |
|---|---|---|
| `AI_DEFAULT_PROVIDER` | `gemini` | Proveedor del sistema. Cada proyecto puede sobreescribirlo |
| `AI_DEFAULT_MODEL` | `gemini-flash` | |

Claves — **completá solo las que vayas a usar**. Sin clave, el proveedor aparece
como no disponible en la interfaz en vez de fallar al invocarlo (SC-D02):

| Variable | Proveedor |
|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini — el default |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `MOONSHOT_API_KEY` | Moonshot Kimi |

### Control de gasto

| Variable | Por defecto | Qué hace |
|---|---|---|
| `AI_SPEND_CEILING_USD` | `25.00` | **Techo duro acumulado.** Al alcanzarlo se rechazan los turnos antes de llamar al proveedor. En offline se fija en `2.00` |
| `AI_MAX_TOOL_ITERATIONS` | `25` | Corta bucles de herramientas que no convergen |
| `AI_RATE_LIMIT_TURNS_PER_HOUR` | `20` | Límite de ritmo por usuario |
| `AI_RATE_LIMIT_IMAGE_TURNS_PER_HOUR` | `5` | Los turnos con imagen cuestan más |
| `AI_RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR` | *(sin default)* | Límite de ritmo de las transcripciones de audio |

> El presupuesto total del proyecto es **US$30**. El techo queda en 25 para dejar
> margen a la defensa. A los precios medidos eso son ~4.400 turnos de texto, así
> que **el riesgo no es el volumen: es un bucle sin guarda**, que puede quemarlo
> todo en minutos. Por eso el cap se aplica en el servidor y no en la interfaz.
>
> Configurá además un límite de facturación en la cuenta del proveedor. Es la
> segunda línea de defensa, y no depende de que este código esté bien.
>
> **Techo offline**: el entorno de la defensa fija `AI_SPEND_CEILING_USD=2.00`
> (no `25.00`). El acto usa IA pregrabada y esta instancia no debe poder tocar
> el presupuesto de dev/hosteado. No se implementa ningún `default` distinto
> acá: el valor lo pone `.env.offline`.

## Seed de la demo

| Variable | Qué hace |
|---|---|
| `SEED_HOST_EMAIL` | Email del usuario centinela. Si ya existe en `users`, el seed no escribe nada y termina en 0 (idempotencia) |
| `SEED_DEMO_PASSWORD` | Contraseña **única** de los cuatro usuarios de la demo (PO-B). Vive solo en `.env.offline`. Faltante o por debajo del mínimo de registro, el seed termina con código 1 y la API no arranca |

## Concurrencia

| Variable | Por defecto | Qué hace |
|---|---|---|
| `LOCK_TTL_MS` | `15000` | Vida de un bloqueo de elemento |
| `LOCK_SWEEP_INTERVAL_MS` | `1000` | Cada cuánto se barren los vencidos |
| `SNAPSHOT_EVERY_N_OPS` | `100` | Cada cuántas operaciones se guarda un snapshot |
| `MAX_RECONNECT_DELTA_OPS` | `500` | Sobre esta brecha, al reconectar se manda snapshot en vez de delta |

> **`LOCK_TTL_MS` + `LOCK_SWEEP_INTERVAL_MS` definen la cota de liberación.**
> Con 15 s y 1 s, un elemento nunca queda tomado más de **16 s** después de que
> su dueño deje de latir. Ese es el número exacto que assertan los tests de
> SC-C05. Si tocás cualquiera de los dos, el test cambia.
>
> `SNAPSHOT_EVERY_N_OPS` y `MAX_RECONNECT_DELTA_OPS` son **conjeturas iniciales**,
> no mediciones — los ítems D1 y D2 de `DATA-MODEL.md` §7. Ajustalos con un log
> de operaciones real.

---

## Para pegar en `apps/api/.env`

```dotenv
# ── Base de datos ───────────────────────────────────────────────
# Puerto 5434: ver nota arriba sobre el conflicto de 5432 en esta máquina.
DATABASE_URL="postgresql://umlive:umlive@localhost:5434/umlive?schema=public"

# ── Servidor ────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
# Sin definir vale `NODE_ENV === 'production'`. Solo `true`/`false`.
# COOKIE_SECURE=false
# WEB_DIST_PATH=""

# ── Sesiones ────────────────────────────────────────────────────
# Generar cada uno con: openssl rand -base64 48
JWT_ACCESS_SECRET="cambiar-esto"
JWT_REFRESH_SECRET="cambiar-esto-tambien"
ACCESS_TOKEN_TTL="15m"
REFRESH_TOKEN_TTL="30d"
AUTH_THROTTLE_PEPPER="cambiar-esto-tambien-2"

# ── IA ──────────────────────────────────────────────────────────
AI_DEFAULT_PROVIDER="gemini"
AI_DEFAULT_MODEL="gemini-flash"

# Solo las que vayas a usar
GOOGLE_GENERATIVE_AI_API_KEY=""
OPENAI_API_KEY=""
ANTHROPIC_API_KEY=""
DEEPSEEK_API_KEY=""
MOONSHOT_API_KEY=""

AI_SPEND_CEILING_USD="25.00"
AI_MAX_TOOL_ITERATIONS="25"
AI_RATE_LIMIT_TURNS_PER_HOUR="20"
AI_RATE_LIMIT_IMAGE_TURNS_PER_HOUR="5"
AI_RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR=""

# ── Seed de la demo ─────────────────────────────────────────────
# Solo lo usan `docker-compose.yml` (raíz) y el seed; en dev no hacen falta.
SEED_HOST_EMAIL="mariana@umlive.test"
SEED_DEMO_PASSWORD=""

# ── Concurrencia ────────────────────────────────────────────────
LOCK_TTL_MS="15000"
LOCK_SWEEP_INTERVAL_MS="1000"
SNAPSHOT_EVERY_N_OPS="100"
MAX_RECONNECT_DELTA_OPS="500"
```

---

## Qué hace falta para arrancar

Para `npm run db:up` y las migraciones alcanza con `DATABASE_URL`.

Para levantar la API hace falta además que `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET` y `AUTH_THROTTLE_PEPPER` tengan valores reales de **al menos
32 caracteres** (generados por separado con `openssl rand -base64 48`). Con los
placeholders `"cambiar-esto"` la API **ya no arranca**: la validación del arranque
(ver arriba) los rechaza a propósito.

Las claves de IA no hacen falta hasta el hito M6.

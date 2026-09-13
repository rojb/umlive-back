# Variables de entorno — `apps/api`

Copiá el bloque del final a **`apps/api/.env`**. Ese archivo no va al repositorio
(`.gitignore` lo excluye); este `.md` sí, para que quede documentado qué existe.

**Todo vive acá y no en la raíz** porque todo lo consume la API. La web no lee
ninguna variable: con origen único llama a rutas relativas, así que no necesita
saber dónde está el backend.

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
| `WEB_DIST_PATH` | *(vacío)* | Ruta al bundle compilado. Normalmente **no hace falta**: se resuelve relativa al propio archivo compilado. Solo para despliegues raros |

## Sesiones

| Variable | Qué hace |
|---|---|
| `JWT_ACCESS_SECRET` | Firma del access token |
| `JWT_REFRESH_SECRET` | Firma del refresh token. **Distinto del anterior** |
| `ACCESS_TOKEN_TTL` | Vida del access token |
| `REFRESH_TOKEN_TTL` | Vida del refresh token |
| `AUTH_THROTTLE_PEPPER` | Secreto del HMAC que llavea el limitador de intentos de login (`login-attempts.service.ts`). Nunca se guarda el email en claro en memoria — ver `design.md` §2.1 |

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
> **`Secure` se activa solo en producción** (`secure: NODE_ENV === 'production'`).
> No es relajar la seguridad por comodidad: **WebKit no considera a `localhost`
> contexto seguro y descarta las cookies `Secure`**, así que en desarrollo el
> login bajo Safari devolvería 200 y aun así no habría sesión, sin ningún error
> visible. Chrome, Edge y Firefox sí las aceptan. En producción sigue siendo
> `true`, que es donde importa. Por la misma razón no se usa el prefijo
> `__Host-`, que exige `Secure`.

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
| `AI_SPEND_CEILING_USD` | `25.00` | **Techo duro acumulado.** Al alcanzarlo se rechazan los turnos antes de llamar al proveedor |
| `AI_MAX_TOOL_ITERATIONS` | `25` | Corta bucles de herramientas que no convergen |
| `AI_TURNS_PER_HOUR` | `20` | Límite de ritmo por usuario |
| `AI_IMAGE_TURNS_PER_HOUR` | `5` | Los turnos con imagen cuestan más |

> El presupuesto total del proyecto es **US$30**. El techo queda en 25 para dejar
> margen a la defensa. A los precios medidos eso son ~4.400 turnos de texto, así
> que **el riesgo no es el volumen: es un bucle sin guarda**, que puede quemarlo
> todo en minutos. Por eso el cap se aplica en el servidor y no en la interfaz.
>
> Configurá además un límite de facturación en la cuenta del proveedor. Es la
> segunda línea de defensa, y no depende de que este código esté bien.

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
AI_TURNS_PER_HOUR="20"
AI_IMAGE_TURNS_PER_HOUR="5"

# ── Concurrencia ────────────────────────────────────────────────
LOCK_TTL_MS="15000"
LOCK_SWEEP_INTERVAL_MS="1000"
SNAPSHOT_EVERY_N_OPS="100"
MAX_RECONNECT_DELTA_OPS="500"
```

---

## Qué hace falta para arrancar

Para `npm run db:up` y las migraciones alcanza con `DATABASE_URL`.

Para levantar la API hace falta además que `JWT_ACCESS_SECRET` y
`JWT_REFRESH_SECRET` tengan valores reales — con `"cambiar-esto"` arranca, pero
cualquiera podría firmar tokens válidos.

Las claves de IA no hacen falta hasta el hito M6.

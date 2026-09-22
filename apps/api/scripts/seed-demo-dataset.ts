/**
 * `seed-demo-dataset.ts` — siembra el MISMO dataset de demostración en local
 * y en producción, hablando SOLO con la API HTTP (`odd/tasks/demo-dataset-parity.md`).
 *
 * **Script plano, corrido a mano. NO es un runner, NO es `*.test.*`, NO es
 * `*.spec.*`, y no está cableado a ningún pipeline.** Mismo precedente que
 * `scripts/mobile-fixture-backend.ts` y `scripts/roundtrip-check.ts`.
 *
 * ── Por qué existe, en vez de reusar `src/seed/seed.ts` ──────────────────
 * Ese seed crea otras personas (`Mariana`/`diego`/`sofia`/`tomas`) y un solo
 * proyecto (`Defensa`), y sus dos diagramas dependen de dos archivos `.xmi`
 * que nunca se comitearon (`fixtures/demo/README.md` es lo único que hay).
 * Lo que se pidió es distinto: Ruben + Ernesto + Jose + Marcos, tres
 * proyectos, seis diagramas en español.
 *
 * ── Por qué el camino es XMI y no una escritura directa ──────────────────
 * **No existe un endpoint REST que edite el contenido de un diagrama** — la
 * edición UML vive en el WebSocket gateway. La única puerta HTTP para poblar
 * un diagrama es el import de XMI:
 *
 *   POST /projects/:projectId/import/xmi/preview   (multipart, campo «file»)
 *   POST /projects/:projectId/import/xmi/confirm    (+ contentDigest, diagramName)
 *
 * `demo-dataset.ts` arma los seis `DiagramContent` en memoria y los emite con
 * el exportador REAL de la API (`src/interop/xmi-emitter.ts` y compañía) —
 * la misma técnica que `mobile-fixture-backend.ts` usa para `buildIr`, nunca
 * un dialecto escrito a mano. Los bytes viven solo en memoria: no se agrega
 * ningún `.xmi` al repositorio.
 *
 * ── Qué prueba, exactamente ───────────────────────────────────────────────
 * Que las cuatro cuentas existen y loguean, que Ruben es HOST de los tres
 * proyectos y los otros tres PARTICIPANT (vía el flujo real de invitación:
 * código de unión + canje), que los seis diagramas existen y están
 * poblados, y que cada uno pasa la validación (cero hallazgos bloqueantes),
 * exporta XMI `200` y genera código `200`. Todo por HTTP contra un servidor
 * vivo — nunca escribiendo una fila directo a la base.
 *
 * ── Idempotencia ──────────────────────────────────────────────────────────
 * Correrlo dos veces no duplica nada: un `409` en el registro significa que
 * la cuenta ya existe y el script loguea en su lugar; un proyecto cuyo
 * nombre ya existe bajo Ruben se reusa; un diagrama cuyo nombre ya existe en
 * ese proyecto se saltea (no se reimporta); un participante que ya es
 * miembro del proyecto no vuelve a canjear código. Solo se acuña un código
 * de unión nuevo cuando falta al menos un participante por sumar a ESE
 * proyecto — nunca en una corrida donde ya están los cuatro.
 *
 * ── Uso ────────────────────────────────────────────────────────────────
 * ```
 * cd apps/api
 * npx tsx scripts/seed-demo-dataset.ts --base http://localhost:3000
 * npx tsx scripts/seed-demo-dataset.ts --base https://umlive-api.fly.dev
 * ```
 * (`ts-node --transpile-only` también sirve. `tsc` NO tipa este archivo a
 * propósito: vive fuera de `rootDir`, igual que los otros dos scripts de esta
 * carpeta — así lo declara `scripts/mobile-fixture-backend.ts`.)
 *
 * `--base` es opcional; sin él, apunta a `http://localhost:3000`.
 *
 * Requiere: la API del `--base` elegido, viva y con su base migrada. Nada
 * más — no toca `DATABASE_URL`, no usa `psql`, no necesita Docker.
 */

import type {
  AuthSession,
  CodegenBlockedBody,
  CodegenFinding,
  DashboardResponse,
  JoinCodeView,
  ProjectDetail,
  ProjectSummary,
  RedeemJoinCodeResponse,
  ValidationReport,
  XmiImportPreview,
  XmiImportResult,
} from '@umlive/contracts';
import { isBlockingRule, PASSWORD_MIN_LENGTH } from '@umlive/contracts';
import { buildDiagramContent, emitXmiDocument, PROJECT_SPECS, type DiagramSpec, type ProjectSpec } from './demo-dataset';

/**
 * La misma contraseña para las cuatro cuentas, leída del entorno y nunca
 * impresa.
 *
 * **No va escrita acá, y la razón no es estética.** `rojb/umlive-back` es un
 * repositorio **público**, y estas cuentas existen de verdad en el hosteado:
 * una de ellas es anfitriona de los tres proyectos. Dejar la contraseña en el
 * código sería publicar la llave de una instancia viva —diagramas que se pueden
 * borrar, y un presupuesto de IA real detrás del techo de `AI_SPEND_CEILING_USD`.
 *
 * Es además la convención que el seed de producto ya sigue:
 * `src/seed/seed-blocks.ts` lee `SEED_DEMO_PASSWORD` del entorno y nunca la
 * registra. Este script usa la misma variable a propósito, para que sembrar
 * con uno o con el otro no pida dos secretos distintos.
 */
const PASSWORD = (() => {
  const raw = process.env.SEED_DEMO_PASSWORD ?? '';
  if (raw.length < PASSWORD_MIN_LENGTH) {
    throw new Error(
      `falta SEED_DEMO_PASSWORD (o tiene menos de ${PASSWORD_MIN_LENGTH} caracteres). ` +
        'Es la contraseña de las cuatro cuentas de demostración; no se escribe en el código ' +
        'porque este repositorio es público. Ejemplo: SEED_DEMO_PASSWORD=… npx tsx scripts/seed-demo-dataset.ts --base …',
    );
  }
  return raw;
})();

interface AccountSpec {
  displayName: string;
  email: string;
  role: 'HOST' | 'PARTICIPANT';
}

/** Ruben es el host; los otros tres canjean el código de unión de cada proyecto. */
const ACCOUNTS: AccountSpec[] = [
  { displayName: 'Ruben', email: 'ruben@umlive.demo', role: 'HOST' },
  { displayName: 'Ernesto', email: 'ernesto@umlive.demo', role: 'PARTICIPANT' },
  { displayName: 'Jose', email: 'jose@umlive.demo', role: 'PARTICIPANT' },
  { displayName: 'Marcos', email: 'marcos@umlive.demo', role: 'PARTICIPANT' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP mínimo — sin dependencias, igual que roundtrip-check.ts
// ─────────────────────────────────────────────────────────────────────────────

/** Todo bajo `/api`, salvo `/health` (que este script no usa). */
async function apiRequest(base: string, token: string | null, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(`${base}/api${path}`, { ...init, headers });
}

async function apiJson<T>(base: string, token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiRequest(base, token, path, init);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// T3 — el driver HTTP
// ─────────────────────────────────────────────────────────────────────────────

interface Session {
  userId: string;
  displayName: string;
  email: string;
  token: string;
  /** `true` si este script lo creó recién; `false` si ya existía y solo logueó. */
  created: boolean;
}

/**
 * Login primero, registro solo si la cuenta no existe (idempotencia de cuentas).
 *
 * **El orden importa y no es estético.** `RegistrationThrottleGuard` permite
 * apenas **10 intentos de registro por IP cada 15 minutos** y cuenta *todo*
 * intento, también los `409` de correo ya tomado
 * (`src/auth/registration-throttle.guard.ts`, `REGISTRATION_LIMIT`). Intentar
 * registrar primero gasta cuatro cupos en cada corrida, así que a la tercera
 * el script muere con `429 too_many_attempts` a mitad de la siembra. Medido.
 *
 * Al revés no cuesta nada: una cuenta que ya existe loguea bien y no toca el
 * cupo de registro. El login tiene su propio techo, mucho más holgado —30 por
 * IP y 5 por identificador—, y un login correcto **reinicia** la cubeta del
 * identificador (`auth.service.ts`), así que las corridas repetidas no se
 * acumulan.
 */
async function registerOrLogin(base: string, account: AccountSpec): Promise<Session> {
  const loginRes = await apiRequest(base, null, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: account.email, password: PASSWORD }),
  });
  if (loginRes.ok) {
    const session = (await loginRes.json()) as AuthSession;
    return { userId: session.user.id, displayName: account.displayName, email: account.email, token: session.accessToken, created: false };
  }
  // `401` es «no existe, o la contraseña no es esta»: el login es ciego a la
  // existencia de la cuenta a propósito (SC-A04), así que no puede distinguir.
  // El registro que sigue resuelve la ambigüedad: `201` era lo primero, `409`
  // era lo segundo y entonces la contraseña guardada no es la de este script.
  if (loginRes.status !== 401) {
    throw new Error(`login de ${account.email} falló: ${loginRes.status} ${await loginRes.text()}`);
  }

  const registerRes = await apiRequest(base, null, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName: account.displayName, email: account.email, password: PASSWORD }),
  });
  if (registerRes.status === 201) {
    const session = (await registerRes.json()) as AuthSession;
    return { userId: session.user.id, displayName: account.displayName, email: account.email, token: session.accessToken, created: true };
  }
  if (registerRes.status === 409) {
    throw new Error(
      `${account.email} ya existe pero su contraseña no es la de este script: el login dio 401 y el registro 409. ` +
        'Hay que resolverlo a mano; el script no pisa la contraseña de una cuenta existente.',
    );
  }
  throw new Error(`registro de ${account.email} falló: ${registerRes.status} ${await registerRes.text()}`);
}

/** Un proyecto cuyo nombre ya existe entre los propios de Ruben se reusa (idempotencia de proyectos). */
async function ensureProject(base: string, hostToken: string, spec: ProjectSpec): Promise<{ project: ProjectSummary; created: boolean }> {
  const dashboard = await apiJson<DashboardResponse>(base, hostToken, '/projects');
  const existing = dashboard.owned.find((project) => project.name === spec.name);
  if (existing !== undefined) return { project: existing, created: false };

  const created = await apiJson<ProjectSummary>(base, hostToken, '/projects', {
    method: 'POST',
    body: JSON.stringify({ name: spec.name, description: spec.description }),
  });
  return { project: created, created: true };
}

/** El `file` viaja como bytes crudos en un `Blob` — el mismo camino que ejercita `roundtrip-check.ts`. */
async function importDiagram(base: string, hostToken: string, projectId: string, diagramName: string, document: string): Promise<XmiImportResult> {
  const previewForm = new FormData();
  previewForm.append('file', new Blob([document], { type: 'text/xml' }), `${diagramName}.xmi`);
  const preview = await apiJson<XmiImportPreview>(base, hostToken, `/projects/${projectId}/import/xmi/preview`, {
    method: 'POST',
    body: previewForm,
  });

  const confirmForm = new FormData();
  confirmForm.append('file', new Blob([document], { type: 'text/xml' }), `${diagramName}.xmi`);
  confirmForm.append('contentDigest', preview.contentDigest);
  confirmForm.append('diagramName', diagramName);
  return apiJson<XmiImportResult>(base, hostToken, `/projects/${projectId}/import/xmi/confirm`, {
    method: 'POST',
    body: confirmForm,
  });
}

interface DiagramOutcome {
  spec: DiagramSpec;
  diagramId: string;
  imported: boolean;
  elementCount: number | null;
}

interface ProjectOutcome {
  spec: ProjectSpec;
  project: ProjectSummary;
  created: boolean;
  diagrams: DiagramOutcome[];
  joinedNow: string[];
  alreadyMembers: string[];
}

/**
 * Un proyecto completo: reusa o crea, importa los diagramas que falten,
 * y suma a los participantes que todavía no sean miembros vía código de
 * unión + canje (FR-A10 / diseño de join-codes) — nunca escribiendo
 * `project_members` directo.
 */
async function processProject(base: string, host: Session, participants: Session[], spec: ProjectSpec): Promise<ProjectOutcome> {
  const { project, created } = await ensureProject(base, host.token, spec);
  const detail = await apiJson<ProjectDetail>(base, host.token, `/projects/${project.id}`);

  const diagrams: DiagramOutcome[] = [];
  for (const diagramSpec of spec.diagrams) {
    const existing = detail.diagrams.find((diagram) => diagram.name === diagramSpec.name);
    if (existing !== undefined) {
      diagrams.push({ spec: diagramSpec, diagramId: existing.id, imported: false, elementCount: null });
      continue;
    }
    const content = buildDiagramContent(diagramSpec);
    const document = emitXmiDocument(content);
    const result = await importDiagram(base, host.token, project.id, diagramSpec.name, document);
    diagrams.push({ spec: diagramSpec, diagramId: result.diagramId, imported: true, elementCount: result.elementCount });
  }

  const alreadyMemberIds = new Set(detail.members.map((member) => member.user.id));
  const missing = participants.filter((participant) => !alreadyMemberIds.has(participant.userId));
  const alreadyMembers = participants.filter((participant) => alreadyMemberIds.has(participant.userId)).map((p) => p.displayName);

  if (missing.length > 0) {
    // Un código por diagrama; el primero de los dos alcanza — la membresía
    // que otorga es de PROYECTO, no de diagrama (diseño de join-codes).
    const firstDiagramId = diagrams[0]?.diagramId;
    if (firstDiagramId === undefined) throw new Error(`proyecto «${project.name}»: no hay ningún diagrama para acuñar el código de unión`);
    const joinCode = await apiJson<JoinCodeView>(base, host.token, `/projects/${project.id}/diagrams/${firstDiagramId}/join-codes`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    for (const participant of missing) {
      await apiJson<RedeemJoinCodeResponse>(base, participant.token, '/join-codes/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: joinCode.code }),
      });
    }
  }

  return { spec, project, created, diagrams, joinedNow: missing.map((p) => p.displayName), alreadyMembers };
}

// ─────────────────────────────────────────────────────────────────────────────
// T4 — verificación por diagrama: validación, export XMI, codegen
// ─────────────────────────────────────────────────────────────────────────────

interface VerificationResult {
  label: string;
  blockingCount: number;
  exportStatus: number;
  codegenStatus: number;
  codegenLabel: string;
  codegenFindings: readonly CodegenFinding[];
  passed: boolean;
}

async function verifyDiagram(base: string, hostToken: string, projectId: string, diagramId: string, label: string): Promise<VerificationResult> {
  const validation = await apiJson<ValidationReport>(base, hostToken, `/projects/${projectId}/diagrams/${diagramId}/validation`);
  const blockingCount = validation.findings.filter((finding) => isBlockingRule(finding.ruleId)).length;

  const exportRes = await apiRequest(base, hostToken, `/projects/${projectId}/diagrams/${diagramId}/export/xmi`, {
    method: 'POST',
    body: JSON.stringify({ version: '2.5.1', includeEaExtension: true }),
  });
  // Se consume el cuerpo siempre, ok o no, para no dejar la conexión colgada.
  if (exportRes.ok) await exportRes.json();
  else await exportRes.text();

  const codegenRes = await apiRequest(base, hostToken, `/projects/${projectId}/diagrams/${diagramId}/codegen`, { method: 'POST' });
  let codegenLabel: string;
  let codegenFindings: CodegenFinding[] = [];
  if (codegenRes.status === 200) {
    await codegenRes.json();
    codegenLabel = '200 OK';
  } else if (codegenRes.status === 422) {
    const body = (await codegenRes.json()) as CodegenBlockedBody;
    codegenFindings = body.findings;
    codegenLabel = `422 BLOQUEADO (${body.findings.length} hallazgo(s))`;
  } else {
    codegenLabel = `${codegenRes.status} FALLÓ — ${await codegenRes.text()}`;
  }

  const passed = blockingCount === 0 && exportRes.status === 200 && codegenRes.status === 200;
  return { label, blockingCount, exportStatus: exportRes.status, codegenStatus: codegenRes.status, codegenLabel, codegenFindings, passed };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI + orquestación
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): { base: string } {
  let base = 'http://localhost:3000';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--base necesita un valor, ej. --base http://localhost:3000');
      base = value;
      i += 1;
    }
  }
  return { base };
}

const rule = '─'.repeat(78);

function declareScope(base: string): void {
  console.log(rule);
  console.log('seed-demo-dataset — dataset de demostración idéntico en local y producción');
  console.log(rule);
  console.log(`destino: ${base}`);
  console.log('Habla SOLO con la API HTTP: mismo camino, misma validación, mismo hash de');
  console.log('contraseña en cualquier entorno. No escribe una fila directo a la base.');
  console.log('IDEMPOTENTE: 409 en registro → loguea; proyecto/diagrama existente → reusa.');
  console.log(rule);
}

async function main(): Promise<void> {
  const { base } = parseArgs(process.argv.slice(2));
  declareScope(base);

  console.log('\n[1/3] cuentas');
  const sessions: Session[] = [];
  for (const account of ACCOUNTS) {
    const session = await registerOrLogin(base, account);
    sessions.push(session);
    console.log(`  ${(session.created ? 'creada ' : 'reusada').padEnd(8)} ${account.displayName.padEnd(8)} ${account.email}`);
  }
  const host = sessions.find((session) => session.displayName === 'Ruben');
  if (host === undefined) throw new Error('la sesión de Ruben (host) no se resolvió — no puede continuar');
  const participants = sessions.filter((session) => session.displayName !== 'Ruben');

  console.log('\n[2/3] proyectos, diagramas y membresías');
  const outcomes: ProjectOutcome[] = [];
  for (const spec of PROJECT_SPECS) {
    const outcome = await processProject(base, host, participants, spec);
    outcomes.push(outcome);
    console.log(`  ${outcome.spec.name.padEnd(12)} ${outcome.created ? 'creado' : 'reusado'} · id=${outcome.project.id}`);
    for (const diagram of outcome.diagrams) {
      const detail = diagram.imported ? `importado (${diagram.elementCount ?? 0} elementos)` : 'ya existía, salteado';
      console.log(`    ${diagram.spec.name.padEnd(20)} ${detail}`);
    }
    if (outcome.joinedNow.length > 0) console.log(`    se sumaron ahora: ${outcome.joinedNow.join(', ')}`);
    if (outcome.alreadyMembers.length > 0) console.log(`    ya eran miembros: ${outcome.alreadyMembers.join(', ')}`);
  }

  console.log('\n[3/3] verificación por diagrama (T4)');
  const verifications: VerificationResult[] = [];
  for (const outcome of outcomes) {
    for (const diagram of outcome.diagrams) {
      const label = `${outcome.spec.name}/${diagram.spec.name}`;
      const verification = await verifyDiagram(base, host.token, outcome.project.id, diagram.diagramId, label);
      verifications.push(verification);
      console.log(
        `  ${verification.label}: validación ${verification.blockingCount} hallazgos bloqueantes · ` +
          `XMI ${verification.exportStatus === 200 ? '200 OK' : `${verification.exportStatus} FALLÓ`} · ` +
          `codegen ${verification.codegenLabel}`,
      );
      for (const finding of verification.codegenFindings) {
        if (finding.source === 'validation') console.log(`      · validation/${finding.ruleId}: ${finding.detail ?? '(sin detalle)'}`);
        else console.log(`      · codegen/${finding.code}: ${finding.detail ?? '(sin detalle)'}`);
      }
    }
  }

  console.log(`\n${rule}`);
  console.log('RESUMEN (T5)');
  console.log(rule);
  console.log('cuentas:');
  for (const session of sessions) console.log(`  ${session.displayName.padEnd(8)} ${session.email}  (${session.userId})`);
  console.log('\nproyectos y membresía:');
  for (const outcome of outcomes) {
    console.log(`  ${outcome.spec.name}: Ruben=HOST · ${participants.map((p) => p.displayName).join(', ')}=PARTICIPANT`);
  }
  console.log('\nverificación:');
  const passedCount = verifications.filter((v) => v.passed).length;
  console.log(`  ${passedCount}/${verifications.length} diagramas en verde (cero hallazgos bloqueantes, XMI 200, codegen 200)`);

  if (passedCount !== verifications.length) {
    console.log('\nHAY DIAGRAMAS QUE NO PASARON LA VERIFICACIÓN — ver el detalle arriba, nada se disimula.');
    process.exitCode = 1;
  } else {
    console.log('\nlisto. Los seis diagramas quedaron poblados, validados, exportables y generables.');
  }
}

main().catch((error: unknown) => {
  console.error(`\nseed-demo-dataset falló: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

/**
 * `roundtrip-check.ts` — oráculo de self-roundtrip (SC-E08) del import XMI
 * (tarea 4.8). **Script plano, corrido a mano. NO es un runner, NO es
 * `*.test.*`, NO es `*.spec.*`, y no está cableado a ningún pipeline.**
 *
 * ── Qué reemplaza y qué NO (FR-E21), y esto se imprime al arrancar ─────────
 * FR-E21 pide que el corpus de XMI se afirme **«in CI on every commit»**. Este
 * script reemplaza **únicamente la EJECUCIÓN** del corpus. La mitad «en CI en
 * cada commit» **NO SE CUMPLE y no puede cumplirse bajo las restricciones de
 * este proyecto**: no existe `.github/` en el repositorio y no puede existir un
 * runner de tests (prohibición de `*.test.*` / `*.spec.*`). No se maquilla:
 * se declara. El disparador es una persona escribiendo este comando.
 *
 * ── Qué prueba, exactamente ───────────────────────────────────────────────
 * Que el lector y el escritor son inversos **sobre el dialecto que nuestro
 * propio exportador emite**: modelo de referencia → export → import (modo
 * «diagrama nuevo») → export → **hash idéntico** (SC-E08).
 *
 * **No prueba nada sobre el dialecto de Enterprise Architect.** Las siete
 * trampas de E.5 existen porque EA escribe cosas que nosotros no; sin licencia
 * de EA 17 (FR-E22) este es el oráculo más fuerte disponible y su límite se
 * declara. Un export de StarUML ejercita conformidad OMG, pero no la extensión
 * de EA — que es donde vive la geometría.
 *
 * ── Por qué el hash ES un oráculo limpio ─────────────────────────────────
 * El parseo y el auto-layout son deterministas (D8/D9): las posiciones salen
 * del orden del documento, nunca de un contador ni del orden de un `Map`. Por
 * eso el segundo export puede compararse byte a byte con el primero.
 * **Si el hash difiere por poco, lo primero que hay que mirar es el
 * auto-layout**: como todo elemento tiene layout y el exportador emite
 * geometría para todos, en un roundtrip sano el auto-layout NUNCA se dispara;
 * si se dispara, el import inventó una posición y el segundo export ya no
 * coincide.
 *
 * ── Uso ──────────────────────────────────────────────────────────────────
 * ```
 * cd apps/api
 * npx tsx scripts/roundtrip-check.ts <projectId> <diagramId>
 * ```
 * (`ts-node --transpile-only` también sirve. `tsc` NO: el script vive fuera de
 * `rootDir` a propósito, porque no es parte del build del backend.)
 *
 * Variables de entorno:
 *   ROUNDTRIP_BASE_URL  default http://localhost:3000
 *   ROUNDTRIP_EMAIL / ROUNDTRIP_PASSWORD   credenciales de un HOST del proyecto
 *   DATABASE_URL        para los conteos de `PRIMITIVE_TYPE` (o `psql` no corre)
 *   PSQL                binario de psql, default `psql`
 *
 * Requiere: la API viva, la base migrada, y `psql` en el PATH.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface DiagramSummary {
  id: string;
  name: string;
}

interface ProjectDetail {
  id: string;
  role: string;
  diagrams: DiagramSummary[];
}

interface ExportResponse {
  fileName: string;
  document: string;
  report: { counts: { elements: number; relationships: number; syntheticPrimitiveTypes: number } };
}

interface PreviewResponse {
  contentDigest: string;
  detectedVersion: string;
  sourceEncoding: string;
  counts: { classifiers: number; relationships: number; features: number; withGeometry: number; totalPositionable: number };
  unsupported: unknown[];
  warnings: unknown[];
  target: { mode: 'new'; suggestedName: string } | { mode: 'existing'; diagramId: string };
}

interface ImportResult {
  importId: string;
  diagramId: string;
  elementCount: number;
}

const BASE_URL = process.env.ROUNDTRIP_BASE_URL ?? 'http://localhost:3000';
const API = `${BASE_URL}/api`;

function declareScope(): void {
  const rule = '─'.repeat(78);
  console.log(rule);
  console.log('roundtrip-check — oráculo de self-roundtrip del import XMI (SC-E08)');
  console.log(rule);
  console.log('FR-E21 · ESTE SCRIPT REEMPLAZA ÚNICAMENTE LA **EJECUCIÓN** DEL CORPUS.');
  console.log('FR-E21 · La mitad «in CI on every commit» NO SE CUMPLE: no hay .github/ y no');
  console.log('         puede haber runner bajo las restricciones de este proyecto. El');
  console.log('         disparador de esta verificación es una persona, no un commit.');
  console.log('ALCANCE · Prueba el ida y vuelta contra NUESTRO exportador. NO prueba nada');
  console.log('         sobre el dialecto de Enterprise Architect 17 (FR-E22): no hay');
  console.log('         licencia y no se declara verificado lo que no se puede correr.');
  console.log(rule);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function envOrFile(name: string): string | undefined {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  // `apps/api/.env` es donde vive `DATABASE_URL` para el proceso del backend.
  try {
    const contents = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match !== null && match[1] === name) return match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function login(): Promise<string> {
  const email = process.env.ROUNDTRIP_EMAIL;
  const password = process.env.ROUNDTRIP_PASSWORD;
  if (email === undefined || password === undefined) {
    throw new Error('faltan ROUNDTRIP_EMAIL / ROUNDTRIP_PASSWORD (credenciales de un HOST del proyecto)');
  }
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function exportDiagram(token: string, projectId: string, diagramId: string): Promise<ExportResponse> {
  return api<ExportResponse>(token, `/projects/${projectId}/diagrams/${diagramId}/export/xmi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: '2.5.1', includeEaExtension: true }),
  });
}

/** `count(*) FROM uml_elements WHERE kind='PRIMITIVE_TYPE'` — hallazgo 2 del diseño. */
function countPrimitiveTypes(diagramId: string): number | null {
  const databaseUrl = envOrFile('DATABASE_URL');
  if (databaseUrl === undefined) return null;
  const sql = `SELECT count(*) FROM uml_elements WHERE kind = 'PRIMITIVE_TYPE' AND diagram_id = '${diagramId}'`;
  const out = execFileSync(process.env.PSQL ?? 'psql', [databaseUrl, '-tAc', sql], { encoding: 'utf8' });
  return Number(out.trim());
}

async function main(): Promise<void> {
  declareScope();

  const projectId = process.argv[2];
  const sourceDiagramId = process.argv[3];
  if (projectId === undefined || sourceDiagramId === undefined) {
    console.error('\nuso: npx tsx scripts/roundtrip-check.ts <projectId> <diagramId>');
    process.exit(2);
  }

  const token = await login();
  const project = await api<ProjectDetail>(token, `/projects/${projectId}`);
  const source = project.diagrams.find((diagram) => diagram.id === sourceDiagramId);
  if (source === undefined) throw new Error(`el diagrama ${sourceDiagramId} no está entre los vivos del proyecto ${projectId}`);

  console.log(`\n[1/6] modelo de referencia: «${source.name}» (${source.id})`);

  const first = await exportDiagram(token, projectId, source.id);
  const firstDigest = sha256(first.document);
  console.log(`[2/6] export #1: ${first.document.length} bytes · sha256=${firstDigest}`);
  console.log(`       ${first.report.counts.elements} elementos · ${first.report.counts.relationships} relaciones`);

  const primitivesBefore = countPrimitiveTypes(source.id);

  // El archivo tiene que llegar como BYTES: es exactamente el camino de C5
  // (multipart, sin decodificar en el navegador — D3/D4).
  const upload = (): FormData => {
    const form = new FormData();
    form.append('file', new Blob([first.document], { type: 'text/xml' }), first.fileName);
    return form;
  };

  const preview = await api<PreviewResponse>(token, `/projects/${projectId}/import/xmi/preview`, {
    method: 'POST',
    body: upload(),
  });
  console.log(`[3/6] preview: XMI ${preview.detectedVersion} · ${preview.sourceEncoding} · digest=${preview.contentDigest}`);
  console.log(`       ${preview.counts.classifiers} clasificadores · ${preview.counts.relationships} relaciones · ${preview.counts.features} features`);
  console.log(`       geometría ${preview.counts.withGeometry}/${preview.counts.totalPositionable} · ${preview.unsupported.length} no soportados · ${preview.warnings.length} warnings`);
  if (preview.contentDigest !== firstDigest) {
    console.log('       ⚠ el digest del preview NO coincide con el sha256 local: el archivo cambió en el camino');
  }

  // Confirm en modo «diagrama nuevo» con el MISMO nombre del diagrama de
  // origen: el exportador emite un `uml:Package` por diagrama y su nombre es
  // parte del documento, así que un nombre distinto rompería el hash por una
  // razón que no tiene nada que ver con el ida y vuelta.
  const confirmForm = upload();
  confirmForm.append('contentDigest', preview.contentDigest);
  confirmForm.append('diagramName', source.name);
  const imported = await api<ImportResult>(token, `/projects/${projectId}/import/xmi/confirm`, {
    method: 'POST',
    body: confirmForm,
  });
  console.log(`[4/6] import confirmado: import=${imported.importId} · diagrama=${imported.diagramId} · ${imported.elementCount} elementos`);

  const second = await exportDiagram(token, projectId, imported.diagramId);
  const secondDigest = sha256(second.document);
  console.log(`[5/6] export #2: ${second.document.length} bytes · sha256=${secondDigest}`);

  const primitivesAfter = countPrimitiveTypes(imported.diagramId);

  console.log('[6/6] veredicto');
  const identical = firstDigest === secondDigest;
  console.log(`       SC-E08 · hash idéntico: ${identical ? 'SÍ' : 'NO'}`);
  if (!identical) {
    console.log('       mirar PRIMERO el auto-layout: un elemento sin geometría haría que el');
    console.log('       import invente una posición y el segundo export deje de coincidir (D8)');
  }
  console.log(
    `       hallazgo 2 · PRIMITIVE_TYPE: origen=${primitivesBefore ?? 'n/d'} importado=${primitivesAfter ?? 'n/d'} ${
      primitivesBefore !== null && primitivesAfter !== null ? `(esperado igual: ${primitivesBefore === primitivesAfter ? 'SÍ' : 'NO'})` : ''
    }`,
  );
  console.log(`       importId para auditoría: ${imported.importId} (una fila en xmi_imports)`);

  if (!identical) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\nroundtrip-check falló: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

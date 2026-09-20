/**
 * `mobile-fixture-backend.ts` — a **real generated Spring Boot backend**, emitted
 * so the Flutter app of `apps/mobile` can be verified against a genuine
 * `/v3/api-docs` document.
 *
 * **Plain script, run by hand. NOT a runner, NOT `*.test.*`, NOT `*.spec.*`, and
 * not wired to any pipeline.** Same precedent as `scripts/roundtrip-check.ts`.
 *
 * ── What it does, exactly ────────────────────────────────────────────────
 * `CodegenService.generate()` reads a `DiagramContent` out of PostgreSQL and then
 * calls three PURE functions: `buildIr(content, validationReport)`, `emitProject(ir)`
 * and `buildZip(artifactId, files)`. Standing up the whole UMLive product plus a
 * hand-drawn diagram is not needed to get a backend: this script builds the same
 * `DiagramContent` in code, drives those three functions directly and writes the
 * ZIP they already produce.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 * The REAL emitters. The controllers, DTOs, `application.yml`, `docker-compose.yml`,
 * Flyway migration and Maven wrapper in `tmp/mobile-fixture/backend/` are byte-for-byte
 * what a user gets from a diagram of this shape, because no emitter is bypassed.
 *
 * ── What it does NOT prove, and this is not hidden ───────────────────────
 * - **Not the database read path.** `DiagramContentService` (nine queries,
 *   `RepeatableRead` snapshot) and the Prisma round trip are not exercised: the
 *   content is constructed in memory.
 * - **Not the validation gate.** The report is hand-built as empty and
 *   non-blocking, so `ValidationService` never runs. A real generation that has
 *   blocking findings never reaches an emitter.
 * - **Not a runner.** There is no CI job, no assertion framework and no exit-code
 *   contract; the trigger is a person typing the command below. It is a fixture
 *   driver, not a test suite.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 * ```
 * cd apps/api
 * npx tsx scripts/mobile-fixture-backend.ts
 * ```
 * (`ts-node --transpile-only` also works. `tsc` does NOT: the script lives outside
 * `rootDir` on purpose, exactly like `roundtrip-check.ts`.)
 *
 * Requires: Node 22, and `@umlive/contracts` already built (`npm run build` in
 * `packages/contracts`). No API, no database and no Docker are needed to emit the
 * project; Docker is needed later, to run it.
 *
 * Writes `tmp/mobile-fixture/backend.zip` and unzips it into
 * `tmp/mobile-fixture/backend/`. Idempotent: every run deletes and rewrites both.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type {
  DiagramContent,
  DiagramSummary,
  ElementLayoutView,
  RelationshipKind,
  RelationshipLayoutView,
  UmlElementView,
  UmlEnumLiteralView,
  UmlFeatureView,
  UmlParameterView,
  UmlRelationshipEndView,
  UmlRelationshipView,
  ValidationReport,
} from '@umlive/contracts';
import { buildIr } from '../src/codegen/build-ir';
import { emitProject } from '../src/codegen/emitters/project';
import { buildZip, type GeneratedFile } from '../src/codegen/zip';

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/** `apps/api/scripts` → repository root. `tmp/` is git-ignored. */
const REPO_ROOT = join(__dirname, '..', '..', '..');
const OUTPUT_DIR = join(REPO_ROOT, 'tmp', 'mobile-fixture');
const ZIP_PATH = join(OUTPUT_DIR, 'backend.zip');
const BACKEND_DIR = join(OUTPUT_DIR, 'backend');

// ─────────────────────────────────────────────────────────────────────────────
// Fixture model — the demo's reference model in spirit
// ─────────────────────────────────────────────────────────────────────────────

const DIAGRAM_ID = '11111111-1111-4111-8111-111111111111';
/** The diagram name drives the generated `artifactId`: `Mobile Fixture` → `mobile-fixture`. */
const DIAGRAM_NAME = 'Mobile Fixture';
/** Fixed stamp: `buildIr` must not read the clock, and the ZIP hash must be stable. */
const STAMP = '2026-09-20T00:00:00.000Z';

/** One UML attribute. `lower >= 1` makes the column `NOT NULL`, which is what puts it in `required`. */
interface AttributeSpec {
  name: string;
  /** One of the 17 UML primitives; `type-mapping.ts` resolves it. */
  type: string;
  lower: number;
}

interface ClassSpec {
  name: string;
  attributes: AttributeSpec[];
}

/**
 * Nine classes. `Dirección` carries a non-ASCII letter on purpose: the route
 * pipeline (`java-names.ts`, `routeSegment`) is the only one that folds to ASCII,
 * so it emits `/api/direccion` and declares the change with a `route_ascii_folded`
 * note. That is what makes the app's accent-folded vocabulary matching testable.
 * The accented attribute `códigoPostal` exercises the identifier pipeline, which
 * keeps the accent (`código_postal`, `getCódigoPostal`).
 */
const CLASSES: ClassSpec[] = [
  {
    name: 'Cliente',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'nombre', type: 'String', lower: 1 },
      { name: 'email', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'Cita',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'fecha', type: 'LocalDate', lower: 1 },
      { name: 'motivo', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'Producto',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'nombre', type: 'String', lower: 1 },
      { name: 'precio', type: 'BigDecimal', lower: 1 },
      { name: 'stock', type: 'Integer', lower: 0 },
    ],
  },
  {
    name: 'Pedido',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'fecha', type: 'LocalDate', lower: 1 },
      { name: 'total', type: 'BigDecimal', lower: 0 },
    ],
  },
  {
    name: 'Dirección',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'calle', type: 'String', lower: 1 },
      { name: 'ciudad', type: 'String', lower: 1 },
      { name: 'códigoPostal', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'Empleado',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'nombre', type: 'String', lower: 1 },
      { name: 'cargo', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'Categoria',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'nombre', type: 'String', lower: 1 },
      { name: 'descripcion', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'Pago',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'monto', type: 'BigDecimal', lower: 1 },
      { name: 'metodo', type: 'String', lower: 0 },
    ],
  },
  {
    name: 'ItemPedido',
    attributes: [
      { name: 'id', type: 'Long', lower: 1 },
      { name: 'cantidad', type: 'Integer', lower: 1 },
      { name: 'precioUnitario', type: 'BigDecimal', lower: 0 },
    ],
  },
];

/** One end of an `ASSOCIATION`; `upper: null` is `*`. */
interface EndSpec {
  lower: number;
  upper: number | null;
  navigable: boolean;
}

interface AssociationSpec {
  id: string;
  source: string;
  target: string;
  /** End 0 falls on `source`, end 1 on `target` (the `endIndex` contract). */
  sourceEnd: EndSpec;
  targetEnd: EndSpec;
}

/**
 * Three associations. `Cliente 1 — * Cita` is the collection association: its FK
 * lives on `cita` and `Cliente` receives the `@OneToMany citaList`.
 */
const ASSOCIATIONS: AssociationSpec[] = [
  {
    id: 'rel-cita-cliente',
    source: 'Cliente',
    target: 'Cita',
    sourceEnd: { lower: 1, upper: 1, navigable: true },
    targetEnd: { lower: 0, upper: null, navigable: true },
  },
  {
    id: 'rel-pedido-empleado',
    source: 'Pedido',
    target: 'Empleado',
    sourceEnd: { lower: 0, upper: null, navigable: true },
    targetEnd: { lower: 0, upper: 1, navigable: true },
  },
  {
    id: 'rel-pago-pedido',
    source: 'Pago',
    target: 'Pedido',
    sourceEnd: { lower: 0, upper: null, navigable: true },
    targetEnd: { lower: 0, upper: 1, navigable: true },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Builders — the flat views `DiagramContentService` would have returned
// ─────────────────────────────────────────────────────────────────────────────

function classElement(id: string, name: string): UmlElementView {
  return {
    id,
    diagramId: DIAGRAM_ID,
    parentId: null,
    kind: 'CLASS',
    name,
    isAbstract: false,
    stereotype: null,
    body: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function attributeFeature(
  id: string,
  ownerId: string,
  attribute: AttributeSpec,
  position: number,
): UmlFeatureView {
  return {
    id,
    ownerId,
    kind: 'ATTRIBUTE',
    name: attribute.name,
    visibility: 'PRIVATE',
    typeElementId: null,
    typeName: attribute.type,
    lowerBound: attribute.lower,
    upperBound: 1,
    position,
    defaultValue: null,
    isStatic: false,
    isReadonly: false,
    isDerived: false,
    isAbstract: false,
    isQuery: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function buildContent(): DiagramContent {
  const diagram: DiagramSummary = {
    id: DIAGRAM_ID,
    name: DIAGRAM_NAME,
    lockState: 'UNLOCKED',
    currentVersion: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    freeze: null,
  };

  const elements: UmlElementView[] = [];
  const features: UmlFeatureView[] = [];
  const layouts: ElementLayoutView[] = [];
  const elementIdByName = new Map<string, string>();

  CLASSES.forEach((spec, classIndex) => {
    const elementId = `el-${classIndex + 1}`;
    elementIdByName.set(spec.name, elementId);
    elements.push(classElement(elementId, spec.name));
    // Geometry is mandatory in `DiagramContent` and irrelevant to the emitters;
    // a readable grid is enough.
    layouts.push({
      elementId,
      x: (classIndex % 4) * 260,
      y: Math.floor(classIndex / 4) * 200,
      width: 220,
      height: 150,
      zIndex: classIndex,
    });
    spec.attributes.forEach((attribute, attributeIndex) => {
      features.push(
        attributeFeature(`feat-${classIndex + 1}-${attributeIndex + 1}`, elementId, attribute, attributeIndex),
      );
    });
  });

  const relationships: UmlRelationshipView[] = [];
  const relationshipEnds: UmlRelationshipEndView[] = [];

  for (const spec of ASSOCIATIONS) {
    const sourceElementId = elementIdByName.get(spec.source);
    const targetElementId = elementIdByName.get(spec.target);
    if (sourceElementId === undefined || targetElementId === undefined) {
      throw new Error(`associación ${spec.id}: extremo no declarado en CLASSES`);
    }
    relationships.push({
      id: spec.id,
      diagramId: DIAGRAM_ID,
      kind: 'ASSOCIATION' as RelationshipKind,
      sourceElementId,
      targetElementId,
      name: null,
      stereotype: null,
      createdAt: STAMP,
      updatedAt: STAMP,
      // No association class in this fixture.
      associationClassId: null,
    });
    relationshipEnds.push(
      {
        id: `${spec.id}-source`,
        relationshipId: spec.id,
        endIndex: 0,
        elementId: sourceElementId,
        roleName: null,
        lowerBound: spec.sourceEnd.lower,
        upperBound: spec.sourceEnd.upper,
        isNavigable: spec.sourceEnd.navigable,
        aggregation: 'NONE',
      },
      {
        id: `${spec.id}-target`,
        relationshipId: spec.id,
        endIndex: 1,
        elementId: targetElementId,
        roleName: null,
        lowerBound: spec.targetEnd.lower,
        upperBound: spec.targetEnd.upper,
        isNavigable: spec.targetEnd.navigable,
        aggregation: 'NONE',
      },
    );
  }

  const relationshipLayouts: RelationshipLayoutView[] = [];
  // The remaining collections are required by the contract and unused here.
  const parameters: UmlParameterView[] = [];
  const enumLiterals: UmlEnumLiteralView[] = [];

  return {
    diagram,
    elements,
    features,
    parameters,
    enumLiterals,
    layouts,
    relationships,
    relationshipEnds,
    relationshipLayouts,
  };
}

/** Hand-built gate result: no findings, not blocking. See "what it does NOT prove". */
function buildValidationReport(): ValidationReport {
  return {
    diagramId: DIAGRAM_ID,
    generatedAt: STAMP,
    findings: [],
    blocking: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the emitted artifact back
// ─────────────────────────────────────────────────────────────────────────────

function findFile(files: readonly GeneratedFile[], suffix: string): GeneratedFile {
  const found = files.filter((file) => file.path.endsWith(suffix));
  if (found.length !== 1) {
    throw new Error(`se esperaba exactamente un archivo terminado en ${suffix}, hay ${found.length}`);
  }
  return found[0] as GeneratedFile;
}

/** One CRUD operation exactly as the emitted controller declares it. */
interface ControllerOperation {
  method: string;
  path: string;
}

/**
 * Parses the route and the five mappings out of the emitted controller SOURCE.
 * Reading the artifact instead of the IR is the point: this is the text a real
 * client would discover.
 */
function readControllerOperations(files: readonly GeneratedFile[], entityName: string): ControllerOperation[] {
  const file = findFile(files, `/controller/${entityName}Controller.java`);
  const base = /@RequestMapping\("([^"]+)"\)/.exec(file.content);
  if (base === null) throw new Error(`${entityName}Controller: no se encontró @RequestMapping`);
  const basePath = base[1] as string;

  const operations: ControllerOperation[] = [];
  const mapping = /@(Get|Post|Put|Delete)Mapping(?:\("([^"]*)"\))?/g;
  let match: RegExpExecArray | null;
  while ((match = mapping.exec(file.content)) !== null) {
    const verb = (match[1] as string).toUpperCase();
    operations.push({ method: verb === 'GET' ? 'GET' : verb, path: `${basePath}${match[2] ?? ''}` });
  }
  if (operations.length !== 5) {
    throw new Error(`${entityName}Controller: se esperaban 5 mapeos CRUD, hay ${operations.length}`);
  }
  return operations;
}

/** The request `record` components, annotations included, so required/optional is visible. */
function readRecordColumns(files: readonly GeneratedFile[], recordName: string): string[] {
  const file = findFile(files, `/dto/${recordName}.java`);
  const match = new RegExp(`public record ${recordName}\\(([\\s\\S]*?)\\) \\{`).exec(file.content);
  if (match === null) throw new Error(`${recordName}: no se encontró la declaración del record`);
  return (match[1] as string)
    .split(',')
    .map((component) => component.trim())
    .filter((component) => component !== '');
}

/** Recursive size and file count of the unzipped project. */
function directoryStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryStats(child);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += statSync(child).size;
    }
  }
  return { files, bytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

const zebra = (n: number): string => n.toLocaleString('en-US');

function main(): void {
  const rule = '─'.repeat(78);
  console.log(rule);
  console.log('mobile-fixture-backend — hand-run fixture driver (NOT a runner, NOT a test)');
  console.log(rule);
  console.log('Builds a DiagramContent in memory and drives the real codegen functions:');
  console.log('  buildIr(content, validationReport) → emitProject(ir) → buildZip(...)');
  console.log('PROVES     the real emitters (controllers, DTOs, pom, yml, Flyway, wrapper).');
  console.log('DOES NOT   the database read path (DiagramContentService + Prisma) nor the');
  console.log('           validation gate: the report is hand-built empty and non-blocking.');
  console.log(rule);

  // ── Build, emit, zip ─────────────────────────────────────────────────────
  const content = buildContent();
  const report = buildValidationReport();
  const ir = buildIr(content, report);

  if (ir.blockers.length > 0) {
    console.error(`\nla generación BLOQUEÓ con ${ir.blockers.length} hallazgo(s):`);
    for (const finding of ir.blockers) console.error(`  ${finding.code}: ${finding.detail ?? ''}`);
    process.exit(1);
  }

  const files = emitProject(ir);
  const zip = buildZip(ir.artifactId, files);

  // ── Idempotent write ─────────────────────────────────────────────────────
  rmSync(BACKEND_DIR, { recursive: true, force: true });
  rmSync(ZIP_PATH, { force: true });
  mkdirSync(BACKEND_DIR, { recursive: true });
  writeFileSync(ZIP_PATH, zip.bytes);

  const entries = unzipSync(zip.bytes);
  const prefix = `${ir.artifactId}/`;
  let extracted = 0;
  for (const [entryPath, bytes] of Object.entries(entries)) {
    if (!entryPath.startsWith(prefix)) throw new Error(`entrada de ZIP fuera de ${prefix}: ${entryPath}`);
    const relativePath = entryPath.slice(prefix.length);
    if (relativePath === '') continue;
    const destination = join(BACKEND_DIR, relativePath);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, Buffer.from(bytes));
    extracted += 1;
  }
  const stats = directoryStats(BACKEND_DIR);

  console.log(`\nartefacto        ${ir.artifactId}  («${ir.diagramName}»)`);
  console.log(`entidades        ${ir.entities.length} · enumeraciones ${ir.enums.length} · archivos ${files.length}`);
  console.log(`ZIP              ${ZIP_PATH}`);
  console.log(`                 ${zebra(zip.bytes.length)} bytes · sha256 ${zip.sha256}`);
  console.log(`proyecto         ${BACKEND_DIR}`);
  console.log(`                 ${zebra(extracted)} archivos extraídos · ${zebra(stats.bytes)} bytes en disco`);

  // ── Operation inventory, read back from the emitted controllers ──────────
  console.log(`\n${rule}`);
  console.log('OPERATION INVENTORY (parsed from the emitted controllers)');
  console.log(rule);
  let total = 0;
  for (const entity of ir.entities) {
    const operations = readControllerOperations(files, entity.name);
    console.log(`\n${entity.name}  →  ${operations[0]?.path ?? `/api/${entity.route}`}`);
    for (const operation of operations) {
      console.log(`  ${operation.method.padEnd(6)} ${operation.path}`);
      total += 1;
    }
  }
  console.log(`\nTOTAL OPERATIONS: ${total}  (${ir.entities.length} entidades × 5 verbos CRUD)`);

  // ── ClienteRequest components: the mandatory/optional split, before running ─
  console.log(`\n${rule}`);
  console.log('ClienteRequest record components  (POST /api/cliente request body)');
  console.log(rule);
  for (const column of readRecordColumns(files, 'ClienteRequest')) {
    const required = column.startsWith('@');
    console.log(`  ${required ? 'MANDATORY' : 'optional '}  ${column}`);
  }

  // ── Declared losses (notes), so nothing is silently dropped ──────────────
  console.log(`\n${rule}`);
  console.log(`GENERATION NOTES: ${ir.notes.length} (declared losses, none blocking)`);
  console.log(rule);
  for (const note of ir.notes) console.log(`  ${note.code.padEnd(28)} ${note.detail ?? ''}`);

  console.log(`\nlisto. El proyecto emitido está en ${BACKEND_DIR}`);
}

main();

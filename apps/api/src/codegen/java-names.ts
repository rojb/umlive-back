/**
 * Nombres del generador (D3, D4). Funciones puras, sin dependencias.
 *
 * ── Dos tuberías, no una (corrección 2026-09-17, FR-D20b) ────────────────────
 *
 * La versión original de D3 plegaba TODO nombre a ASCII antes de derivar
 * cualquier identificador. Eso viola `PRD.md:322` (un identificador que viene
 * del dominio en español se preserva verbatim, tildes incluidas) y
 * `SPECS.md` SC-D10. La corrección parte la tubería en dos:
 *
 * - **Identificador (Java/SQL)**: normaliza a NFC → parte por límites de
 *   palabra (letra o dígito Unicode, que es lo que acepta Java) → `PascalCase`
 *   (tipos), `camelCase` (miembros), `snake_case` (SQL), `UPPER_SNAKE`
 *   (literales de enum). **Nunca pliega a ASCII**: `Dirección` sigue siendo
 *   `Dirección`, y su columna, `dirección`.
 * - **Ruta**: NFD → quita marcas (`\p{M}`) → la misma partición → `kebab-case`.
 *   Es la ÚNICA que pliega a ASCII, y ese pliegue nunca es silencioso: el
 *   llamador recibe `asciiFolded` y lo declara con la nota
 *   `route_ascii_folded` (D3, D6).
 *
 * ── Por qué el separador es «ni letra ni dígito» ────────────────────────────
 *
 * Un nombre compuesto solo por signos de puntuación o emojis no deja ninguna
 * palabra: es el bloqueo `name_unrepresentable`. Un ideograma CJK **sí** es
 * letra (`\p{L}`), así que no vacía el nombre — el ejemplo anterior de D3
 * sobre CJK ya no aplica.
 *
 * ── Unicidad y límite de PostgreSQL ─────────────────────────────────────────
 *
 * La unicidad se compara sobre la forma **NFC en minúsculas** (`collisionKey`),
 * por espacio de nombres: `Order` y `order` son el mismo tipo Java, y en
 * Windows `Order.java` y `order.java` se pisan al descomprimir. El límite de
 * 63 bytes de un identificador SQL sin comillas se mide en **bytes UTF-8**
 * (`Buffer.byteLength`), nunca con `.length`: una letra acentuada ocupa dos
 * bytes. Si un nombre SQL lo supera, se recorta en un límite de punto de
 * código (nunca partiendo un carácter) y se marca `escaped`/`truncated`.
 *
 * Los nombres que **esta** rebanada compone (columna FK, tabla intermedia,
 * restricciones) pasan por `sqlIdent` (D8), que agrega además el sufijo
 * `_<sha256:8>`: ver más abajo.
 */

import { createHash } from 'node:crypto';

/** Espacios de nombres de D3. La unicidad se evalúa dentro de cada uno. */
export type NameSpace =
  | 'types'
  | 'members'
  | 'tables'
  | 'columns'
  | 'routes'
  | 'enumLiterals'
  /** Nuevo en la rebanada 4 (D8): restricciones e índices del esquema (`pk_*`, `fk_*`, `uk_*`), que PostgreSQL exige únicos por esquema. */
  | 'constraints';

/** Forma final de un nombre derivado de uno del modelo. */
export interface ResolvedName {
  /** Forma final. NFC siempre, salvo las rutas, que salen plegadas a ASCII. */
  name: string;
  /** Se aplicó un escape por sufijo fijo o un recorte por el límite SQL. */
  escaped: boolean;
  /** Solo rutas: el pliegue ASCII cambió el nombre (nota `route_ascii_folded`). */
  asciiFolded: boolean;
  /** La partición no dejó ninguna letra ni ningún dígito (bloqueo `name_unrepresentable`). */
  unrepresentable: boolean;
  /** Solo SQL: se recortó por el límite de 63 bytes UTF-8 de PostgreSQL. */
  truncated: boolean;
}

/** Tipos derivados que cada entidad aporta al espacio de tipos (D3). */
export const DERIVED_TYPE_SUFFIXES = [
  'Repository',
  'Service',
  'ServiceImpl',
  'Controller',
  'Request',
  'Response',
  'Mapper',
] as const;

/** Clase de arranque del proyecto emitido: también ocupa el espacio de tipos. */
export const APPLICATION_TYPE_NAME = 'Application';

/** Prefijos cuando un nombre arranca con dígito (D3). */
const DIGIT_PREFIX = {
  type: 'N',
  member: 'n',
  snake: 'n_',
  upperSnake: 'N_',
  route: 'n-',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Partición en palabras
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Letra o dígito Unicode — el conjunto que Java acepta dentro de un
 * identificador después de normalizar (`Character.isLetterOrDigit`, que cubre
 * `LETTER_NUMBER` y `DECIMAL_DIGIT_NUMBER` además de las letras).
 */
const WORD_CHAR = /[\p{L}\p{Nl}\p{Nd}]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const COMBINING_MARKS = /\p{M}/gu;

/** Pega a NFC y elimina las marcas diacríticas (SOLO tubería de rutas). */
function foldAscii(raw: string): string {
  return raw.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
}

/**
 * Parte un nombre en palabras. Dos límites: un carácter que no sea letra ni
 * dígito, y el paso minúscula→mayúscula (`códigoPostal` → `código` + `Postal`).
 * No toca las mayúsculas intermedias, por eso `ClienteVIP` no se parte en
 * `Cliente` + `V` + `IP`.
 */
function split(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let previous = '';
  for (const ch of input) {
    if (!WORD_CHAR.test(ch)) {
      if (current !== '') words.push(current);
      current = '';
      previous = '';
      continue;
    }
    if (current !== '' && LOWER.test(previous) && UPPER.test(ch)) {
      words.push(current);
      current = '';
    }
    current += ch;
    previous = ch;
  }
  if (current !== '') words.push(current);
  return words;
}

/** Palabras de un identificador Java/SQL (NFC, sin plegar a ASCII). */
export function splitWords(raw: string): string[] {
  return split(raw.normalize('NFC'));
}

/** Palabras de una ruta: mismas reglas, pero sobre el nombre plegado a ASCII. */
export function splitWordsAscii(raw: string): string[] {
  return split(foldAscii(raw));
}

/** `cliente` → `Cliente`, `1abc` → `1Abc` (sube la primera LETRA, no el primer carácter). */
function capitalize(word: string): string {
  const chars = [...word];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (/\p{L}/u.test(ch)) {
      chars[i] = ch.toUpperCase();
      return chars.join('');
    }
  }
  return word;
}

const startsWithDigit = (name: string): boolean => /^[\p{Nd}]/u.test(name);

function applyDigitPrefix(name: string, prefix: string): { name: string; prefixed: boolean } {
  return startsWithDigit(name) ? { name: prefix + name, prefixed: true } : { name, prefixed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversores de estilo (funciones puras, sin escapado ni prefijo)
// ─────────────────────────────────────────────────────────────────────────────

export function pascalCase(raw: string): string {
  return splitWords(raw).map(capitalize).join('');
}

export function camelCase(raw: string): string {
  const words = splitWords(raw);
  if (words.length === 0) return '';
  const [first, ...rest] = words as [string, ...string[]];
  return first.toLowerCase() + rest.map(capitalize).join('');
}

export function snakeCase(raw: string): string {
  return splitWords(raw).map((w) => w.toLowerCase()).join('_');
}

export function upperSnakeCase(raw: string): string {
  return splitWords(raw).map((w) => w.toUpperCase()).join('_');
}

/** `kebab-case` de una ruta: la única forma plegada a ASCII (D3). */
export function kebabCase(raw: string): string {
  return splitWordsAscii(raw).map((w) => w.toLowerCase()).join('-');
}

/** kebab-case de la tubería de identificador, sin plegar. Se usa para saber si el pliegue cambió algo. */
function kebabCaseUnfolded(raw: string): string {
  return splitWords(raw).map((w) => w.toLowerCase()).join('-');
}

// ─────────────────────────────────────────────────────────────────────────────
// Listas de reservadas (D3)
// ─────────────────────────────────────────────────────────────────────────────

/** Palabras clave, literales y context keywords de Java. */
const JAVA_KEYWORDS = [
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'var', 'yield', 'record', 'sealed',
  'permits', 'true', 'false', 'null',
];

/**
 * Nombres simples de `java.lang` que el código emitido usa, más **todo nombre
 * simple que importa un archivo generado** (D3): una clase UML llamada `Entity`
 * choca con `import jakarta.persistence.Entity`, y `String`/`Object` sombrean
 * `java.lang`.
 */
const JAVA_RESERVED_SIMPLE_NAMES = [
  // java.lang (sombreado)
  'String', 'Object', 'Class', 'Integer', 'Long', 'Double', 'Boolean', 'Enum', 'Record', 'Override',
  'Byte', 'Short', 'Float', 'Character', 'Void', 'Number', 'Math', 'System', 'Thread', 'Exception',
  'RuntimeException', 'Error', 'Throwable', 'Iterable', 'Comparable', 'CharSequence', 'StringBuilder',
  'Deprecated', 'SuppressWarnings', 'SafeVarargs', 'FunctionalInterface',
  // jakarta.persistence / jakarta.transaction
  'Entity', 'Table', 'Id', 'Column', 'GeneratedValue', 'GenerationType', 'Enumerated', 'EnumType',
  'EntityManager', 'PersistenceContext', 'Transactional',
  // jakarta.persistence — agregadas por la rebanada 4 (D8): las importa el
  // código emitido de relaciones, herencia y `@MappedSuperclass`, así que un
  // nombre del modelo no puede sombrearlas.
  'ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany', 'JoinColumn', 'JoinTable', 'FetchType',
  'CascadeType', 'Inheritance', 'InheritanceType', 'PrimaryKeyJoinColumn', 'MappedSuperclass',
  // spring (web, context, stereotype, http)
  'RestController', 'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping',
  'RequestBody', 'PathVariable', 'RequestParam', 'Service', 'Repository', 'Component', 'Configuration',
  'Bean', 'Value', 'Autowired', 'HttpStatus', 'ResponseEntity', 'ResponseStatus', 'ResponseStatusException',
  'SpringApplication', 'SpringBootApplication',
  // spring — agregadas por la rebanada 4 (D6, D8): el advice generado importa
  // `ProblemDetail` y el nombre reservado `ApiExceptionHandler`.
  'ProblemDetail', 'ApiExceptionHandler',
  // spring-web — agregada por la guarda de secreto compartido (FR-MF03): el
  // archivo fijo `config/SharedSecretFilter.java` ocupa ese nombre en el
  // espacio de tipos, igual que `ApiExceptionHandler`.
  'SharedSecretFilter',
  // spring-data / colecciones / tipos
  'JpaRepository', 'List', 'Optional', 'UUID', 'BigDecimal', 'LocalDate', 'LocalDateTime', 'Set', 'Map',
  'ArrayList', 'HashMap', 'Stream', 'Collectors',
  // Rebanada 4 (D5): el mapper ordena los ids de una colección `UUID` con
  // `Comparator.comparing(UUID::toString)`, así que `Comparator` también entra.
  'Comparator',
  // lombok (FR-F13 cortado, pero un nombre generado no debe chocar si un día se agrega)
  'Data', 'Getter', 'Setter', 'Builder', 'NoArgsConstructor', 'AllArgsConstructor', 'RequiredArgsConstructor',
];

/**
 * Componentes de `record` prohibidos (JLS §8.10.1) más los métodos de `Object`:
 * los DTO emitidos son `record`, así que un atributo llamado `toString` no
 * compila (D3, contradicción 7).
 */
const RECORD_FORBIDDEN_COMPONENTS = [
  'clone', 'finalize', 'getClass', 'hashCode', 'notify', 'notifyAll', 'toString', 'wait',
];

/**
 * Palabras reservadas de PostgreSQL 17 relevantes para un identificador sin
 * comillas, más `flyway_schema_history`: la tabla de Flyway vive en el mismo
 * esquema, así que una entidad llamada `FlywaySchemaHistory` choca con ella.
 */
const POSTGRES_RESERVED = [
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization',
  'binary', 'both', 'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date', 'current_role', 'current_schema',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do',
  'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full', 'grant', 'group',
  'having', 'ilike', 'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lateral',
  'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural', 'not', 'notnull', 'null',
  'offset', 'on', 'only', 'or', 'order', 'outer', 'overlaps', 'placing', 'primary', 'references',
  'returning', 'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'table', 'tablesample',
  'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
  'where', 'window', 'with',
  'flyway_schema_history',
];

/**
 * Palabras clave de JPQL/HQL que rompen al **arrancar** (no al compilar) cuando
 * son el nombre de la entidad JPA: Spring Data las usa en las consultas
 * derivadas (D3). El escape es el sufijo `Entity` en `@Entity(name = …)`.
 */
const HQL_RESERVED = [
  'all', 'and', 'any', 'as', 'asc', 'avg', 'between', 'by', 'case', 'cast', 'count', 'current_date',
  'current_time', 'current_timestamp', 'delete', 'desc', 'distinct', 'else', 'end', 'entry', 'escape',
  'except', 'exists', 'fetch', 'from', 'full', 'group', 'having', 'in', 'index', 'inner', 'insert',
  'intersect', 'into', 'is', 'join', 'key', 'left', 'like', 'max', 'member', 'min', 'new', 'not', 'null',
  'of', 'on', 'or', 'order', 'outer', 'right', 'select', 'set', 'size', 'some', 'sum', 'then', 'treat',
  'type', 'union', 'update', 'value', 'values', 'when', 'where', 'with',
];

const lower = (list: readonly string[]): ReadonlySet<string> =>
  new Set(list.map((s) => s.toLowerCase()));

/** Nombres simples prohibidos para un tipo Java generado. */
export const RESERVED_JAVA_TYPES: ReadonlySet<string> = lower([
  ...JAVA_KEYWORDS,
  ...JAVA_RESERVED_SIMPLE_NAMES,
]);

/** Nombres prohibidos para un miembro Java (incluye los componentes de `record`). */
export const RESERVED_JAVA_MEMBERS: ReadonlySet<string> = lower([
  ...JAVA_KEYWORDS,
  ...RECORD_FORBIDDEN_COMPONENTS,
]);

/** Identificadores SQL reservados en PostgreSQL 17, más `flyway_schema_history`. */
export const RESERVED_SQL: ReadonlySet<string> = lower(POSTGRES_RESERVED);

/** Palabras clave de JPQL/HQL prohibidas como nombre de entidad JPA. */
export const RESERVED_HQL: ReadonlySet<string> = lower(HQL_RESERVED);

/**
 * Firmas de los métodos de `Object` que un método generado no puede pisar
 * (D5): la clave de firma de una operación comparte espacio con ellas.
 */
export const OBJECT_METHOD_SIGNATURES: ReadonlySet<string> = new Set([
  'getClass()',
  'hashCode()',
  'equals(Object)',
  'toString()',
  'clone()',
  'finalize()',
  'notify()',
  'notifyAll()',
  'wait()',
  'wait(Long)',
  'wait(Long,Integer)',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Límite de PostgreSQL: 63 bytes UTF-8, no 63 caracteres
// ─────────────────────────────────────────────────────────────────────────────

/** Longitud de un identificador SQL sin comillas, en BYTES UTF-8 (D3). */
export function sqlByteLength(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

/** Límite de PostgreSQL 17 para un identificador sin comillas. */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

/**
 * Recorta a ≤63 bytes UTF-8 sin partir un carácter. Es la única forma de que el
 * nombre SQL siga siendo válido sin comillas; el llamador lo reporta porque
 * altera el nombre del usuario.
 */
function truncateSqlName(name: string): { name: string; truncated: boolean } {
  if (sqlByteLength(name) <= POSTGRES_IDENTIFIER_MAX_BYTES) return { name, truncated: false };
  let out = '';
  let bytes = 0;
  for (const ch of name) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > POSTGRES_IDENTIFIER_MAX_BYTES) break;
    out += ch;
    bytes += size;
  }
  return { name: out, truncated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// `sqlIdent` — el acortado determinista de esta rebanada (D8)
// ─────────────────────────────────────────────────────────────────────────────

/** Bytes que puede ocupar el prefijo cuando hace falta el sufijo `_<hash>`: 63 − 1 − 8. */
const SQL_IDENT_PREFIX_MAX_BYTES = POSTGRES_IDENTIFIER_MAX_BYTES - 9;

/**
 * Acorta un identificador SQL a ≤63 **bytes UTF-8** con sufijo `_<sha256:8>`
 * (D8). Es lo que aplica esta rebanada a los nombres que compone —columna FK,
 * tabla intermedia, columnas de esa tabla y restricciones—, porque un rol de
 * 40 caracteres con acentos ya pasa el límite: `í` ocupa dos bytes.
 *
 * Dos propiedades que el código anterior no tenía:
 *
 * - **Corta por punto de código**, nunca por índice de caracteres ni de bytes:
 *   una secuencia UTF-8 partida da un identificador que PostgreSQL trunca
 *   distinto de como lo escribió JPA.
 * - **El sufijo hash hace deterministas dos nombres distintos** que comparten
 *   el prefijo: sin él, dos roles largos con el mismo arranque colisionarían
 *   en el espacio de restricciones del esquema.
 */
export function sqlIdent(full: string): string {
  if (sqlByteLength(full) <= POSTGRES_IDENTIFIER_MAX_BYTES) return full;
  const hash = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 8);
  let prefix = '';
  let bytes = 0;
  for (const ch of full) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > SQL_IDENT_PREFIX_MAX_BYTES) break;
    prefix += ch;
    bytes += size;
  }
  return `${prefix}_${hash}`;
}

/**
 * `true` si `sqlIdent` recorta: el llamador lo declara con la nota
 * `name_shortened`. Se deriva de la ENTRADA para no tener que devolver dos
 * valores desde la función del diseño.
 */
export function isSqlIdentifierShortened(full: string): boolean {
  return sqlByteLength(full) > POSTGRES_IDENTIFIER_MAX_BYTES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tuberías completas: partición → estilo → prefijo → escape → recorte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tubería de identificador: NFC, sin plegar a ASCII (D3). `sqlLimit` solo
 * activa el recorte por el límite de 63 bytes; NUNCA cambia la partición.
 * `asciiFolded` queda en `false`: el único que lo enciende es `routeSegment`.
 */
function resolve(
  raw: string,
  join: (words: string[]) => string,
  prefix: string,
  reserved: ReadonlySet<string>,
  suffix: string,
  sqlLimit: boolean,
): ResolvedName {
  const words = splitWords(raw);
  if (words.length === 0) {
    return { name: '', escaped: false, asciiFolded: false, unrepresentable: true, truncated: false };
  }

  let name = join(words);
  const prefixed = applyDigitPrefix(name, prefix);
  name = prefixed.name;

  let escaped = prefixed.prefixed;
  if (reserved.has(name.normalize('NFC').toLowerCase())) {
    name += suffix;
    escaped = true;
  }

  let truncated = false;
  if (sqlLimit) {
    const cut = truncateSqlName(name);
    name = cut.name;
    truncated = cut.truncated;
    escaped = escaped || truncated;
  }

  return { name, escaped, asciiFolded: false, unrepresentable: false, truncated };
}

/** Nombre de un tipo Java (clase, interfaz generada, enum). Escape: sufijo `Model`. */
export function typeName(raw: string): ResolvedName {
  return resolve(raw, (w) => w.map(capitalize).join(''), DIGIT_PREFIX.type, RESERVED_JAVA_TYPES, 'Model', false);
}

/** Nombre de un miembro Java (campo, accesor). Escape: sufijo `Value`. */
export function memberName(raw: string): ResolvedName {
  return resolve(raw, (w) => {
    const [first, ...rest] = w as [string, ...string[]];
    return first.toLowerCase() + rest.map(capitalize).join('');
  }, DIGIT_PREFIX.member, RESERVED_JAVA_MEMBERS, 'Value', false);
}

/** Nombre de tabla SQL. Escape: sufijo `_`. Aplica el límite de 63 bytes. */
export function tableName(raw: string): ResolvedName {
  return resolve(raw, (w) => w.map((x) => x.toLowerCase()).join('_'), DIGIT_PREFIX.snake, RESERVED_SQL, '_', true);
}

/** Nombre de columna SQL. Escape: sufijo `_`. Aplica el límite de 63 bytes. */
export function columnName(raw: string): ResolvedName {
  return resolve(raw, (w) => w.map((x) => x.toLowerCase()).join('_'), DIGIT_PREFIX.snake, RESERVED_SQL, '_', true);
}

/** Literal de un enum Java (`UPPER_SNAKE`). Escape: sufijo `Value`. */
export function enumLiteralName(raw: string): ResolvedName {
  return resolve(raw, (w) => w.map((x) => x.toUpperCase()).join('_'), DIGIT_PREFIX.upperSnake, RESERVED_JAVA_MEMBERS, 'Value', false);
}

/**
 * Nombre de `@Entity(name = …)` (HQL). Es un nombre propio: el tipo Java puede
 * ser `Order` y la entidad JPA `OrderEntity`. Escape: sufijo `Entity`.
 */
export function hqlEntityName(raw: string): ResolvedName {
  return resolve(raw, (w) => w.map(capitalize).join(''), DIGIT_PREFIX.type, RESERVED_HQL, 'Entity', false);
}

/**
 * Segmento de ruta (`kebab-case`). Es la única tubería que pliega a ASCII, y
 * lo declara: `asciiFolded` es lo que el llamador reporta como
 * `route_ascii_folded`. Prefijo `n-` si arranca con dígito.
 */
export function routeSegment(raw: string): ResolvedName {
  const words = splitWordsAscii(raw);
  // El pliegue «cambió algo» si el resultado difiere del que habría dado la
  // tubería sin plegar: es lo que se declara con `route_ascii_folded`.
  const asciiFolded = kebabCase(raw) !== kebabCaseUnfolded(raw);

  if (words.length === 0) {
    return { name: '', escaped: false, asciiFolded, unrepresentable: true, truncated: false };
  }
  let name = words.map((w) => w.toLowerCase()).join('-');
  const prefixed = applyDigitPrefix(name, DIGIT_PREFIX.route);
  name = prefixed.name;
  return { name, escaped: prefixed.prefixed, asciiFolded, unrepresentable: false, truncated: false };
}

/** Clave de unicidad de un espacio de nombres: NFC en minúsculas (D3). */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

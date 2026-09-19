/**
 * Emisor de la `interface` Java de una interfaz UML (tarea 4.3, D2).
 *
 * Un `INTERFACE` del modelo con operaciones mapeables se emite como una
 * `interface` Java en `entity/`, junto a las clases. Sus firmas son las mismas
 * que `build-ir` resolvió para los stubs de las clases que la realizan, así que
 * acá no hay nada que ramificar por tipo: la IR ya trae el nombre, el retorno y
 * los parámetros de cada método.
 *
 * `extends` múltiple de otras interfaces (generalización entre interfaces) es
 * legal en Java, así que no cuesta nada.
 *
 * Función pura `(irInterface) => string`: sin reloj, sin azar, sin `os.EOL`.
 */

import { BASE_PACKAGE } from '../build-ir';
import type { IrInterface, IrOperation } from '../codegen-ir';
import type { GeneratedFile } from '../zip';

/** Raíz del código fuente emitido. Misma ancla que `entity.ts`. */
const JAVA_SOURCE_ROOT = `src/main/java/${BASE_PACKAGE.replace(/\./g, '/')}`;

/** Las interfaces viven con las entidades (D11). */
const ENTITY_PACKAGE = `${BASE_PACKAGE}.entity`;

const INDENT = '    ';

/** Orden estable e independiente del locale, nunca `localeCompare` (D7). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Bloque de `import`, sin duplicados y sin las clases del propio paquete. */
function renderImports(imports: readonly string[], ownPackage: string): string {
  const own = `${ownPackage}.`;
  const unique = [...new Set(imports.filter((name) => !name.startsWith(own)))];
  unique.sort(compareText);
  return unique.map((name) => `import ${name};`).join('\n');
}

/** Una firma de método: se emite sin cuerpo, como exige una interfaz Java. */
function signatureLine(operation: IrOperation): string {
  const parameters = operation.parameters.map((p) => `${p.type.java} ${p.name}`).join(', ');
  return `${INDENT}${operation.returns} ${operation.name}(${parameters});`;
}

/** El texto completo de `entity/X.java` para una interfaz (D2). */
export function emitInterface(irInterface: IrInterface): string {
  const ext = irInterface.extends.length === 0 ? '' : ` extends ${irInterface.extends.join(', ')}`;
  const methods = irInterface.methods.map(signatureLine).join('\n\n');
  const body = [`public interface ${irInterface.name}${ext} {`, '', methods, '}'].join('\n');
  const imports = renderImports(
    irInterface.methods.flatMap((method) => method.imports),
    ENTITY_PACKAGE,
  );
  const head = [`package ${ENTITY_PACKAGE};`, ''];
  if (imports !== '') head.push(imports, '');
  return `${[...head, body].join('\n')}\n`;
}

/** `entity/X.java` de la interfaz, con su ruta en el ZIP (D11). */
export function emitInterfaceFile(irInterface: IrInterface): GeneratedFile {
  return { path: `${JAVA_SOURCE_ROOT}/entity/${irInterface.name}.java`, content: emitInterface(irInterface) };
}

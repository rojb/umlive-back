/**
 * Emisores de las piezas que no cuelgan de una entidad (tarea 2.4, D11):
 * la enumeración Java y el stub de operación que el contrato SC-F07 exige.
 *
 * Igual que `entity.ts`, son funciones puras `(irX) => string`: leen la IR y
 * nada más.
 */

import { BASE_PACKAGE } from '../build-ir';
import type { IrEnum, IrOperation } from '../codegen-ir';
import type { GeneratedFile } from '../zip';

/** Raíz del código fuente emitido. Misma ancla que `entity.ts`. */
const JAVA_SOURCE_ROOT = `src/main/java/${BASE_PACKAGE.replace(/\./g, '/')}`;

/** Las enumeraciones viven con las entidades (D11). */
const ENTITY_PACKAGE = `${BASE_PACKAGE}.entity`;

const INDENT = '    ';

/**
 * `enum` Java con todos sus literales (SC-F07). El atributo que lo usa lleva
 * `@Enumerated(EnumType.STRING)` y columna `varchar(255)`; ambas cosas las
 * decide `build-ir` y las emite `entity.ts` a partir de `field.enumerated`, así
 * que acá no hay nada que ramificar.
 */
export function emitEnum(irEnum: IrEnum): string {
  const literals = irEnum.literals.map((literal) => `${INDENT}${literal.name}`).join(',\n');
  return `package ${ENTITY_PACKAGE};\n\npublic enum ${irEnum.name} {\n${literals}${literals === '' ? '' : '\n'}}\n`;
}

/** `entity/X.java` con el `enum` (D11). */
export function emitEnumFile(irEnum: IrEnum): GeneratedFile {
  return { path: `${JAVA_SOURCE_ROOT}/entity/${irEnum.name}.java`, content: emitEnum(irEnum) };
}

/**
 * Stub de una operación UML (contradicción 2 de la propuesta; el escenario de
 * «operación con un parámetro de tipo no emitido» cubre el caso en que la
 * operación NO llega acá).
 *
 * `entity.ts` usa esta misma forma para las operaciones de la entidad; vive acá
 * porque el contrato de la tarea 2.4 lo pide como pieza propia de la capa y
 * porque el mensaje —el único texto libre del stub— se escribe una sola vez.
 */
export function emitOperationStub(operation: IrOperation): string {
  const parameters = operation.parameters.map((p) => `${p.type.java} ${p.name}`).join(', ');
  return [
    `${INDENT}/** Operación UML \`${operation.name}\`: stub hasta que se implemente (contradicción 2 de la propuesta). */`,
    `${INDENT}public ${operation.returns} ${operation.name}(${parameters}) {`,
    `${INDENT}${INDENT}throw new UnsupportedOperationException("${operation.name} no esta implementada");`,
    `${INDENT}}`,
  ].join('\n');
}

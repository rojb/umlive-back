/**
 * Emisores de las piezas que no cuelgan de una entidad (tarea 2.4, D11):
 * la enumeración Java, el stub de operación que el contrato SC-F07 exige y el
 * **cuerpo de los `record` DTO** (D5, rebanada 4).
 *
 * Igual que `entity.ts`, son funciones puras `(irX) => string`: leen la IR y
 * nada más.
 */

import { BASE_PACKAGE } from '../build-ir';
import type { IrDtoField, IrEnum, IrOperation } from '../codegen-ir';
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
 * Anotación de Bean Validation del componente obligatorio (D5, FR-F11). `String`
 * va con `@NotBlank` —`@NotNull` sola deja pasar `""`—; una colección
 * obligatoria (`List<…>`) va con `@NotEmpty`; cualquier otro tipo, `@NotNull`.
 * Solo lo consulta `renderRecord` cuando `options.validate` está prendido, así
 * que nunca decide nada del modelo (D2): lee `field.type` y `field.required`,
 * los dos ya resueltos en la IR.
 */
function requiredAnnotation(field: IrDtoField): '@NotBlank' | '@NotEmpty' | '@NotNull' {
  if (field.type === 'String') return '@NotBlank';
  if (field.type.startsWith('List<')) return '@NotEmpty';
  return '@NotNull';
}

/** `import` de Bean Validation que exige cada anotación de `requiredAnnotation`. */
const REQUIRED_ANNOTATION_IMPORTS: Record<'@NotBlank' | '@NotEmpty' | '@NotNull', string> = {
  '@NotBlank': 'jakarta.validation.constraints.NotBlank',
  '@NotEmpty': 'jakarta.validation.constraints.NotEmpty',
  '@NotNull': 'jakarta.validation.constraints.NotNull',
};

/**
 * Importaciones de Bean Validation que exige un `record` de petición (D5,
 * FR-F11): una por anotación realmente usada entre los componentes
 * obligatorios, para que `entity.ts` las sume a las de `field.imports` sin
 * hard-codearlas en el renderer. Con ningún componente obligatorio, la lista
 * sale vacía.
 */
export function requiredDtoImports(fields: readonly IrDtoField[]): string[] {
  const used = new Set(fields.filter((field) => field.required).map(requiredAnnotation));
  return [...used].map((annotation) => REQUIRED_ANNOTATION_IMPORTS[annotation]);
}

/**
 * Cuerpo de un `record` DTO (D5). Los componentes llegan ya resueltos y
 * ordenados desde `entity.dtoFields`: la PK primero, después los atributos y al
 * final los componentes de relación (`clienteId`, `cursoIds`). Acá no se decide
 * qué lleva el `record`, solo cómo se escribe.
 *
 * El nombre del `record` lo pasa `entity.ts`, que es quien conoce los tipos
 * derivados de la entidad (D3): este módulo no reconstruye nombres.
 *
 * `options.validate` solo lo prende `emitRequestDto` (D5, FR-F11): el `record`
 * de respuesta nunca lleva Bean Validation, porque nadie lo valida al salir.
 */
export function renderRecord(
  recordName: string,
  fields: readonly IrDtoField[],
  options: { validate?: boolean } = {},
): string {
  const validate = options.validate ?? false;
  const components = fields
    .map((field) => {
      const annotation = validate && field.required ? `${requiredAnnotation(field)} ` : '';
      return `${INDENT}${INDENT}${annotation}${field.type} ${field.name}`;
    })
    .join(',\n');
  return `public record ${recordName}(\n${components}) {\n}`;
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

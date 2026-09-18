/**
 * La IR del generador. **Solo tipos, cero lógica de negocio** (D2).
 *
 * Todas las decisiones —nombres, tipos, PK, qué se emite, qué se reporta— se
 * toman en `build-ir.ts`. Los emisores reciben únicamente esta estructura y se
 * limitan a traducirla a texto: puede ramificar sobre un flag de acá
 * (`field.enumerated`), nunca sobre datos del modelo (`kind`, `typeName`,
 * `stereotype`), que sencillamente no llegan a su alcance.
 *
 * Por eso el prompt de la rebanada 4 (`codegen-relationships`) puede agregar
 * campos de relación sin reescribir ningún emisor.
 */

import type { CodegenFinding, CodegenNote } from '@umlive/contracts';

/**
 * Tipo ya resuelto. Los mismos `java`/`sql` los usa el JPA y el `V1__init.sql`
 * (D4): si un emisor y la migración leyeran de fuentes distintas, `validate`
 * fallaría al arrancar con un modelo que compiló bien.
 */
export interface IrTypeRef {
  /** Tipo Java, con envoltorio (`Integer`, no `int`). */
  java: string;
  /** Tipo SQL tal como aparece en `V1__init.sql`. */
  sql: string;
  /** Importaciones Java que exige el tipo, ya ordenadas y sin duplicados. */
  imports: string[];
  /** Valor de ejemplo para el cuerpo de Postman. */
  example: string | number | boolean;
}

/** Un atributo ya resuelto a campo JPA, columna SQL y getter/setter. */
export interface IrField {
  /** `UmlFeature.id` del atributo. Es el enlace al lienzo del reporte. */
  elementId: string;
  /** Miembro Java (`camelCase`, NFC: `códigoPostal`). */
  name: string;
  /** Accesor generado (`getCódigoPostal`). Se calcula acá porque la clave de firma lo necesita (D5). */
  getter: string;
  /** Mutador generado (`setCódigoPostal`). */
  setter: string;
  /** Columna SQL (`snake_case`, NFC: `código_postal`). */
  column: string;
  type: IrTypeRef;
  /** `true` si es una enumeración modelada: `@Enumerated(EnumType.STRING)`, columna `varchar(255)`. */
  enumerated: boolean;
  /** `true` si el campo lleva `@Column(nullable = false)` y la columna `NOT NULL` (`lowerBound >= 1`). */
  nullable: boolean;
  /** `true` si es la clave primaria (declarada o inyectada). */
  isId: boolean;
  /** Estrategia de generación de la PK; `null` si el campo no es la PK. */
  generation: 'IDENTITY' | 'UUID' | null;
}

/** Parámetro ya mapeado de una operación. Los `RETURN` no llegan acá (son el retorno). */
export interface IrParameter {
  /** `UmlParameter.name`, saneado a `camelCase`. */
  name: string;
  type: IrTypeRef;
}

/**
 * Operación UML ya resuelta a un stub Java.
 *
 * `signature` es la clave de colisión de D5: nombre más tipos Java de los
 * parámetros **después de mapear**, sin el retorno. Por eso `foo(int)` y
 * `foo(Integer)` comparten firma y bloquean la generación.
 */
export interface IrOperation {
  /** `UmlFeature.id` de la operación. */
  elementId: string;
  /** Nombre del método (`camelCase`). */
  name: string;
  /** `nombre(Tipo1,Tipo2)` — sin espacios, para comparar como clave. */
  signature: string;
  parameters: IrParameter[];
  /** Tipo Java de retorno, o `void`. */
  returns: string;
  /** Importaciones que exigen retorno y parámetros, ordenadas. */
  imports: string[];
}

/** Un clasificador emitible, ya resuelto. */
export interface IrEntity {
  /** `UmlElement.id` de la clase. */
  elementId: string;
  /** Nombre de la clase Java (PascalCase, NFC): también es el nombre de archivo. */
  name: string;
  /** Nombre de la entidad JPA/HQL (`@Entity(name = …)`); puede diferir de `name` por escape. */
  hqlName: string;
  /** Tabla SQL (`snake_case`, NFC). */
  table: string;
  /** Segmento de ruta del controlador, sin `/` (`kebab-case`, plegado a ASCII). */
  route: string;
  fields: IrField[];
  operations: IrOperation[];
  /**
   * Tipos derivados que la entidad aporta al espacio de tipos (D3, D11):
   * `XRepository`, `XService`, `XServiceImpl`, `XController`, `XRequest`,
   * `XResponse`, `XMapper`. Viven acá y no en el emisor porque la detección de
   * colisiones y la emisión MUST leer la misma lista.
   */
  derivedTypeNames: string[];
  /** Unión ordenada y sin duplicados de las importaciones de campos y operaciones, más las de JPA. */
  imports: string[];
  /** `true` si la PK no venía del modelo y se inyectó `Long id` (`pk_injected`). */
  idInjected: boolean;
}

/** Un literal de enumeración ya resuelto. */
export interface IrEnumLiteral {
  /** `UmlEnumLiteral.id`. */
  elementId: string;
  /** Literal Java (`UPPER_SNAKE`). */
  name: string;
}

/** Una enumeración modelada: un `enum` Java emitido en `entity/`. */
export interface IrEnum {
  /** `UmlElement.id` de la enumeración. */
  elementId: string;
  /** Nombre del tipo Java (PascalCase, NFC). */
  name: string;
  literals: IrEnumLiteral[];
}

/**
 * Resultado completo de `buildIr`. Los `blockers` no son solo del generador:
 * traen también los hallazgos bloqueantes de `ValidationService`, en el orden
 * de D6 (primero validación, después generador). Con `blockers` no vacío no se
 * emite ningún byte de ZIP.
 */
export interface CodegenIr {
  /** `artifactId` Maven del proyecto emitido, derivado del nombre del diagrama (D11). */
  artifactId: string;
  /**
   * Id del diagrama. Es el `_postman_id` de la colección (D11): derivado del
   * diagrama y NO aleatorio, porque un UUID al azar rompería SC-F11.
   */
  diagramId: string;
  /**
   * Nombre del diagrama, tal como lo escribió el usuario. Es el único texto
   * libre que llega al proyecto emitido: el título del `README.md` (D11).
   * Cierra el desvío declarado en la corrida de la Fase 2, cuando la IR todavía
   * no lo llevaba y el README titulaba con el `artifactId`.
   */
  diagramName: string;
  entities: IrEntity[];
  enums: IrEnum[];
  blockers: CodegenFinding[];
  notes: CodegenNote[];
}

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
  /**
   * `true` si el campo lo hereda de un ancestro emitido (D2): la clase NO lo
   * redeclara ni lo mapea (`entity.ts` lo salta) y su tabla solo lo materializa
   * cuando corresponde (la PK de una hija `JOINED`, o todos los atributos si el
   * ancestro es un `@MappedSuperclass`). El DTO y el mapper sí lo ven, porque el
   * descendiente hereda el accesor.
   */
  inherited: boolean;
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
   * Nombre Java de la superclase (`extends`), o `null` si la clase es raíz.
   * Lo llena la pasada de herencia (Fase 4, D2).
   */
  superclass: string | null;
  /**
   * `true` si la clase es la raíz de su jerarquía y tiene al menos una hija
   * emitida: lleva `@Inheritance(strategy = InheritanceType.JOINED)` (D2).
   */
  inheritanceRoot: boolean;
  /** `true` si la clase UML es abstracta. Con hijas emitidas sigue teniendo repositorio (D5), pero no controller ni DTO. */
  isAbstract: boolean;
  /** `true` si el estereotipo la convirtió en `@MappedSuperclass`: sin `@Entity` y sin tabla propia (D2). */
  mappedSuperclass: boolean;
  /**
   * `true` si la superclase emitida es un `@MappedSuperclass` (D2): sus
   * atributos y su PK bajan a la tabla de esta clase —«que pasa a ser raíz»—,
   * y la clase NO lleva `@PrimaryKeyJoinColumn` porque no hay tabla padre.
   */
  parentMappedSuperclass: boolean;
  /** Interfaces Java que la clase declara con `implements`, ordenadas con `<` (D2). */
  implementsInterfaces: string[];
  /**
   * Campos de relación **propios** de esta clase (D1): los que las otras
   * entidades reciben apuntando a ella viven en su propia `relations`, no acá.
   * Ordenados por el orden de `content.relationships`.
   */
  relations: IrRelationField[];
  /**
   * Componentes de los `record` DTO, ya aplanados (ancestros primero, después
   * los propios): un `record` no hereda componentes (D1). Los emisores de
   * `dto/` leen esta lista y no vuelven a caminar la jerarquía.
   */
  dtoFields: IrDtoField[];
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

/**
 * Un campo de relación ya resuelto (D1, D3). El emisor **solo traduce**: dueño,
 * `mappedBy`, nulabilidad, cascada y nombres vienen decididos de acá, y el
 * tipo JPA sale del `kind` que esta rebanada ya resolvió.
 */
export interface IrRelationField {
  /** Nombre del miembro Java (`cliente`, `cursoList`). */
  name: string;
  /** Nombre Java de la clase del otro extremo. */
  target: string;
  /** Anotación JPA resultante. */
  kind: 'ManyToOne' | 'OneToOne' | 'OneToMany' | 'ManyToMany';
  /** `true` si el campo es el lado dueño de la FK. */
  owning: boolean;
  /** Nombre del campo dueño, para el `mappedBy` del lado inverso; `null` en el dueño. */
  mappedBy: string | null;
  /** Cascada del lado TODO (D4). En esta fase sin agregación siempre es `NONE`. */
  cascade: 'NONE' | 'PERSIST_MERGE' | 'ALL';
  /** `true` solo con composición (`cascade = ALL, orphanRemoval = true`). */
  orphanRemoval: boolean;
  /** `@JoinColumn` del lado dueño de una referencia simple; `null` en colecciones e inversos. */
  joinColumn: { name: string; nullable: boolean; unique: boolean } | null;
  /** `@JoinTable` del dueño de una asociación `* — *`; `null` en el resto. */
  joinTable: IrJoinTable | null;
  /** Componente correspondiente en los `record` DTO (D5): `cursoIds`, no `cursoList`. */
  dto: { name: string; inRequest: boolean; required: boolean; idType: string };
  /**
   * `true` si el campo lo hereda de un ancestro emitido (D2): el descendiente
   * lo lee y lo escribe por el accesor heredado, pero no vuelve a mapear la FK.
   */
  inherited: boolean;
}

/** Tabla intermedia de una asociación `* — *` (D3, D8, D9). */
export interface IrJoinTable {
  /** Nombre de la tabla intermedia. */
  name: string;
  /** Columna que referencia a la tabla del lado dueño. */
  ownerColumn: string;
  /** Columna que referencia a la tabla del otro extremo. */
  targetColumn: string;
}

/**
 * Componente de un `record` DTO (D1, D5). Es la lista aplanada que leen los
 * emisores de `dto/`; en esta fase no hay herencia, así que coincide con los
 * campos propios más los componentes de relación.
 */
export interface IrDtoField {
  /** Nombre del componente (`id`, `códigoPostal`, `clienteId`, `cursoIds`). */
  name: string;
  /** Tipo Java tal como se escribe en el `record` (`String`, `Long`, `List<Long>`). */
  type: string;
  /** Importaciones que exige el tipo, ordenadas y sin duplicados. */
  imports: string[];
  /** `true` si el componente viaja en `XRequest`; `false` para la PK y las referencias inversas. */
  inRequest: boolean;
}

/**
 * Interfaz UML ya resuelta a `interface` Java (D2). La llena la Fase 4; el tipo
 * vive acá porque `CodegenIr` la lleva desde la unidad 1.
 */
export interface IrInterface {
  /** `UmlElement.id` de la interfaz. */
  elementId: string;
  /** Nombre del tipo Java (PascalCase, NFC). */
  name: string;
  /** Interfaces que extiende, ordenadas con `<`. */
  extends: string[];
  methods: IrOperation[];
}

/** Clave foránea del `V1__init.sql` (D9), agregada al final y ordenada por `name`. */
export interface IrForeignKey {
  /** Nombre de la restricción (`fk_pedido_cliente_id`). */
  name: string;
  /** Tabla que lleva la columna. */
  table: string;
  columns: string[];
  /** Tabla referenciada. */
  refTable: string;
  /** Columnas referenciadas (la PK de `refTable`). */
  refColumns: string[];
  /** `true` solo en las FK de una tabla intermedia: `ON DELETE CASCADE` (D9). */
  onDeleteCascade: boolean;
}

/** Restricción `UNIQUE` en línea del `V1__init.sql` (D9). */
export interface IrUnique {
  /** Nombre de la restricción (`uk_cliente_pasaporte_id`). */
  name: string;
  table: string;
  columns: string[];
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
  /**
   * Interfaces UML emitidas como `interface` Java (D2). La llena la Fase 4; en
   * esta fase queda vacía porque `INTERFACE` sigue clasificándose como omitido.
   */
  interfaces: IrInterface[];
  /** Tablas intermedias de las asociaciones `* — *`, en orden de la IR. */
  joinTables: IrJoinTable[];
  /** Claves foráneas del bloque 3 de `V1__init.sql`, ordenadas por `name` (D9). */
  foreignKeys: IrForeignKey[];
  /** Restricciones `UNIQUE` en línea de `V1__init.sql` (D9). */
  uniques: IrUnique[];
  /**
   * Clausura de referencias obligatorias por entidad concreta, en orden
   * topológico (D9). La llena la Fase 5; en esta fase queda vacía.
   */
  fixturePlan: Record<string, string[]>;
  blockers: CodegenFinding[];
  notes: CodegenNote[];
}

/**
 * El andamiaje del proyecto emitido (tarea 2.5, D8 y D11).
 *
 * Los tres archivos que la Fase 0 verificó en el golden y que este emisor tiene
 * que reproducir **carácter por carácter** son el `pom.xml`, el
 * `application.yml` y el `docker-compose.yml`: si alguno de los tres se aparta,
 * `mvnw -q verify` o el arranque contra PostgreSQL 17 dejan de estar probados.
 * Por eso los tres se escriben con la forma del golden y no «mejorados».
 *
 * Dos puntos de D8 que no son cosméticos:
 *
 * - **`spring-boot-starter-webmvc`**, nunca el `spring-boot-starter-web`
 *   deprecado: el pom de `web` 4.1.0 dice literalmente «deprecated in favor of
 *   spring-boot-starter-webmvc», y lo ve cualquiera que abra el ZIP.
 * - **`project.build.sourceEncoding` y `project.reporting.outputEncoding` en
 *   UTF-8**: los identificadores Java conservan las letras acentuadas (D3,
 *   corrección FR-D20b), y el codepage por defecto de Windows no es UTF-8, así
 *   que sin estas dos propiedades una clase `Dirección` con `códigoPostal`
 *   compila mal o con mojibake según la máquina.
 *
 * **Sin `src/test` y sin `spring-boot-starter-test`** (requisito «El proyecto
 * generado no incluye pruebas automatizadas»): el único test razonable
 * (`contextLoads`) necesita la base levantada y haría fallar `mvnw -q verify` en
 * una máquina sin Docker, justo lo que SC-F02 prohíbe. La suite del proyecto
 * generado es la colección Postman.
 *
 * **La `V1__init.sql` se emite en `flyway.ts`** (tarea 3.1) y los dos archivos de
 * Postman en `postman.ts` (tarea 3.2); este módulo los agrega al mismo arreglo
 * de archivos. Hasta la corrida de la Fase 2 el ZIP traía las entidades JPA con
 * `ddl-auto=validate` y ninguna migración: `mvnw -q verify` pasaba, pero el
 * arranque contra PostgreSQL 17 habría fallado en `validate`.
 */

import { BASE_PACKAGE } from '../build-ir';
import { APPLICATION_TYPE_NAME } from '../java-names';
import type { CodegenIr, IrEntity } from '../codegen-ir';
import type { GeneratedFile } from '../zip';
import { JAVA_SOURCE_ROOT, emitEntityFiles } from './entity';
import { emitErrorAdviceFile } from './error-advice';
import { emitFlywayFile } from './flyway';
import { emitInterfaceFile } from './interface';
import { emitEnumFile } from './layers';
import { emitPostmanFiles } from './postman';
import { emitWrapperFiles } from './wrapper';

/** Spring Boot fijo: 4.1.0 es la BOM que el golden verificó (D8, Fase 0). */
const SPRING_BOOT_VERSION = '4.1.0';

/** Versión de Java objetivo; el JDK de la máquina es más nuevo y compila igual (Fase 0). */
const JAVA_VERSION = '21';

/** Puerto de host de PostgreSQL: 5432 está ocupado acá y 5434 lo usa UMLive (D8). */
const DATABASE_PORT = 15432;

/** Puerto HTTP del proyecto emitido (D8). */
const SERVER_PORT = 8080;

/**
 * `pom.xml` (D8). Las dependencias son exactamente las de la tabla del diseño:
 * `webmvc`, `data-jpa`, `flyway`, `flyway-database-postgresql` (el starter de
 * Flyway 4.1.0 NO trae el módulo de PostgreSQL — hallazgo 4) y `postgresql` en
 * alcance `runtime`. Todas con versión gestionada por la BOM.
 */
function emitPom(artifactId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
\txsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
\t<modelVersion>4.0.0</modelVersion>
\t<parent>
\t\t<groupId>org.springframework.boot</groupId>
\t\t<artifactId>spring-boot-starter-parent</artifactId>
\t\t<version>${SPRING_BOOT_VERSION}</version>
\t\t<relativePath/> <!-- lookup parent from repository -->
\t</parent>
\t<groupId>com.umlive</groupId>
\t<artifactId>${artifactId}</artifactId>
\t<version>0.0.1-SNAPSHOT</version>
\t<name>${artifactId}</name>
\t<description>Proyecto generado por UMLive</description>
\t<properties>
\t\t<java.version>${JAVA_VERSION}</java.version>
\t\t<project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
\t\t<project.reporting.outputEncoding>UTF-8</project.reporting.outputEncoding>
\t</properties>
\t<dependencies>
\t\t<dependency>
\t\t\t<groupId>org.springframework.boot</groupId>
\t\t\t<artifactId>spring-boot-starter-data-jpa</artifactId>
\t\t</dependency>
\t\t<dependency>
\t\t\t<groupId>org.springframework.boot</groupId>
\t\t\t<artifactId>spring-boot-starter-flyway</artifactId>
\t\t</dependency>
\t\t<dependency>
\t\t\t<groupId>org.springframework.boot</groupId>
\t\t\t<artifactId>spring-boot-starter-webmvc</artifactId>
\t\t</dependency>
\t\t<dependency>
\t\t\t<groupId>org.flywaydb</groupId>
\t\t\t<artifactId>flyway-database-postgresql</artifactId>
\t\t</dependency>
\t\t<dependency>
\t\t\t<groupId>org.postgresql</groupId>
\t\t\t<artifactId>postgresql</artifactId>
\t\t\t<scope>runtime</scope>
\t\t</dependency>
\t</dependencies>
\t<build>
\t\t<plugins>
\t\t\t<plugin>
\t\t\t\t<groupId>org.springframework.boot</groupId>
\t\t\t\t<artifactId>spring-boot-maven-plugin</artifactId>
\t\t\t</plugin>
\t\t</plugins>
\t</build>
</project>
`;
}

/** Clase de arranque. El nombre es el mismo que protege `build-ir` en el espacio de tipos. */
function emitApplication(): string {
  return `package ${BASE_PACKAGE};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class ${APPLICATION_TYPE_NAME} {

    public static void main(String[] args) {
        SpringApplication.run(${APPLICATION_TYPE_NAME}.class, args);
    }

}
`;
}

/** Datasource, `validate`, `open-in-view: false` y puerto HTTP (D8). Texto del golden. */
function emitApplicationYml(): string {
  return `spring:
  datasource:
    url: jdbc:postgresql://localhost:${DATABASE_PORT}/app
    username: app
    password: app
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
  flyway:
    enabled: true

server:
  port: ${SERVER_PORT}
`;
}

/**
 * `docker-compose.yml` de un comando (FR-F14, SC-F12). Es el del golden, que es
 * la única forma que la Fase 0 verificó: `postgres:17`, puerto de host 15432 y
 * **sin `container_name`**, para que dos proyectos generados no choquen entre
 * sí (D8).
 */
function emitDockerCompose(): string {
  return `services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "${DATABASE_PORT}:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10
`;
}

/** `.gitignore` del golden, para que el `.mvn/wrapper/maven-wrapper.jar` no se versione. */
function emitGitignore(): string {
  return `HELP.md
target/
.mvn/wrapper/maven-wrapper.jar
!**/src/main/**/target/
!**/src/test/**/target/

### STS ###
.apt_generated
.classpath
.factorypath
.project
.settings
.springBeans
.sts4-cache

### IntelliJ IDEA ###
.idea
*.iws
*.iml
*.ipr

### NetBeans ###
/nbproject/private/
/nbbuild/
/dist/
/nbdist/
/.nb-gradle/
build/
!**/src/main/**/build/
!**/src/test/**/build/

### VS Code ###
.vscode/
`;
}

/**
 * `.gitattributes` (D9): protege los finales de línea del wrapper si el
 * proyecto se versiona con `autocrlf` encendido. No alcanza al ZIP —ahí la
 * conversión la hace el emisor— pero sí al repo del estudiante.
 */
function emitGitattributes(): string {
  return `/mvnw text eol=lf
*.cmd text eol=crlf
`;
}

/** Fila de ejemplo por entidad: las cinco rutas CRUD tal como las expone el controlador. */
function endpointRows(entities: readonly IrEntity[]): string {
  if (entities.length === 0) {
    return 'El diagrama no tenía clasificadores emitibles, así que este esqueleto no expone ninguna ruta.';
  }
  const rows = entities.map((entity) =>
    `| \`${entity.name}\` | \`GET /api/${entity.route}\` | \`GET /api/${entity.route}/{id}\` | \`POST /api/${entity.route}\` | \`PUT /api/${entity.route}/{id}\` | \`DELETE /api/${entity.route}/{id}\` |`,
  );
  return [
    '| Entidad | Lista | Por id | Alta | Edición | Baja |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** `README.md`: cómo arrancar el proyecto y qué límites tiene lo generado (D11). */
function emitReadme(ir: CodegenIr): string {
  // El título es el nombre del diagrama: es el único texto libre del usuario
  // que D11 deja llegar al proyecto emitido. Si el diagrama no tuviera nombre,
  // se cae al `artifactId` para no emitir un título vacío.
  const title = ir.diagramName.trim() === '' ? ir.artifactId : ir.diagramName;
  return `# ${title}

Proyecto Spring Boot ${SPRING_BOOT_VERSION} generado por UMLive a partir del diagrama «${title}» (artefacto \`${ir.artifactId}\`).

## Cómo arrancarlo

\`\`\`bash
docker compose up -d          # PostgreSQL 17 en el puerto ${DATABASE_PORT}
./mvnw -q verify              # Linux/macOS; en Windows: mvnw.cmd -q verify
./mvnw spring-boot:run        # http://localhost:${SERVER_PORT}
\`\`\`

El wrapper usa Maven 3.9.14; no hace falta tener Maven instalado.

## Endpoints

${endpointRows(ir.entities)}

## Límites declarados

- \`ddl-auto: validate\`: el esquema lo aplica Flyway y Hibernate solo lo valida.
- Sin Bean Validation: un \`POST\` al que le falte un campo obligatorio responde
  \`400\`, no \`500\`. Lo produce el \`ApiExceptionHandler\` al hacer \`flush\`:
  Hibernate detecta el nulo antes de tocar la base (\`PropertyValueException\`) y,
  si la columna llega igual a PostgreSQL, el \`SQLState 23502\` también se traduce
  a \`400\`. El golden de la Fase 0 (0.10) midió los dos caminos.
- Las referencias se exponen por id (\`clienteId\`, \`cursoIds\`): ningún DTO contiene
  una entidad, así que no hay ciclos en el JSON ni \`@JsonIgnore\`. Un id que no
  existe responde \`400\`, y borrar un registro referenciado, \`409\`.
- La herencia se emite con \`@Inheritance(strategy = JOINED)\`: la PK vive en la
  clase más alta y cada hija la comparte por FK (\`@PrimaryKeyJoinColumn\`). Una
  clase abstracta con hijas genera entidad y repositorio, sin controller,
  servicio, DTO ni carpeta Postman.
- Un estereotipo \`mappedsuperclass\` se emite como \`@MappedSuperclass\`, sin tabla
  propia; sus atributos y su PK bajan a la tabla de cada hija.
- Un \`INTERFACE\` se emite como \`interface\` Java y una \`INTERFACE_REALIZATION\`
  como \`implements\`, con un stub por cada método no implementado.
- La agregación decide la cascada del lado TODO: \`SHARED\` → \`{PERSIST, MERGE}\`;
  \`COMPOSITE\` → \`ALL\` más \`orphanRemoval\`, sobre el \`mappedBy\` del TODO. Una
  agregación marcada en los dos extremos bloquea con \`ambiguous_aggregation\`.
- Antes del CRUD, cada carpeta de la colección Postman crea las referencias
  obligatorias (los fixtures), las usa por id y las borra al final en orden
  inverso. Un ciclo de referencias obligatorias bloquea la generación.
- Las relaciones \`DEPENDENCY\` y \`USAGE\` no producen código: quedan listadas como
  \`relationship_not_emitted\` en el reporte de generación.
- Las operaciones UML se emiten como métodos que lanzan
  \`UnsupportedOperationException\`: la firma está, el cuerpo todavía no.
- El proyecto no trae tests: la suite ejecutable es la colección Postman que
  UMLive genera junto con este ZIP.
`;
}

/**
 * Todos los archivos del proyecto: andamiaje, la migración Flyway, los dos de
 * Postman, las ocho piezas por entidad, los `enum` y los tres archivos del
 * wrapper.
 *
 * La migración `V1__init.sql` (tarea 3.1) cierra el hueco que la corrida de la
 * Fase 2 declaró: sin ella el ZIP traía entidades con `ddl-auto=validate` y
 * ninguna tabla, así que el proyecto arrancaba en verde solo mientras nadie lo
 * levantara contra PostgreSQL 17. La colección Postman (tarea 3.2) es la suite
 * ejecutable del proyecto generado, que no trae tests.
 *
 * El `ApiExceptionHandler` (tarea 2.6) entra siempre: mapea errores por
 * `SQLState` y no depende del modelo.
 */
export function emitProject(ir: CodegenIr): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: 'pom.xml', content: emitPom(ir.artifactId) },
    { path: `${JAVA_SOURCE_ROOT}/${APPLICATION_TYPE_NAME}.java`, content: emitApplication() },
    { path: 'src/main/resources/application.yml', content: emitApplicationYml() },
    { path: 'docker-compose.yml', content: emitDockerCompose() },
    { path: 'README.md', content: emitReadme(ir) },
    { path: '.gitignore', content: emitGitignore() },
    { path: '.gitattributes', content: emitGitattributes() },
  ];

  files.push(emitFlywayFile(ir));
  files.push(emitErrorAdviceFile());
  files.push(...emitPostmanFiles(ir));
  for (const irEnum of ir.enums) files.push(emitEnumFile(irEnum));
  for (const irInterface of ir.interfaces) files.push(emitInterfaceFile(irInterface));
  for (const entity of ir.entities) files.push(...emitEntityFiles(entity));

  files.push(...emitWrapperFiles());
  return files;
}

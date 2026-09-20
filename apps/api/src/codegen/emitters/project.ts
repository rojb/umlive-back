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
import { emitSharedSecretFilterFile, SHARED_TOKEN_PROPERTY } from './shared-secret-filter';
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
 * Versión de `springdoc-openapi` (FR-F12). El BOM de `spring-boot-starter-parent`
 * NO gestiona `org.springdoc`, así que va de propiedad Maven explícita —el
 * mecanismo que la tarea T3 pide— y no de un `<version>` suelto en la
 * dependencia. `3.1.1` es la primera línea de springdoc-openapi que declara
 * soporte para Spring Boot 4 (Jakarta EE 9, Java 17+); la línea `2.x` se quedó
 * en Spring Boot 3. Publica OpenAPI 3.1 por defecto desde springdoc `2.8.0`,
 * pero `application.yml` lo deja explícito para no depender de ese default.
 */
const SPRINGDOC_VERSION = '3.1.1';

/**
 * `pom.xml` (D8). Las dependencias son exactamente las de la tabla del diseño:
 * `webmvc`, `data-jpa`, `flyway`, `flyway-database-postgresql` (el starter de
 * Flyway 4.1.0 NO trae el módulo de PostgreSQL — hallazgo 4), `postgresql` en
 * alcance `runtime`, `validation` (FR-F11) y `springdoc-openapi-starter-webmvc-ui`
 * (FR-F12). Las de `org.springframework.boot` van con versión gestionada por la
 * BOM del padre; `spring-boot-starter-validation` NO se renombró en Spring Boot
 * 4.0 —a diferencia de `web` → `webmvc`— así que conserva su artifactId de
 * siempre. `springdoc` es de un `groupId` ajeno a la BOM, así que lleva su
 * propia propiedad de versión gestionada.
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
\t\t<springdoc-openapi.version>${SPRINGDOC_VERSION}</springdoc-openapi.version>
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
\t\t\t<groupId>org.springframework.boot</groupId>
\t\t\t<artifactId>spring-boot-starter-validation</artifactId>
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
\t\t<dependency>
\t\t\t<groupId>org.springdoc</groupId>
\t\t\t<artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
\t\t\t<version>\${springdoc-openapi.version}</version>
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

/**
 * Datasource, `validate`, `open-in-view: false`, puerto HTTP (D8), la versión
 * de OpenAPI que sirve `springdoc` (FR-F12) y la propiedad de la guarda de
 * secreto compartido (FR-MF03). `OPENAPI_3_1` queda explícito en vez de
 * confiar en el default de la librería: es el default desde springdoc
 * `2.8.0`, pero un futuro `springdoc-openapi.version` más viejo —o un cambio de
 * default corriente arriba— no debe volver falso «sirve OpenAPI 3.1» sin que
 * este archivo lo refleje.
 *
 * `${SHARED_TOKEN_PROPERTY}` sale con default vacío a propósito (D«apagada
 * por defecto» de la guarda): un proyecto recién generado arranca sin exigir
 * ninguna variable de entorno, y `SharedSecretFilter` lee ese mismo vacío
 * para desactivarse entero. El binding relajado de Spring Boot expone la
 * propiedad como `UMLIVE_SECURITY_SHARED_TOKEN` sin declarar nada más acá.
 */
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

springdoc:
  api-docs:
    version: OPENAPI_3_1

server:
  port: ${SERVER_PORT}

umlive:
  security:
    shared-token: ""
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

## Documentación de la API

| Documento | Ruta |
| --- | --- |
| OpenAPI 3.1 | \`GET /v3/api-docs\` |
| Swagger UI | \`GET /swagger-ui.html\` |

El documento describe cada endpoint y marca en \`required\` los campos
obligatorios de cada \`XRequest\`: un cliente que no conoce el diagrama puede
descubrir la API y saber, antes de enviar nada, qué campos no puede omitir.

## Guarda de secreto compartido (opcional)

Por defecto este proyecto NO exige autenticación, igual que antes de esta
sección: es lo apropiado en \`localhost\`. El problema aparece si se expone el
backend por un túnel HTTPS o una IP de LAN: sin nada más, cualquiera con la
URL puede leer, crear, editar y borrar todo. Antes de abrir un túnel, activá
la guarda:

\`\`\`bash
export UMLIVE_SECURITY_SHARED_TOKEN="un-secreto-largo-y-al-azar"
./mvnw spring-boot:run
\`\`\`

Con la variable definida, **toda ruta exige** el encabezado
\`Authorization: Bearer un-secreto-largo-y-al-azar\`, salvo las de
documentación que se listan abajo; sin el encabezado, o con el token
equivocado, la respuesta es \`401\` con \`WWW-Authenticate: Bearer\` y un cuerpo
Problem Details. Con la variable vacía o sin definir, el filtro no hace nada
y el comportamiento es exactamente el de antes (criterio de aceptación 1).

La guarda deniega por defecto a propósito: exime una lista corta y protege
todo lo demás. Enumerar en cambio lo que se protege falla ABIERTO ante
cualquier forma de la ruta que no se haya previsto — y una sí se coló en la
primera versión: \`GET /%61pi/...\` (\`%61\` es \`a\`) evitaba un chequeo hecho
sobre la URI cruda, porque Spring rutea con la ruta ya decodificada. La
comparación se hace ahora sobre la ruta decodificada.

**Esto NO es un modelo de seguridad completo**: es un único secreto
compartido, sin usuarios, sin roles, sin expiración ni revocación — alcanza
para no dejar el CRUD abierto a cualquiera, no para un sistema multiusuario.

**Importante — el path de descripción queda público a propósito**: con la
guarda activa, \`GET /v3/api-docs\` y \`/swagger-ui.html\` siguen respondiendo
sin token. Cualquiera que encuentre la URL del túnel puede leer el mapa
completo de la API — cada ruta, cada entidad, cada campo y cuál es
obligatorio — aunque no pueda invocar nada. Es una decisión de diseño
deliberada, no un descuido: quien abre el túnel debe saber que ese
reconocimiento de la API queda expuesto igual.

## Límites declarados

- \`ddl-auto: validate\`: el esquema lo aplica Flyway y Hibernate solo lo valida.
- Bean Validation (\`@NotNull\`/\`@NotBlank\`/\`@NotEmpty\`) rechaza con \`400\` un
  \`POST\`/\`PUT\` al que le falte un campo obligatorio, antes de tocar el
  repositorio: lo hace el \`@Valid\` del controlador, y \`ApiExceptionHandler\`
  traduce el rechazo a un cuerpo con el campo señalado. Un nulo que igual
  llegara a Hibernate —una restricción que Bean Validation no cubre— sigue
  cayendo en el mismo \`400\` por el camino viejo: \`PropertyValueException\` en
  el \`flush\`, o el \`SQLState 23502\` de PostgreSQL cuando la columna llega
  hasta la base. El golden de la Fase 0 (0.10) midió los dos caminos.
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
 * `SQLState` y no depende del modelo. El `SharedSecretFilter` (FR-MF03) entra
 * igual, siempre: es la guarda opcional que protege todo salvo las rutas de
 * documentación cuando el
 * operador configura un token, y con la propiedad en blanco se autodesactiva
 * en runtime sin que este emisor tenga que ramificar sobre el modelo.
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
  files.push(emitSharedSecretFilterFile());
  files.push(...emitPostmanFiles(ir));
  for (const irEnum of ir.enums) files.push(emitEnumFile(irEnum));
  for (const irInterface of ir.interfaces) files.push(emitInterfaceFile(irInterface));
  for (const entity of ir.entities) files.push(...emitEntityFiles(entity));

  files.push(...emitWrapperFiles());
  return files;
}

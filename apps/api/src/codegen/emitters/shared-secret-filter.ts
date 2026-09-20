/**
 * Emisor de la guarda de secreto compartido (`FR-MF03`).
 *
 * Deja que quien opera un backend generado lo exponga por un túnel HTTPS sin
 * dejar el CRUD destructivo abierto a cualquiera que tenga la URL. El diseño
 * completo — por qué NO se usa Spring Security, por qué la comparación es de
 * tiempo constante y el trade-off del path de descripción — está en
 * `odd/tasks/shared-secret-guard-for-generated-backend.md`; acá solo el
 * resumen que hace falta para leer el archivo emitido:
 *
 * - **Sin Spring Security**: `spring-boot-starter-security` autoconfigura
 *   login por formulario, HTTP Basic, CSRF y una contraseña de consola
 *   generada — mucho más código apagando defaults que implementando un
 *   chequeo. Un `OncePerRequestFilter` de `spring-web` ya está en el
 *   classpath a través de `spring-boot-starter-webmvc`: ninguna dependencia
 *   nueva.
 * - **Apagada por defecto**: el token sale de configuración con default
 *   vacío (`application.yml`, tarea T3). Un valor vacío desactiva el filtro
 *   ENTERO — `shouldNotFilter` devuelve `true` siempre— y un proyecto
 *   generado y corrido en local se comporta exactamente igual que antes de
 *   esta rebanada (criterio de aceptación 1).
 * - **Deniega por defecto, con lista blanca**: `shouldNotFilter` solo deja
 *   pasar sin chequeo las rutas de documentación (`/v3/api-docs`,
 *   `/swagger-ui`, `/webjars`). Todo lo demás pasa por el token. Es la
 *   decisión de diseño «el path de descripción queda abierto» tal como la
 *   pide `FR-MF03`: el README generado (tarea T5) tiene que declarar la
 *   exposición que eso implica, porque este filtro no la esconde.
 *
 *   La primera versión hacía lo contrario —protegía solo lo que empezaba con
 *   `/api/`— y era evitable. Una lista de lo que se protege falla ABIERTA
 *   ante cualquier forma de la ruta que no se haya previsto; una lista de lo
 *   que se abre falla CERRADA. Para una guarda de autenticación solo la
 *   segunda es defendible.
 * - **La ruta se compara decodificada**: `UrlPathHelper.getPathWithinApplication`
 *   y nunca `getRequestURI()`. La URI cruda conserva el porcentaje-escape,
 *   pero Spring rutea con la ruta ya decodificada: con `getRequestURI()`,
 *   `GET /%61pi/direccion` («%61» es «a») no empezaba con `/api/`, el filtro
 *   no corría y la petición llegaba igual al controlador. Medido contra el
 *   fixture de esta tarea: devolvía `200` al leer, `201` al crear y `204` al
 *   borrar, sin token. Toda decisión de autorización tiene que mirar la misma
 *   ruta que mira el ruteo, no la de la línea de petición.
 * - **Comparación de tiempo constante**: `MessageDigest.isEqual` en vez de
 *   `String.equals`, para que un token rechazado no filtre por temporización
 *   cuántos caracteres del prefijo acertó.
 * - **El filtro escribe su propio cuerpo**: un `OncePerRequestFilter` corre
 *   ANTES que `@RestControllerAdvice` (`ApiExceptionHandler`, tarea 2.6), así
 *   que una excepción lanzada acá nunca llegaría al advice. Por eso este
 *   emisor arma su propio `ProblemDetail` — misma forma que ya emite
 *   `ApiExceptionHandler` (`status`, `title`, `detail`) más `instance`,
 *   que ningún handler de esta rebanada fija todavía — y lo serializa con
 *   Jackson, nunca con concatenación de strings.
 *
 *   El `ObjectMapper` se instancia con `new` DENTRO del filtro y no se
 *   inyecta el bean que Spring Boot autoconfigura: un bean `Filter` entra al
 *   contenedor servlet durante `onRefresh()` —antes de que
 *   `finishBeanFactoryInitialization()` termine de crear el resto de los
 *   singletons—, y pedir el `ObjectMapper` autoconfigurado por constructor
 *   ahí rompe el arranque con `UnsatisfiedDependencyException` (falla medida
 *   contra el fixture de esta misma tarea). El filtro no necesita ninguna
 *   configuración de Jackson que el proyecto pudiera personalizar —el cuerpo
 *   que arma es fijo—, así que una instancia propia es la forma simple y sin
 *   ese riesgo de orden de arranque.
 *
 * Función pura `() => string`: no depende del modelo (`ir`) porque el
 * archivo es siempre el mismo, igual que `error-advice.ts`.
 */

import { BASE_PACKAGE } from '../build-ir';
import type { GeneratedFile } from '../zip';

/** Misma raíz que los otros emisores; la comparte la disposición del ZIP. */
const JAVA_SOURCE_ROOT = `src/main/java/${BASE_PACKAGE.replace(/\./g, '/')}`;

/** El filtro vive en un paquete propio: no es una entidad ni un controlador (D2, D4). */
const CONFIG_PACKAGE = `${BASE_PACKAGE}.config`;

/**
 * Ruta del filtro. `SharedSecretFilter` ocupa el espacio de tipos y está en
 * la lista de reservadas de `java-names.ts` (D3): una clase UML con ese
 * nombre chocaría con este archivo y bloquearía la generación, igual que
 * `ApiExceptionHandler`.
 */
export const SHARED_SECRET_FILTER_PATH = 'config/SharedSecretFilter.java';

/**
 * Nombre de la propiedad de configuración (tarea T3). Sale con `@Value` y
 * default vacío: sin este `:` la aplicación no arrancaría si el operador no
 * define la variable de entorno. El binding relajado de Spring Boot expone
 * la misma propiedad como `UMLIVE_SECURITY_SHARED_TOKEN` sin declarar nada
 * más — es lo que la deja «lista para que una variable de entorno la
 * complete en despliegue» sin ningún mecanismo extra.
 */
export const SHARED_TOKEN_PROPERTY = 'umlive.security.shared-token';

/** El texto completo del filtro. */
export function emitSharedSecretFilter(): string {
  return `package ${CONFIG_PACKAGE};

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UrlPathHelper;

/**
 * Guarda opcional de secreto compartido (FR-MF03). Protege unicamente
 * "/api/**"; el path de descripcion ("/v3/api-docs", "/swagger-ui.html")
 * queda siempre abierto, por diseno (ver el README generado). Con
 * "${SHARED_TOKEN_PROPERTY}" en blanco el filtro no hace nada: shouldNotFilter
 * devuelve true para toda peticion y el comportamiento es identico al de un
 * proyecto sin esta guarda.
 */
@Component
public class SharedSecretFilter extends OncePerRequestFilter {

    // Las unicas rutas que se saltean el chequeo: la documentacion. Todo lo
    // demas queda protegido, asi que una forma de ruta que nadie previo falla
    // CERRADA. Lo contrario -enumerar lo que se protege- falla abierta.
    private static final List<String> OPEN_PREFIXES =
            List.of("/v3/api-docs", "/swagger-ui", "/webjars");

    private static final String BEARER_PREFIX = "Bearer ";

    // Decodifica la ruta y le saca el context path, para mirar la MISMA ruta
    // sobre la que Spring rutea. Nunca getRequestURI(): conserva el
    // porcentaje-escape, y "/%61pi/x" se colaba por un chequeo que atrapaba
    // "/api/x".
    private static final UrlPathHelper PATH_HELPER = UrlPathHelper.defaultInstance;

    private final String expectedToken;
    // NON_NULL para que "type" y "properties" -sin valor porque este filtro
    // nunca los usa- no aparezcan en el cuerpo: es lo que hace que la forma
    // coincida con la que arma ApiExceptionHandler a traves del ObjectMapper
    // que Spring Boot autoconfigura (comprobado contra el fixture de esta
    // tarea).
    private final ObjectMapper objectMapper =
            new ObjectMapper().setDefaultPropertyInclusion(JsonInclude.Include.NON_NULL);

    public SharedSecretFilter(@Value("\${${SHARED_TOKEN_PROPERTY}:}") String expectedToken) {
        this.expectedToken = expectedToken;
    }

    /**
     * Sin token configurado la guarda esta apagada entera. Con token, solo
     * las rutas de documentacion quedan exentas -comparadas contra la ruta
     * DECODIFICADA- y cualquier otra peticion tiene que presentarlo.
     */
    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (expectedToken.isBlank()) {
            return true;
        }
        String path = PATH_HELPER.getPathWithinApplication(request);
        return OPEN_PREFIXES.stream().anyMatch(path::startsWith);
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String provided = bearerToken(request);
        if (provided != null && MessageDigest.isEqual(
                expectedToken.getBytes(StandardCharsets.UTF_8),
                provided.getBytes(StandardCharsets.UTF_8))) {
            filterChain.doFilter(request, response);
            return;
        }
        rejectUnauthenticated(request, response);
    }

    private static String bearerToken(HttpServletRequest request) {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith(BEARER_PREFIX)) return null;
        return header.substring(BEARER_PREFIX.length());
    }

    /**
     * 401 con el mismo tipo de cuerpo que ApiExceptionHandler (status, title,
     * detail, instance): este filtro corre antes que el
     * @RestControllerAdvice, asi que el advice nunca lo veria si se lanzara
     * como excepcion. WWW-Authenticate le dice al cliente que falta
     * autenticarse en vez de dejarlo adivinar.
     */
    private void rejectUnauthenticated(HttpServletRequest request, HttpServletResponse response)
            throws IOException {
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.UNAUTHORIZED);
        problem.setTitle("No autenticado");
        problem.setDetail("Falta o es invalido el token del encabezado Authorization");
        problem.setInstance(URI.create(request.getRequestURI()));
        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setHeader(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        response.getWriter().write(objectMapper.writeValueAsString(problem));
    }
}
`;
}

/** El archivo del filtro para el ZIP. */
export function emitSharedSecretFilterFile(): GeneratedFile {
  return { path: `${JAVA_SOURCE_ROOT}/${SHARED_SECRET_FILTER_PATH}`, content: emitSharedSecretFilter() };
}

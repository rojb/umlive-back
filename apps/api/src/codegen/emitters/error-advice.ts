/**
 * Emisor del `ApiExceptionHandler` (tarea 2.6, D6; extendido en la rebanada de
 * Bean Validation, FR-F11).
 *
 * Es la pieza que convierte una violación de integridad de PostgreSQL —o un
 * `record` de petición que no cumple sus anotaciones de Bean Validation— en
 * una respuesta honesta en lugar de un `500`. `MethodArgumentNotValidException`
 * cubre la línea principal: el `@Valid` del controlador rechaza ANTES de que el
 * `request` llegue al servicio, así que un campo obligatorio ausente nunca toca
 * el repositorio. El mapeo por `SQLState`/`PropertyValueException` sigue
 * existiendo como defensa en profundidad: cubre lo que Bean Validation no
 * anota —un `DELETE` de un registro referenciado, un segundo vínculo de un
 * `1—1`— y lo que, por lo que sea, igual llegara nulo hasta Hibernate.
 *
 * ── Por qué recorre `getCause()` ────────────────────────────────────────────
 *
 * La excepción que sale del repositorio es `DataIntegrityViolationException`
 * (Spring la traduce ahí mismo, D6); el `java.sql.SQLException` con el
 * `SQLState` legible queda en la cadena de causas. El golden de la Fase 0
 * (0.10) confirmó que con PgJDBC 42.7.11 el `SQLState` es legible desde ahí, y
 * que `repository.flush()` hace saltar la violación **dentro** del proxy del
 * repositorio: por eso los servicios llaman `flush()` tras cada escritura y no
 * esperan al commit (que también la traduciría, pero es un supuesto que no hace
 * falta asumir).
 *
 * ── La corrección que midió el golden 0.10 (2026-09-18) ─────────────────────
 *
 * D6 suponía que un campo obligatorio ausente llegaba a PostgreSQL y volvía
 * como `SQLState 23502` → `400`. El golden mostró que **no**: con
 * `@Column(nullable = false)` (y con `@JoinColumn(nullable = false)`), Hibernate
 * detecta el nulo en el `flush` y lanza `PropertyValueException` — que Spring
 * traduce a `DataIntegrityViolationException`— **antes** de tocar la base, así
 * que no hay ningún `SQLException` en la cadena y el `SQLState` es `null`.
 *
 * Por eso el advice mapea los dos caminos a `400`: el `SQLState 23502` de
 * PostgreSQL (que sigue existiendo para columnas que Hibernate no administra) y
 * el `PropertyValueException` de Hibernate. Sin esto, el escenario «campo
 * obligatorio ausente → `400`» de la spec sería falso y el `README.md`
 * documentaría algo que no pasa.
 *
 * Función pura `(ir) => string`: no lee el reloj, el azar ni el locale. Emite
 * el archivo siempre, incluso sin entidades, porque el mapeo de errores no
 * depende del modelo.
 */

import { BASE_PACKAGE } from '../build-ir';
import type { GeneratedFile } from '../zip';

/** Misma raíz que los otros emisores; la comparte la disposición del ZIP. */
const JAVA_SOURCE_ROOT = `src/main/java/${BASE_PACKAGE.replace(/\./g, '/')}`;

/** El advice vive con los controladores: `controller/ApiExceptionHandler.java`. */
const CONTROLLER_PACKAGE = `${BASE_PACKAGE}.controller`;

/**
 * Ruta del advice. El nombre `ApiExceptionHandler` ocupa el espacio de tipos y
 * está en la lista de reservadas de `java-names.ts` (D8): una clase UML con ese
 * nombre choca con este archivo y bloquea la generación.
 */
export const ERROR_ADVICE_PATH = 'controller/ApiExceptionHandler.java';

/** El texto completo del advice. Un solo `@ExceptionHandler`, un solo mapa de `SQLState` → HTTP. */
export function emitErrorAdvice(): string {
  return `package ${CONTROLLER_PACKAGE};

import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Traduce las violaciones de integridad que el repositorio ya convirtio en
 * DataIntegrityViolationException, leyendo el SQLState de PostgreSQL en la
 * cadena de causas, y los rechazos de Bean Validation del @Valid del
 * controlador. Ninguna de estas respuestas es 500.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    /**
     * El @Valid del controlador rechaza antes de que el request llegue al
     * servicio: por eso este handler nombra el campo sin haber tocado el
     * repositorio todavia.
     */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException exception) {
        Map<String, String> errors = new LinkedHashMap<>();
        for (FieldError fieldError : exception.getBindingResult().getFieldErrors()) {
            errors.put(fieldError.getField(), fieldError.getDefaultMessage());
        }
        ProblemDetail problem = ProblemDetail.forStatus(HttpStatus.BAD_REQUEST);
        problem.setTitle("Validacion fallida");
        problem.setDetail("Uno o mas campos no cumplen su restriccion");
        problem.setProperty("errors", errors);
        return new ResponseEntity<>(problem, HttpStatus.BAD_REQUEST);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ProblemDetail> handleDataIntegrityViolation(DataIntegrityViolationException exception) {
        String sqlState = sqlStateOf(exception);
        HttpStatus status = statusFor(sqlState, exception);
        ProblemDetail problem = ProblemDetail.forStatus(status);
        problem.setTitle("Violacion de integridad");
        problem.setDetail(sqlState == null
                ? detalleSinSqlState(exception)
                : "SQLState " + sqlState);
        return new ResponseEntity<>(problem, status);
    }

    private static String sqlStateOf(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current instanceof SQLException sqlException) {
                return sqlException.getSQLState();
            }
            current = current.getCause();
        }
        return null;
    }

    /**
     * Hibernate detecta el nulo de una propiedad obligatoria en el flush y lanza
     * PropertyValueException ANTES de tocar la base: no hay SQLState que leer.
     * Se compara por nombre de clase para no importar Hibernate aca.
     */
    private static boolean missingMandatoryValue(Throwable throwable) {
        Throwable current = throwable;
        while (current != null) {
            if (current.getClass().getName().equals("org.hibernate.PropertyValueException")) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static String detalleSinSqlState(Throwable throwable) {
        return missingMandatoryValue(throwable)
                ? "Falta un valor obligatorio antes de tocar la base"
                : "La operacion viola una restriccion de la base";
    }

    private static HttpStatus statusFor(String sqlState, Throwable throwable) {
        if (sqlState == null) {
            return missingMandatoryValue(throwable) ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT;
        }
        return switch (sqlState) {
            case "23503" -> HttpStatus.CONFLICT;
            case "23505" -> HttpStatus.CONFLICT;
            case "23502" -> HttpStatus.BAD_REQUEST;
            default -> HttpStatus.CONFLICT;
        };
    }
}
`;
}

/** El archivo del advice para el ZIP. */
export function emitErrorAdviceFile(): GeneratedFile {
  return { path: `${JAVA_SOURCE_ROOT}/${ERROR_ADVICE_PATH}`, content: emitErrorAdvice() };
}

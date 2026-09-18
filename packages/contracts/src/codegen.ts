/**
 * Contratos de la generación de código (M5, rebanada 3/4 — `codegen-core`).
 *
 * Diseño: `openspec/changes/codegen-core/design.md` D10. Especificación:
 * `.../specs/codegen-core-backend/spec.md` (compuerta, reporte) y
 * `.../specs/codegen-core-frontend/spec.md` (diálogo, estados, descarga).
 *
 * `packages/contracts` es el único lugar donde viven estos tipos: los consume
 * el servidor (respuesta `200`/`422`) y el cliente (descarga y reporte), igual
 * que `UML_ERROR` y `VALIDATION_RULES` en `uml.ts`.
 */

import type { ValidationRuleId } from './uml';

/**
 * Bloqueos propios del generador (D3, D5, contradicción 2 de la propuesta).
 * Son distintos de los de `uml-validation`: esos viajan como `ruleId`.
 *
 * `name_unrepresentable`: el nombre quedó vacío tras partir por los límites
 * de identificador de Java (ni una letra ni un dígito). Un ideograma CJK **sí**
 * es letra bajo `Character.isJavaIdentifierPart`, así que no vacía el nombre
 * (corrección 2026-09-17, FR-D20b).
 */
export type CodegenBlockCode =
  | 'name_collision'
  | 'name_unrepresentable'
  | 'pk_type_invalid'
  | 'operation_signature_collision';

/**
 * Notas del reporte (D6): toda decisión no trivial deja una. Ninguna pérdida
 * puede ocurrir en silencio. `route_ascii_folded` la agrega la corrección
 * 2026-09-17 (FR-D20b): es la única tubería de nombres que pliega a ASCII.
 */
export type CodegenNoteCode =
  | 'pk_injected'
  | 'name_escaped'
  | 'unknown_type'
  | 'attribute_skipped'
  | 'classifier_skipped'
  | 'operation_skipped'
  | 'relationship_deferred'
  | 'default_value_ignored'
  | 'validation_warning'
  | 'no_entities'
  | 'route_ascii_folded';

/**
 * Referencia a un elemento del lienzo. `id` es SIEMPRE de elemento
 * (`UmlElement`), nunca de feature ni de relación (D6): el cliente necesita
 * poder hacer `selectElement(id)` con él (SC-F01). `qualifiedName` sale de
 * `qualifiedName()` de `uml.ts`; `null` cuando el elemento no tiene nombre
 * calificado (un `COMMENT`, o un `parentId` ausente del índice).
 */
export interface CodegenElementRef {
  id: string;
  qualifiedName: string | null;
}

/**
 * Hallazgo de la compuerta FR-F09 (D6): dos fuentes, una forma.
 *
 * - `source: 'validation'`: lo produjo `ValidationService`; `ruleId` es la
 *   regla. Solo entran acá las de severidad `blocking`.
 * - `source: 'codegen'`: lo produjo el generador; `code` es el bloqueo propio.
 */
export type CodegenFinding =
  | { source: 'validation'; ruleId: ValidationRuleId; elements: CodegenElementRef[]; detail: string | null }
  | { source: 'codegen'; code: CodegenBlockCode; elements: CodegenElementRef[]; detail: string | null };

/** Fila del reporte de generación (D6). No bloquea: describe una pérdida declarada. */
export interface CodegenNote {
  code: CodegenNoteCode;
  elements: CodegenElementRef[];
  detail: string | null;
}

/** Reporte agregado que acompaña a todo `200` (requisito "Reporte de generación sin pérdidas silenciosas"). */
export interface CodegenReport {
  entities: number;
  enums: number;
  files: number;
  notes: CodegenNote[];
}

/**
 * Respuesta exitosa. El ZIP viaja en base64 en la misma respuesta que el
 * reporte (D10): así se hereda la renovación silenciosa ante `401` de
 * `apiRequest` y el cliente no necesita un segundo camino binario.
 * `sha256` es el del ZIP crudo, para comparar dos corridas sin descomprimir
 * (SC-F11).
 */
export interface CodegenResponse {
  fileName: string;
  zipBase64: string;
  sha256: string;
  report: CodegenReport;
}

/** Cuerpo del `422` (D10). Ningún byte de ZIP se emite mientras haya `findings`. */
export interface CodegenBlockedBody {
  code: 'codegen_blocked';
  findings: CodegenFinding[];
}

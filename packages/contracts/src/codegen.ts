/**
 * Contratos de la generación de código (M5, rebanada 4/4 — `codegen-relationships`).
 *
 * Diseño: `openspec/changes/codegen-relationships/design.md` D1 y D10.
 * Especificación: `.../specs/codegen-relationships-backend/spec.md` (compuerta,
 * reporte) y `.../specs/codegen-relationships-frontend/spec.md` (diálogo).
 *
 * `packages/contracts` es el único lugar donde viven estos tipos: los consume
 * el servidor (respuesta `200`/`422`) y el cliente (descarga y reporte), igual
 * que `UML_ERROR` y `VALIDATION_RULES` en `uml.ts`.
 *
 * ── Lo que agrega la rebanada 4 (D1, D10) ──────────────────────────────────
 *
 * `relationship_deferred` **desaparece** de `CodegenNoteCode`: en esta rebanada
 * cada relación queda emitida (con sus notas de desviación) o declarada como
 * `relationship_not_emitted`. Se suman los ocho bloqueos y las siete notas que
 * el diseño D2–D9 introducen, y `CodegenRelationshipRef`, que permite que un
 * hallazgo o una nota apunten a una **arista** del lienzo y no solo a un
 * elemento.
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
  | 'operation_signature_collision'
  // D2 — herencia e interfaces.
  | 'multiple_inheritance'
  | 'pk_in_subclass'
  | 'inherited_member_collision'
  | 'mapped_superclass_not_root'
  | 'mapped_superclass_as_association_end'
  // D4 — agregación en ambos extremos: no hay TODO determinista.
  | 'ambiguous_aggregation'
  // D9 — grafo de referencias obligatorias.
  | 'mandatory_reference_cycle'
  | 'unsatisfiable_mandatory_reference';

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
  | 'default_value_ignored'
  | 'validation_warning'
  | 'no_entities'
  | 'route_ascii_folded'
  // D3 — asociaciones: la multiplicidad y la navegabilidad se desvían del UML literal.
  | 'navigability_widened'
  | 'upper_bound_not_enforced'
  | 'collection_lower_bound_not_enforced'
  | 'inverse_lower_bound_not_enforced'
  // D8 — nombre SQL acortado a 63 bytes UTF-8.
  | 'name_shortened'
  // D7 — clase asociación tratada como entidad.
  | 'association_class_as_entity'
  // D3 — relación que no produce código (`DEPENDENCY`/`USAGE`, extremo sobre no-entidad).
  | 'relationship_not_emitted';

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
 * Referencia a una **relación** del lienzo (D10). `label` se arma en la IR con
 * `qualifiedName()` de los dos extremos (o con el nombre de la relación, si
 * tiene): «Cliente — Pedido (ASSOCIATION)». El cliente lo usa para
 * `selectRelationship(id)`, que limpia la selección de elemento.
 *
 * Es un campo **al lado** de `elements`, no un reemplazo: un hallazgo puede
 * nombrar clases Y relaciones a la vez (un ciclo obligatorio nombra las dos
 * cosas), así que el usuario ve un vínculo por cada referencia.
 */
export interface CodegenRelationshipRef {
  id: string;
  label: string;
}

/**
 * Hallazgo de la compuerta FR-F09 (D6): dos fuentes, una forma.
 *
 * - `source: 'validation'`: lo produjo `ValidationService`; `ruleId` es la
 *   regla. Solo entran acá las de severidad `blocking`.
 * - `source: 'codegen'`: lo produjo el generador; `code` es el bloqueo propio.
 *
 * `relationships` está SIEMPRE presente y es `[]` en los hallazgos de
 * validación, que solo conocen elementos (D10).
 */
export type CodegenFinding =
  | {
      source: 'validation';
      ruleId: ValidationRuleId;
      elements: CodegenElementRef[];
      relationships: CodegenRelationshipRef[];
      detail: string | null;
    }
  | {
      source: 'codegen';
      code: CodegenBlockCode;
      elements: CodegenElementRef[];
      relationships: CodegenRelationshipRef[];
      detail: string | null;
    };

/** Fila del reporte de generación (D6). No bloquea: describe una pérdida declarada. */
export interface CodegenNote {
  code: CodegenNoteCode;
  elements: CodegenElementRef[];
  relationships: CodegenRelationshipRef[];
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

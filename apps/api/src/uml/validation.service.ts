import { Injectable } from '@nestjs/common';
import {
  isBlockingRule,
  qualifiedName,
  type UmlElementView,
  type ValidationFinding,
  type ValidationReport,
  type ValidationRuleId,
} from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
type ElementIndex = Record<string, Pick<UmlElementView, 'parentId' | 'name' | 'kind'>>;

/**
 * Capa consultiva de FR-B14 (design.md D6-D9; tasks.md 2.3). Sin estado, sin
 * persistir hallazgos — recalculada entera en cada llamada (propuesta,
 * "Dónde corre la validación").
 *
 * `validateIn(tx, diagramId)` es PÚBLICO y no abre transacción propia — la
 * expone `codegen-core` (M5) para que la compuerta FR-F09 y la lectura del
 * modelo que genera vean el MISMO snapshot (design.md D6). `validate` abre
 * la transacción `RepeatableRead` y delega — mismo patrón extract-method
 * `…In(tx)` que `operations-pipeline`.
 *
 * **Por qué `RepeatableRead` y no un `$transaction([...])` en lote**
 * (corrección de design.md, 2026-09-17): bajo `READ COMMITTED` (el nivel por
 * defecto de PostgreSQL) cada SENTENCIA toma su propio snapshot, aunque
 * estén dentro de la misma transacción — un lote da atomicidad, no una
 * vista única. Solo `REPEATABLE READ` fija el snapshot en la primera
 * sentencia y lo mantiene hasta el final. Sin riesgo de error de
 * serialización (`40001`): esta transacción no escribe nada.
 */
@Injectable()
export class ValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(diagramId: string): Promise<ValidationReport> {
    return this.prisma.$transaction((tx) => this.validateIn(tx, diagramId), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async validateIn(tx: Tx, diagramId: string): Promise<ValidationReport> {
    // Quinta consulta plana (design.md D6, D9 nota): `(id, parentId, name,
    // kind)` de TODO el diagrama, para plegar `qualifiedName()` en cada
    // hallazgo — misma función pura que usa el cliente para el árbol.
    const elements = await tx.umlElement.findMany({
      where: { diagramId },
      select: { id: true, parentId: true, name: true, kind: true },
    });
    const index: ElementIndex = {};
    for (const el of elements) index[el.id] = { parentId: el.parentId, name: el.name, kind: el.kind };

    const findings: ValidationFinding[] = [
      ...(await this.findGeneralizationCycles(tx, diagramId, index)),
      ...(await this.findInterfaceInstanceAttributes(tx, diagramId, index)),
      ...(await this.findAbstractWithoutConcrete(tx, diagramId, index)),
      ...(await this.findDuplicateFeatureSignatures(tx, diagramId, index)),
      // `composite_multiplicity` y `dangling_relationship_end` son
      // `enforcedBy: 'constraint'` — NO ejecutan consulta (D7, Hallazgo 4):
      // devolverían siempre cero filas sobre datos ya almacenados.
    ];

    return {
      diagramId,
      generatedAt: new Date().toISOString(),
      findings,
      blocking: findings.some((f) => isBlockingRule(f.ruleId)),
    };
  }

  /**
   * SC-B10 🔴 (D9). `UNION`, sin columna `depth` — misma corrección que
   * `collectSubtreeIds` (D1): el par `(start_id, current_id)` se deduplica
   * solo, la consulta termina con cota real `V × E`. **Un hallazgo POR
   * ELEMENTO en el ciclo, no uno por ciclo** — FR-F09 exige que cada error
   * enlace a SU elemento en el lienzo; con `Pedido→Venta→Compra→Pedido`
   * salen tres hallazgos, uno por clase.
   */
  private async findGeneralizationCycles(tx: Tx, diagramId: string, index: ElementIndex): Promise<ValidationFinding[]> {
    const rows = await tx.$queryRaw<{ element_id: string }[]>`
      WITH RECURSIVE chain(start_id, current_id) AS (
        SELECT r.source_element_id, r.target_element_id
          FROM uml_relationships r
         WHERE r.diagram_id = ${diagramId}::uuid AND r.kind = 'GENERALIZATION'
        UNION
        SELECT c.start_id, r.target_element_id
          FROM chain c
          JOIN uml_relationships r
            ON r.source_element_id = c.current_id AND r.diagram_id = ${diagramId}::uuid AND r.kind = 'GENERALIZATION'
      )
      SELECT DISTINCT start_id AS element_id FROM chain WHERE current_id = start_id
    `;
    return rows.map((row) => ({
      ruleId: 'generalization_cycle' as ValidationRuleId,
      elements: [{ id: row.element_id, qualifiedName: qualifiedName(row.element_id, index) }],
      detail: null,
    }));
  }

  /**
   * SC-B11 🔴. Sin SQL crudo a propósito (design.md D9): expresable con
   * Prisma, y el SQL crudo se reserva para lo que Prisma no puede decir.
   */
  private async findInterfaceInstanceAttributes(tx: Tx, diagramId: string, index: ElementIndex): Promise<ValidationFinding[]> {
    const attributes = await tx.umlFeature.findMany({
      where: { kind: 'ATTRIBUTE', isStatic: false, owner: { diagramId, kind: 'INTERFACE' } },
      select: { id: true, name: true, ownerId: true },
    });
    return attributes.map((attr) => ({
      ruleId: 'interface_instance_attribute' as ValidationRuleId,
      elements: [{ id: attr.ownerId, qualifiedName: qualifiedName(attr.ownerId, index) }],
      detail: attr.name,
    }));
  }

  /**
   * `warning`, no `blocking` (D7). Clausura TRANSITIVA de `GENERALIZATION`
   * (design.md D9) — una clase abstracta con un descendiente concreto en
   * cualquier profundidad NO genera hallazgo (`Vehiculo`←`Terrestre`←`Auto`
   * concreta es modelado normal). Mismo truco `UNION` que arriba: el par
   * `(descendant_id, ancestor_id)` se deduplica solo.
   */
  private async findAbstractWithoutConcrete(tx: Tx, diagramId: string, index: ElementIndex): Promise<ValidationFinding[]> {
    const rows = await tx.$queryRaw<{ element_id: string }[]>`
      WITH RECURSIVE descent(descendant_id, ancestor_id) AS (
        SELECT r.source_element_id, r.target_element_id
          FROM uml_relationships r
         WHERE r.diagram_id = ${diagramId}::uuid AND r.kind = 'GENERALIZATION'
        UNION
        SELECT d.descendant_id, r.target_element_id
          FROM descent d
          JOIN uml_relationships r
            ON r.source_element_id = d.ancestor_id AND r.diagram_id = ${diagramId}::uuid AND r.kind = 'GENERALIZATION'
      )
      SELECT e.id AS element_id
        FROM uml_elements e
       WHERE e.diagram_id = ${diagramId}::uuid
         AND e.kind = 'CLASS'
         AND e.is_abstract = true
         AND NOT EXISTS (
           SELECT 1
             FROM descent d
             JOIN uml_elements c ON c.id = d.descendant_id
            WHERE d.ancestor_id = e.id AND c.kind = 'CLASS' AND c.is_abstract = false
         )
    `;
    return rows.map((row) => ({
      ruleId: 'abstract_without_concrete' as ValidationRuleId,
      elements: [{ id: row.element_id, qualifiedName: qualifiedName(row.element_id, index) }],
      detail: null,
    }));
  }

  /**
   * Mitad de OPERACIONES de "nombres de feature duplicados" (Hallazgo 3, D8)
   * — la mitad de ATRIBUTOS no consulta: `uq_attribute_name_per_owner` ya la
   * hace imposible. Firma armada con `string_agg(...ORDER BY position)`,
   * `direction <> 'RETURN'` (el tipo de retorno no es parte de la firma) y
   * la DIRECCIÓN fuera de la clave (SC-B08 🔴: la sobrecarga por lista de
   * parámetros distinta sigue siendo legal).
   */
  private async findDuplicateFeatureSignatures(tx: Tx, diagramId: string, index: ElementIndex): Promise<ValidationFinding[]> {
    const rows = await tx.$queryRaw<{ owner_id: string; name: string; signature: string; feature_ids: string[] }[]>`
      SELECT ops.owner_id, ops.name, ops.signature, array_agg(ops.id) AS feature_ids
        FROM (
          SELECT f.id, f.owner_id, f.name,
                 coalesce((SELECT string_agg(coalesce(p.type_element_id::text, p.type_name, '?'), ','
                                             ORDER BY p.position)
                             FROM uml_parameters p
                            WHERE p.operation_id = f.id AND p.direction <> 'RETURN'), '') AS signature
            FROM uml_features f
            JOIN uml_elements e ON e.id = f.owner_id
           WHERE e.diagram_id = ${diagramId}::uuid AND f.kind = 'OPERATION'
        ) ops
       GROUP BY ops.owner_id, ops.name, ops.signature
      HAVING count(*) > 1
    `;

    return rows.map((row) => ({
      ruleId: 'duplicate_feature_signature' as ValidationRuleId,
      elements: [{ id: row.owner_id, qualifiedName: qualifiedName(row.owner_id, index) }],
      // El `detail` se arma acá, no en el SQL (D8: "transferir(uuid,String) es
      // ilegible") — cada token de la firma cruda es un `type_element_id`
      // (se resuelve a nombre con el índice) o ya es un `type_name`/`?`.
      detail: `${row.name}(${this.resolveSignatureTypes(row.signature, index)})`,
    }));
  }

  private resolveSignatureTypes(signature: string, index: ElementIndex): string {
    if (signature === '') return '';
    return signature
      .split(',')
      .map((token) => index[token]?.name ?? token)
      .join(', ');
  }
}

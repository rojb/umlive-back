import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { CodegenBlockedBody, CodegenReport, CodegenResponse } from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DiagramContentService } from '../uml/diagram-content.service';
import { ValidationService } from '../uml/validation.service';
import { buildIr } from './build-ir';
import { emitProject } from './emitters/project';
import { buildZip } from './zip';

/**
 * Orquestador de la generación (tarea 2.9, D1 y D10).
 *
 * **Un solo snapshot, y la compuerta adentro.** La transacción abre en
 * `RepeatableRead` y su PRIMERA sentencia es `validateIn(tx, …)`: en PostgreSQL
 * bajo `RepeatableRead` el snapshot queda fijo ahí y no cambia hasta el
 * `COMMIT`, así que `getDiagramContentIn(tx, …)` ve exactamente el mismo estado
 * que aprobó la compuerta. Con `READ COMMITTED` —el nivel por defecto— cada
 * sentencia tomaría su propio snapshot y se podría generar código desde un
 * modelo que la validación nunca vio. `REPEATABLE READ` y no `SERIALIZABLE`
 * porque la transacción es de solo lectura: no puede fallar por serialización
 * (`40001`), y `SERIALIZABLE` no agregaría nada.
 *
 * **Las dos lecturas corren siempre**, aunque la validación ya haya bloqueado: el
 * `422` tiene que traer juntos los hallazgos de validación y los bloqueos propios
 * del generador (D6) para que el estudiante corrija todo de una vez. El costo es
 * una lectura más en un camino que ya iba a fallar.
 *
 * **`buildIr`, los emisores y el ZIP corren FUERA de la transacción**: son
 * funciones puras sobre la IR ya leída, así que la conexión se libera enseguida y
 * ningún trabajo de CPU —ni el compresor— mantiene abierta una transacción de
 * base. Con `blockers` no vacío se corta acá y **no se emite un byte de ZIP**.
 *
 * El generador no escribe ninguna fila, ninguna migración de UMLive, ni persiste
 * el ZIP en disco o almacenamiento: devuelve los bytes en memoria, en la misma
 * respuesta que el reporte (D10).
 */

/** Tope de la transacción de lectura: es solo lectura, no debería acercarse. */
const SNAPSHOT_TIMEOUT_MS = 5000;

/** Tope de espera por una conexión libre antes de fallar la petición. */
const SNAPSHOT_MAX_WAIT_MS = 2000;

@Injectable()
export class CodegenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validation: ValidationService,
    private readonly content: DiagramContentService,
  ) {}

  /**
   * Genera el proyecto del diagrama. `200 CodegenResponse` o el
   * `422 { code: 'codegen_blocked', findings }` de D10.
   */
  async generate(diagramId: string): Promise<CodegenResponse> {
    const read = await this.prisma.$transaction(
      async (tx) => {
        // La PRIMERA sentencia de la transacción fija el snapshot (D1).
        const validation = await this.validation.validateIn(tx, diagramId);
        const content = await this.content.getDiagramContentIn(tx, diagramId);
        return { validation, content };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: SNAPSHOT_TIMEOUT_MS,
        maxWait: SNAPSHOT_MAX_WAIT_MS,
      },
    );

    const ir = buildIr(read.content, read.validation);

    if (ir.blockers.length > 0) {
      const blocked: CodegenBlockedBody = { code: 'codegen_blocked', findings: ir.blockers };
      throw new UnprocessableEntityException(blocked);
    }

    const files = emitProject(ir);
    const zip = buildZip(ir.artifactId, files);

    const report: CodegenReport = {
      entities: ir.entities.length,
      enums: ir.enums.length,
      files: files.length,
      notes: ir.notes,
    };

    return {
      fileName: `${ir.artifactId}.zip`,
      // El ZIP viaja en base64 en la misma respuesta que el reporte: `apiRequest`
      // solo habla JSON, así que se hereda la renovación silenciosa ante un `401`
      // sin agregar un camino binario al cliente (D10). Los bytes NO se
      // recodifican en el cliente, así el hash se mantiene (SC-F11).
      zipBase64: Buffer.from(zip.bytes).toString('base64'),
      sha256: zip.sha256,
      report,
    };
  }
}

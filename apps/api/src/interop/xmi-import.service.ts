import {
  ConflictException,
  HttpException,
  Injectable,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  XMI_IMPORT_ERROR,
  XMI_IMPORT_ERROR_STATUS,
  type XmiImportPreview,
  type XmiImportResult,
  type XmiVersion,
} from '@umlive/contracts';
import { Prisma } from '../generated/prisma/client';
import type { XmiVersion as PrismaXmiVersion } from '../generated/prisma/enums';
import type { Tx } from '../prisma/tx.type';
import { PrismaService } from '../prisma/prisma.service';
import {
  detectTargetChange,
  findXmiIdCollision,
  runImportPreflight,
  type DestinationSnapshot,
} from './import-preflight';
import { writeImportPlan } from './import-plan';
import { XmiAdmissionError, XmiAdmissionService } from './xmi-admission';
import { readXmiModel, type ParsedModel } from './xmi-reader';

/**
 * Orquestador del import (tareas 4.3 y 4.4). Es la ÚNICA clase de la rebanada
 * con `PrismaService`, y la única que conoce los tres niveles de D1:
 *
 * ```
 * Buffer ──[A] admisión──▶ XmlDocument ──lectura──▶ ParsedModel ──[B] pre-vuelo──▶ ImportPlan
 *         aborta (413/415/422)              aborta (422/409)          NUNCA aborta
 *                                                                          │
 *                                              [C] destino (dentro de BEGIN) ──▶ escritura tonta
 *                                              423 / 409, y es el ÚNICO aborto con la transacción abierta
 * ```
 *
 * ── `preview` NO ESCRIBE, y eso es una propiedad, no una promesa (D5) ──────
 * `preview` no menciona `this.prisma` en ninguna línea: corre admisión, lector
 * y pre-vuelo sobre el `Buffer` y devuelve el reporte con el `sha256` de los
 * bytes CRUDOS. Cero consultas, cero filas, ninguna transacción abierta. La
 * razón de que pueda ser sin estado es que el parseo es determinista (no hay
 * contadores, no hay timestamps, las posiciones y el auto-layout salen del
 * orden del documento — D8/D9), así que el `confirm` re-parsea y reproduce el
 * mismo plan. Lo que la falta de estado NO puede garantizar es que el archivo
 * del confirm sea el que se previsualizó; eso lo cierra el `contentDigest`.
 *
 * ── El orden del nivel C, y por qué es ese (D10, D11) ─────────────────────
 * El rol lo evalúa el guard ANTES de todo esto (`xmi.import` es HOST-only),
 * así que un PARTICIPANT recibe `403` y nunca ve un `423`: el estado del
 * diagrama no se filtra a quien no puede operarlo. Después:
 *
 *   1. `diagram_deleted`  → el destino ya no está (borrado entre medio).
 *   2. `lock_state_changed` → el destino cambió de estado DESPUÉS de que esta
 *      misma petición lo leyó: es la carrera del preview, y se falla cerrado
 *      con `409 target_changed` en vez de importar algo distinto de lo que la
 *      pantalla prometió.
 *   3. `423 diagram_frozen` → ya estaba congelado cuando la petición llegó.
 *      El host que congeló el diagrama se come su propio `423`: el congelado
 *      es de solo lectura «para todos, el host incluido».
 *   4. `xmi_id_appeared` → un `xmi:id` entrante apareció en el destino entre
 *      las dos lecturas de esta misma petición.
 *   5. `xmi_id_already_present` → un `xmi:id` entrante ya estaba en el destino.
 *      Reconciliar es FR-E23 (`Should`, fuera de alcance): cuando entre, ESTA
 *      rama de rechazo pasa a ser la rama de merge y no se toca nada más.
 *
 * En modo `'new'` las cinco son inalcanzables por construcción: el diagrama
 * nace dentro de la MISMA transacción, vacío y `UNLOCKED`.
 */
@Injectable()
export class XmiImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admission: XmiAdmissionService,
  ) {}

  /**
   * Admisión → lector → pre-vuelo. Sin base, sin escritura, sin transacción:
   * exactamente el mismo camino que corre el `confirm`, por eso el plan que
   * devuelve el preview es el que se va a escribir (D5).
   */
  private parse(buffer: Buffer): { model: ParsedModel; plan: ReturnType<typeof runImportPreflight> } {
    try {
      const model = readXmiModel(this.admission.admit(buffer));
      return { model, plan: runImportPreflight(model) };
    } catch (error) {
      if (error instanceof XmiAdmissionError) throw toHttpException(error);
      throw error;
    }
  }

  /**
   * Tarea 4.3 — `POST .../import/xmi/preview` y su gemela en modo existente.
   * Todo lo que devuelve es un hecho sobre los bytes entrantes y el plan en
   * memoria. **Ninguna consulta, ninguna fila, ningún `BEGIN`.**
   */
  async preview(buffer: Buffer, target: ImportTarget): Promise<XmiImportPreview> {
    const { model, plan } = this.parse(buffer);
    return {
      contentDigest: contentDigestOf(buffer),
      detectedVersion: model.version,
      sourceEncoding: model.sourceEncoding,
      exporter: model.exporter,
      counts: plan.counts,
      // FR-E15 se llena implementando FR-E23 (reconciliación), que está
      // pre-recortada. El campo existe —y vale 0— para que el contrato no
      // cambie cuando entre; inventar la columna con este dato sería peor.
      matchedExisting: 0,
      unsupported: [...plan.unsupported],
      warnings: [...plan.warnings],
      target:
        target.diagramId === null
          ? { mode: 'new', suggestedName: suggestedDiagramName(target.sourceFilename) }
          : { mode: 'existing', diagramId: target.diagramId },
    };
  }

  /**
   * Tarea 4.4 — el confirm transaccional (FR-E17).
   *
   * El `contentDigest` se revalida ANTES del `BEGIN`: si el archivo reenviado
   * no es el previsualizado, no se abre nada y no se escribe nada. Es una
   * comparación de 64 caracteres, no un estado persistido (D5).
   */
  async confirm(buffer: Buffer, request: ImportConfirmRequest): Promise<XmiImportResult> {
    const actual = contentDigestOf(buffer);
    if (actual !== request.contentDigest) {
      throw new ConflictException({
        code: XMI_IMPORT_ERROR.PREVIEW_MISMATCH,
        message: 'el archivo reenviado no coincide con el que se previsualizó: volvé a previsualizar antes de confirmar',
        expected: request.contentDigest,
        actual,
      });
    }

    const { model, plan } = this.parse(buffer);

    // Estado del destino tal como lo vio ESTA petición, para poder distinguir
    // «está congelado» (423) de «se congeló mientras confirmaba» (409).
    const before = request.diagramId === null ? null : await this.readDestination(this.prisma, request.diagramId);

    return this.prisma.$transaction(
      async (tx) => {
        const diagramId =
          request.diagramId === null
            ? await this.createDestination(tx, request)
            : await this.assertExistingDestination(tx, request.diagramId, before as DestinationSnapshot, plan.incomingXmiIds);

        const written = await writeImportPlan(tx, plan, diagramId);

        const row = await tx.xmiImport.create({
          data: {
            diagramId,
            userId: request.actorId,
            sourceFilename: request.sourceFilename,
            detectedVersion: PRISMA_XMI_VERSION[model.version],
            sourceEncoding: model.sourceEncoding,
            exporter: model.exporter,
            elementCount: written.elementCount,
            unsupported: [...plan.unsupported] as unknown as Prisma.InputJsonValue,
            warnings: [...plan.warnings] as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });

        return {
          importId: row.id,
          diagramId,
          elementCount: written.elementCount,
          unsupported: [...plan.unsupported],
          warnings: [...plan.warnings],
        };
      },
      // `timeout` explícito: un import grande escribe miles de filas en una
      // sola transacción, y el default de 5 s de Prisma convertiría un archivo
      // legítimamente grande en un `P2028` a mitad de camino.
      { timeout: 120_000, maxWait: 10_000 },
    );
  }

  /** Modo `'new'` (D10): el diagrama nace DENTRO de la transacción, vacío y `UNLOCKED`. */
  private async createDestination(tx: Tx, request: ImportConfirmRequest): Promise<string> {
    const diagram = await tx.diagram.create({
      data: { projectId: request.projectId, name: request.diagramName ?? suggestedDiagramName(request.sourceFilename) },
      select: { id: true },
    });
    return diagram.id;
  }

  /**
   * Modo `'existing'` (nivel C). Devuelve el id del destino o lanza: es el
   * único lugar del backend que hoy responde `423` (D10 — `lockState` se leía
   * para mostrar y nadie lo hacía cumplir).
   */
  private async assertExistingDestination(
    tx: Tx,
    diagramId: string,
    before: DestinationSnapshot,
    incomingXmiIds: readonly string[],
  ): Promise<string> {
    const after = await this.readDestination(tx, diagramId);
    const change = detectTargetChange(before, after, incomingXmiIds);

    if (change === 'diagram_deleted') {
      throw targetChanged('diagram_deleted', `el diagrama destino ${diagramId} se borró entre el preview y el confirm`);
    }
    if (change === 'lock_state_changed') {
      throw targetChanged('lock_state_changed', `el diagrama destino pasó de ${before.lockState ?? 'inexistente'} a ${after.lockState ?? 'inexistente'} mientras se confirmaba el import`);
    }
    if (after.lockState !== 'UNLOCKED') {
      throw new HttpException(
        {
          code: XMI_IMPORT_ERROR.DIAGRAM_FROZEN,
          message: 'el diagrama destino está congelado: el congelado es de solo lectura para todos, el host incluido',
          lockState: after.lockState,
        },
        423,
      );
    }
    if (change === 'xmi_id_appeared') {
      throw targetChanged('xmi_id_appeared', 'aparecieron xmi:id en el destino que colisionan con los del archivo');
    }

    const collision = findXmiIdCollision(incomingXmiIds, after.xmiIds);
    if (collision !== null) {
      throw new ConflictException({
        code: XMI_IMPORT_ERROR.XMI_ID_ALREADY_PRESENT,
        message: `el xmi:id "${collision}" ya existe en el diagrama destino`,
        xmiId: collision,
      });
    }
    return diagramId;
  }

  /**
   * Snapshot del destino: el diagrama y los `xmi:id` de las SEIS tablas que
   * tienen la columna (FR-E14). Se lee dos veces por confirm —fuera y dentro de
   * la transacción— porque la comparación entre las dos lecturas es lo único
   * que distingue un estado estable de una carrera (D11).
   */
  private async readDestination(client: Tx, diagramId: string): Promise<DestinationSnapshot> {
    const diagram = await client.diagram.findUnique({
      where: { id: diagramId },
      select: { id: true, deletedAt: true, lockState: true },
    });
    if (diagram === null || diagram.deletedAt !== null) {
      return { mode: 'existing', diagramId, exists: false, lockState: null, xmiIds: [] };
    }

    const [elements, features, parameters, literals, relationships, ends] = await Promise.all([
      client.umlElement.findMany({ where: { diagramId }, select: { xmiId: true } }),
      client.umlFeature.findMany({ where: { owner: { diagramId } }, select: { xmiId: true } }),
      client.umlParameter.findMany({ where: { operation: { owner: { diagramId } } }, select: { xmiId: true } }),
      client.umlEnumLiteral.findMany({ where: { enumeration: { diagramId } }, select: { xmiId: true } }),
      client.umlRelationship.findMany({ where: { diagramId }, select: { xmiId: true } }),
      client.umlRelationshipEnd.findMany({ where: { relationship: { diagramId } }, select: { xmiId: true } }),
    ]);

    const xmiIds = [...elements, ...features, ...parameters, ...literals, ...relationships, ...ends]
      .map((row) => row.xmiId)
      .filter((xmiId): xmiId is string => xmiId !== null);

    return { mode: 'existing', diagramId, exists: true, lockState: diagram.lockState, xmiIds };
  }
}

export interface ImportTarget {
  readonly projectId: string;
  /** `null` = modo «diagrama nuevo», el default de C5 (D10). */
  readonly diagramId: string | null;
  readonly sourceFilename: string;
}

export interface ImportConfirmRequest extends ImportTarget {
  /** `sha256` de los bytes crudos que devolvió el preview (D5). */
  readonly contentDigest: string;
  /** Nombre del diagrama nuevo, tal como lo editó el usuario. Ignorado en modo existente. */
  readonly diagramName: string | null;
  readonly actorId: string;
}

/** `sha256` de los bytes CRUDOS, en hex. `node:crypto`, cero dependencias (D5). */
export function contentDigestOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * El contrato dice `'2.1' | '2.5.1'` (es lo que viaja por HTTP y lo que se
 * muestra); la columna es un enum de Postgres (`XMI_2_1` / `XMI_2_5_1`). Los
 * dos espacios de nombres NO coinciden y la traducción vive acá, en un solo
 * mapa: derivarla con un `replace` haría que un valor nuevo del contrato se
 * escribiera mal en silencio.
 */
const PRISMA_XMI_VERSION: Readonly<Record<XmiVersion, PrismaXmiVersion>> = {
  '2.1': 'XMI_2_1',
  '2.5.1': 'XMI_2_5_1',
};

/**
 * Nombre sugerido del diagrama destino, derivado del archivo (wireframe C5:
 * `VentasModel.xml` → algo que el usuario puede editar). Se respeta el tope de
 * 120 del DTO de diagramas: un nombre más largo no llegaría a guardarse.
 */
export function suggestedDiagramName(sourceFilename: string): string {
  const base = sourceFilename.replace(/\\/g, '/').split('/').pop() ?? sourceFilename;
  const withoutExtension = base.replace(/\.[^.]+$/, '').trim();
  const stem = withoutExtension.length > 0 ? withoutExtension : 'Modelo';
  const suffix = ' (importado)';
  const room = 120 - suffix.length;
  return `${stem.length > room ? stem.slice(0, room).trimEnd() : stem}${suffix}`;
}

/** El motivo viaja en el cuerpo: el cliente tiene que poder decir QUÉ cambió, no «conflicto». */
function targetChanged(reason: 'lock_state_changed' | 'xmi_id_appeared' | 'diagram_deleted', message: string): ConflictException {
  return new ConflictException({ code: XMI_IMPORT_ERROR.TARGET_CHANGED, reason, message });
}

/**
 * Nivel A → HTTP. El estado lo fija el contrato (`XMI_IMPORT_ERROR_STATUS`),
 * igual criterio que `XMI_ERROR_STATUS` del export: un mapa en el contrato y
 * ninguna tabla de estados duplicada en el camino de la respuesta.
 */
export function toHttpException(error: XmiAdmissionError): HttpException {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.format === undefined ? {} : { format: error.format }),
    ...(error.limitBytes === undefined ? {} : { limitBytes: error.limitBytes }),
  };
  switch (XMI_IMPORT_ERROR_STATUS[error.code]) {
    case 413:
      return new PayloadTooLargeException(body);
    case 415:
      return new UnsupportedMediaTypeException(body);
    case 422:
      return new UnprocessableEntityException(body);
    default:
      return new ConflictException(body);
  }
}

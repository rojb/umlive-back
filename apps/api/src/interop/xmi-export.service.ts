import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  XMI_ERROR,
  XMI_ERROR_STATUS,
  XMI_EXPORT_NOTE,
  type DiagramContent,
  type XmiExportNote,
  type XmiExportRequest,
  type XmiExportResponse,
  type XmiExportScope,
} from '@umlive/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DiagramContentService } from '../uml/diagram-content.service';
import { XmiEmitter } from './xmi-emitter';
import { IdentityMap } from './xmi-identity';
import { assertInvariants, assertOrderContract, XmiExportError } from './xmi-invariants';
import { serializeModel } from './xmi-serializer';
import { emitPrimitiveTypesPackage, TypeResolver } from './xmi-types';
import { versionStrategyFor } from './xmi-version-strategy';

/**
 * Orquestador del export (tarea 1.5, cableado real en 2.8).
 *
 * Alcance (D11): un diagrama, o TODOS los diagramas vivos del proyecto. En
 * alcance de proyecto NO se deduplica nada: `uml_elements.diagram_id` es
 * `NOT NULL` y toda la unicidad es por diagrama, así que dos diagramas que
 * «conceptualmente» comparten `Cliente` tienen dos filas con dos UUID y, tras
 * exportar, dos `xmi:id` distintos. Inventar la deduplicación por nombre
 * rompería el ida y vuelta sin pérdida. El reporte lo declara.
 *
 * Se inyecta `PrismaService` DIRECTO (`PrismaModule` es `@Global()`): las seis
 * tablas se leen para el `IdentityMap` (D2) sin agregar un método a
 * `DiagramContentService`, que es un archivo que M3 también consume.
 *
 * El pipeline es D8 → `IdentityMap` → `TypeResolver` → emisión → G1:
 * 1. `assertOrderContract` afirma el supuesto del que depende el determinismo.
 * 2. `IdentityMap.build` resuelve TODA la identidad antes de emitir; una
 *    colisión corta acá, con CERO bytes escritos (D2).
 * 3. `TypeResolver.build` conoce los tipos sintéticos antes del primer byte
 *    (el paquete `UMLIVE_TYPES` va primero en el documento).
 * 4. La emisión es el prólogo + el paquete de tipos + los diagramas.
 * 5. G1 valida los bytes emitidos.
 *
 * Solo lectura: no escribe una fila, no muta un `xmi_id`.
 */
@Injectable()
export class XmiExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly diagrams: DiagramContentService,
  ) {}

  async export(projectId: string, diagramId: string | undefined, request: XmiExportRequest): Promise<XmiExportResponse> {
    try {
      return await this.build(projectId, diagramId, request);
    } catch (error) {
      if (error instanceof XmiExportError) throw toHttpException(error);
      throw error;
    }
  }

  private async build(projectId: string, diagramId: string | undefined, request: XmiExportRequest): Promise<XmiExportResponse> {
    const scope: XmiExportScope = diagramId === undefined ? 'PROJECT' : 'DIAGRAM';
    const strategy = versionStrategyFor(request.version);
    const contents = await this.resolveScope(projectId, diagramId);

    if (contents.length === 0) {
      throw new ConflictException({
        code: XMI_ERROR.EMPTY_SCOPE,
        message: `el proyecto ${projectId} no tiene diagramas vivos que exportar`,
      });
    }

    // 1) D8 — el exportador afirma lo que asume: cuatro colecciones
    //    estrictamente crecientes por su clave, o `500 order_contract_violated`.
    for (const content of contents) assertOrderContract(content);

    const diagramIds = contents.map((content) => content.diagram.id);

    // 2) D1/D2 — identidad completa ANTES del primer byte.
    const identity = IdentityMap.build(await this.loadIdentityScope(diagramIds));

    // 3) D3 — tipos sintéticos conocidos antes del primer byte.
    const references = contents.flatMap((content) => [
      ...content.features.map((feature) => ({ typeElementId: feature.typeElementId, typeName: feature.typeName })),
      ...content.parameters.map((parameter) => ({ typeElementId: parameter.typeElementId, typeName: parameter.typeName })),
    ]);
    const types = TypeResolver.build(references, identity);

    // 4) Emisión: prólogo → `uml:Model` → `UMLIVE_TYPES` (primero DENTRO del
    //    modelo, que es el nivel superior) → un paquete por diagrama.
    const emitter = new XmiEmitter(strategy);
    emitter.openDocument();
    emitter.openModel();
    emitPrimitiveTypesPackage(emitter, types);
    const outcome = serializeModel(emitter, { contents, identity, types });
    emitter.closeModel();
    emitter.closeDocument();
    const document = emitter.toXml();

    // 5) G1 — sobre los BYTES, no sobre el modelo en memoria.
    assertInvariants(document, strategy);

    const notes: XmiExportNote[] = [
      ...identity.notes(),
      ...types.notes(),
      ...outcome.notes,
      ...emitter.illegalCharNotes(),
    ];
    if (scope === 'PROJECT') notes.push(crossDiagramIdentityNote(contents));

    return {
      fileName: `${sanitize(await this.fileBaseName(projectId, contents, scope))}.xmi`,
      document,
      report: {
        version: strategy.version,
        scope,
        // Hecho sobre los BYTES: hasta que la Unidad 3 emita el bloque de
        // extensión, el documento no lo contiene aunque se pidiera encendido.
        eaExtensionIncluded: document.includes('xmi:Extension'),
        diagramIds,
        counts: {
          elements: outcome.counts.elements,
          relationships: outcome.counts.relationships,
          mintedXmiIds: identity.mintedXmiIds(),
          syntheticPrimitiveTypes: types.count(),
          associationClassesMerged: outcome.counts.associationClassesMerged,
        },
        notes,
      },
    };
  }

  /** D11: diagrama único, o `findMany({ projectId, deletedAt: null }, orderBy id asc)` + N+1 aceptado. */
  private async resolveScope(projectId: string, diagramId: string | undefined): Promise<DiagramContent[]> {
    if (diagramId !== undefined) return [await this.diagrams.getDiagramContent(diagramId)];

    const diagrams = await this.prisma.diagram.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    return Promise.all(diagrams.map((diagram) => this.diagrams.getDiagramContent(diagram.id)));
  }

  /**
   * Las seis tablas con `xmi_id`, filtradas a los diagramas del alcance. Una
   * sola pasada, en orden determinista, con los nombres justos para que una
   * colisión de D2 pueda nombrar las DOS filas.
   */
  private async loadIdentityScope(diagramIds: readonly string[]) {
    const [elements, features, parameters, enumLiterals, relationships, relationshipEnds, diagrams] = await Promise.all([
      this.prisma.umlElement.findMany({
        where: { diagramId: { in: [...diagramIds] } },
        select: { id: true, name: true, xmiId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.umlFeature.findMany({
        where: { owner: { diagramId: { in: [...diagramIds] } } },
        select: { id: true, name: true, xmiId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.umlParameter.findMany({
        where: { operation: { owner: { diagramId: { in: [...diagramIds] } } } },
        select: { id: true, name: true, xmiId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.umlEnumLiteral.findMany({
        where: { enumeration: { diagramId: { in: [...diagramIds] } } },
        select: { id: true, name: true, xmiId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.umlRelationship.findMany({
        where: { diagramId: { in: [...diagramIds] } },
        select: { id: true, name: true, xmiId: true, associationClassId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.umlRelationshipEnd.findMany({
        where: { relationship: { diagramId: { in: [...diagramIds] } } },
        select: { id: true, roleName: true, xmiId: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.diagram.findMany({
        where: { id: { in: [...diagramIds] } },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
    ]);

    return {
      elements,
      features,
      parameters,
      enumLiterals,
      relationships,
      // El nombre visible de un extremo es su rol; `uml_relationship_ends` no
      // tiene columna `name`.
      relationshipEnds: relationshipEnds.map((end) => ({ id: end.id, name: end.roleName, xmiId: end.xmiId })),
      diagrams,
    };
  }

  private async fileBaseName(projectId: string, contents: readonly DiagramContent[], scope: XmiExportScope): Promise<string> {
    if (scope === 'DIAGRAM') return contents[0]?.diagram.name ?? 'diagram';
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    return project?.name ?? 'project';
  }
}

/**
 * Alcance de proyecto: el reporte declara la ausencia de identidad cruzada y
 * LISTA los nombres repetidos entre diagramas, que es la parte que alguien va
 * a notar al abrir el archivo en EA (dos `Cliente`, dos `xmi:id`).
 */
function crossDiagramIdentityNote(contents: readonly DiagramContent[]): XmiExportNote {
  const appearances = new Map<string, number>();
  for (const content of contents) {
    for (const name of new Set(content.elements.map((element) => element.name).filter((name): name is string => name !== null))) {
      appearances.set(name, (appearances.get(name) ?? 0) + 1);
    }
  }
  const repeated = [...appearances.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    code: XMI_EXPORT_NOTE.NO_CROSS_DIAGRAM_IDENTITY,
    subjectId: null,
    detail:
      repeated.length === 0
        ? `alcance de proyecto con ${contents.length} diagramas: cada uno es su propio uml:Package y no se deduplica nada; no hay nombres repetidos entre diagramas`
        : `alcance de proyecto con ${contents.length} diagramas: cada uno es su propio uml:Package y no se deduplica nada; nombres repetidos entre diagramas (elementos de xmi:id distinto): ${repeated.join(', ')}`,
  };
}

/** `{nombre saneado}.xmi` — sin rutas, sin caracteres raros, sin vacío. */
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '');
  return cleaned.length > 0 ? cleaned : 'model';
}

/** El contrato fija el estado por código (`XMI_ERROR_STATUS`); acá solo se traduce a la excepción de Nest. */
function toHttpException(error: XmiExportError): HttpException {
  const body = { code: error.code, message: error.message, rows: error.rows.map((row) => ({ table: row.table, id: row.id, name: row.name })) };
  switch (XMI_ERROR_STATUS[error.code]) {
    case 409:
      return new ConflictException(body);
    case 422:
      return new UnprocessableEntityException(body);
    case 503:
      return new ServiceUnavailableException(body);
    default:
      return new InternalServerErrorException(body);
  }
}

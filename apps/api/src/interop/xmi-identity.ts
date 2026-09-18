import { XMI_ERROR, XMI_EXPORT_NOTE, type XmiExportNote } from '@umlive/contracts';
import { XmiExportError, type XmiIdRow } from './xmi-invariants';

/**
 * `IdentityMap` (D1/D2) — **el corazón del diseño**.
 *
 * Resuelve `(tabla, id interno) → xmi:id` en UNA pasada sobre las seis tablas
 * del alcance, ANTES de emitir un solo byte, con la redirección de D1 ya
 * aplicada y el guardián de unicidad adentro. Todo `xmi:id`/`xmi:idref` del
 * documento sale de acá.
 *
 * **Por qué antes y no durante**: fallar a mitad de la emisión obliga a
 * razonar sobre salida parcial. Construir el mapa entero primero es también lo
 * que hace posible D1 (la redirección necesita conocer todas las relaciones
 * antes de emitir el primer elemento) y D3 (el paquete de tipos sintéticos va
 * ANTES que los paquetes de diagrama, así que hay que conocer los tipos antes
 * de emitir).
 *
 * **D1 — la redirección vive acá y no en el emisor.** Cuando
 * `uml_relationships.association_class_id` apunta a un elemento, ese elemento
 * **deja de tener identidad propia** en el documento (su `xmi_id` es `NULL` en
 * la base). Todo `xmi:idref` que apuntaba a esa clase tiene que apuntar al
 * `xmi:id` de la RELACIÓN, y los sitios de `idref` son seis, no uno:
 * `memberEnd`, `general` de una `Generalization`, `client`/`supplier` de
 * `Dependency`/`Usage`/`InterfaceRealization`, el `type` de un atributo cuyo
 * `typeElementId` es esa clase, el `annotatedElement` de un comentario y el
 * `subject` de la forma en el bloque de extensión. En el emisor hay que
 * acordarse seis veces; en el mapa, una.
 *
 * **D2 — el guardián de unicidad falla antes de emitir.** Ningún `xmi_id` es
 * único en la base (`ix_elements_xmi` es un índice común, no `UNIQUE`). Se
 * mantiene `Map<xmi:id, {tabla, id, nombre}>` y una colisión lanza
 * `duplicate_xmi_id` nombrando las DOS filas, con cero bytes escritos. Nunca
 * un documento silenciosamente roto. Las filas redirigidas se EXCLUYEN del
 * guardián: su id es el de la relación, y registrarlas sería autodenunciarse.
 */

/** Prefijo de todo id acuñado. También es la pista que reporta `minted_prefix_in_stored_id`. */
export const MINTED_PREFIX = 'UMLIVE_';

/** Los nueve prefijos de E.3 reglas 2 y 3 (más `PT`, que agrega D3). */
export type XmiIdKind = 'EL' | 'EN' | 'RL' | 'FT' | 'PR' | 'LT' | 'PKG' | 'DG' | 'PT';

/** Fila mínima de una de las seis tablas con `xmi_id`. Nombres solo para el mensaje de colisión. */
export interface IdentityRow {
  id: string;
  name: string | null;
  xmiId: string | null;
}

export interface IdentityRelationshipRow extends IdentityRow {
  associationClassId: string | null;
}

export interface IdentityScope {
  elements: readonly IdentityRow[];
  features: readonly IdentityRow[];
  parameters: readonly IdentityRow[];
  enumLiterals: readonly IdentityRow[];
  relationships: readonly IdentityRelationshipRow[];
  relationshipEnds: readonly IdentityRow[];
  /** El diagrama no tiene columna `xmi_id`: siempre acuña, y siempre DOS ids (D1). */
  diagrams: readonly { id: string; name: string }[];
}

const TABLES = {
  elements: 'uml_elements',
  features: 'uml_features',
  parameters: 'uml_parameters',
  enumLiterals: 'uml_enum_literals',
  relationships: 'uml_relationships',
  relationshipEnds: 'uml_relationship_ends',
} as const;

export class IdentityMap {
  private readonly ids = new Map<string, string>();
  private readonly defined = new Map<string, XmiIdRow>();
  private readonly redirect = new Map<string, string>();
  private readonly suppressed = new Set<string>();
  private readonly packageIds = new Map<string, string>();
  private readonly diagramEntryIds = new Map<string, string>();
  private readonly collected: XmiExportNote[] = [];
  private minted = 0;

  private constructor() {}

  static build(scope: IdentityScope): IdentityMap {
    const map = new IdentityMap();

    // 1) Relaciones PRIMERO: la redirección de D1 necesita el xmi:id de la
    //    relación antes de decidir si la clase enlazada tiene identidad propia.
    for (const rel of scope.relationships) {
      const xmiId = map.register(TABLES.relationships, rel.id, rel.name, rel.xmiId, 'RL');
      if (rel.associationClassId !== null) {
        map.suppressed.add(rel.associationClassId);
        map.redirect.set(rel.associationClassId, xmiId);
      }
    }

    // 2) Elementos, salteando las clases suprimidas: pierden identidad propia.
    for (const row of scope.elements) {
      if (map.suppressed.has(row.id)) continue;
      map.register(TABLES.elements, row.id, row.name, row.xmiId, 'EL');
    }

    for (const row of scope.features) map.register(TABLES.features, row.id, row.name, row.xmiId, 'FT');
    for (const row of scope.parameters) map.register(TABLES.parameters, row.id, row.name, row.xmiId, 'PR');
    for (const row of scope.enumLiterals) map.register(TABLES.enumLiterals, row.id, row.name, row.xmiId, 'LT');
    for (const row of scope.relationshipEnds) map.register(TABLES.relationshipEnds, row.id, row.name, row.xmiId, 'EN');

    // 3) Diagramas: DOS ids distintos sobre el mismo UUID (D1). Reusar uno es
    //    un xmi:id duplicado — exactamente lo que E.3 regla 4 llama «un
    //    documento que valida y no significa nada».
    for (const diagram of scope.diagrams) {
      map.packageIds.set(diagram.id, map.register('diagrams(package)', diagram.id, diagram.name, null, 'PKG'));
      map.diagramEntryIds.set(diagram.id, map.register('diagrams(diagram)', diagram.id, diagram.name, null, 'DG'));
    }

    return map;
  }

  /** D1: para una clase ligada a una `AssociationClass`, devuelve el id de la RELACIÓN. */
  forElement(elementId: string): string | null {
    return this.redirect.get(elementId) ?? this.ids.get(`${TABLES.elements}:${elementId}`) ?? null;
  }

  /**
   * Igual que `forElement`, pero un id ausente es un bug nuestro (los extremos
   * de una relación son FK `Restrict`: existen y están en el diagrama). Un
   * `xmi:idref` colgado se rechaza con el código de G1 en vez de emitirse.
   */
  requireElement(elementId: string, context: string): string {
    const id = this.forElement(elementId);
    if (id === null) {
      throw new XmiExportError(
        XMI_ERROR.DANGLING_IDREF,
        `${context} apunta al elemento ${elementId}, que no está en el alcance del documento`,
      );
    }
    return id;
  }

  forRelationship(id: string): string | null {
    return this.ids.get(`${TABLES.relationships}:${id}`) ?? null;
  }

  forEnd(id: string): string | null {
    return this.ids.get(`${TABLES.relationshipEnds}:${id}`) ?? null;
  }

  forFeature(id: string): string | null {
    return this.ids.get(`${TABLES.features}:${id}`) ?? null;
  }

  forParameter(id: string): string | null {
    return this.ids.get(`${TABLES.parameters}:${id}`) ?? null;
  }

  forLiteral(id: string): string | null {
    return this.ids.get(`${TABLES.enumLiterals}:${id}`) ?? null;
  }

  packageId(diagramId: string): string {
    const id = this.packageIds.get(diagramId);
    if (id === undefined) throw this.missingDiagram(diagramId, 'paquete');
    return id;
  }

  diagramEntryId(diagramId: string): string {
    const id = this.diagramEntryIds.get(diagramId);
    if (id === undefined) throw this.missingDiagram(diagramId, 'entrada de extensión');
    return id;
  }

  /** ¿El `xmi:id` ya está definido por una fila del alcance? Lo usa `TypeResolver` (D3) para no duplicar. */
  hasDefined(xmiId: string): boolean {
    return this.defined.has(xmiId);
  }

  /** Clases cuya emisión separada se suprime porque su identidad es la de la relación. */
  suppressedElementIds(): ReadonlySet<string> {
    return this.suppressed;
  }

  mintedXmiIds(): number {
    return this.minted;
  }

  notes(): readonly XmiExportNote[] {
    return this.collected;
  }

  /**
   * Registra la fila bajo su `xmi:id`. Preserva el guardado (E.3 regla 2) o lo
   * acuña del UUID interno (regla 3), y falla si el valor ya está tomado.
   */
  private register(table: string, rowId: string, name: string | null, stored: string | null, kind: XmiIdKind): string {
    const key = `${table}:${rowId}`;
    const xmiId = stored ?? this.mint(rowId, kind, table);
    if (stored !== null && stored.startsWith(MINTED_PREFIX)) {
      this.collected.push({
        code: XMI_EXPORT_NOTE.MINTED_PREFIX_IN_STORED_ID,
        subjectId: stored,
        detail: `${table} ${rowId} ya traía un xmi_id con prefijo acuñado; se emite tal cual (E.3 regla 3 prohíbe regenerar identidad)`,
      });
    }

    const taken = this.defined.get(xmiId);
    if (taken !== undefined) {
      throw new XmiExportError(
        XMI_ERROR.DUPLICATE_XMI_ID,
        `dos filas del alcance producen el mismo xmi:id "${xmiId}": ${taken.table} ${taken.id} y ${table} ${rowId}`,
        [taken, { table, id: rowId, name }],
      );
    }

    this.defined.set(xmiId, { table, id: rowId, name });
    this.ids.set(key, xmiId);
    return xmiId;
  }

  private missingDiagram(diagramId: string, what: string): XmiExportError {
    return new XmiExportError(
      XMI_ERROR.DANGLING_IDREF,
      `no hay identidad de ${what} para el diagrama ${diagramId}: no estaba en el alcance del mapa`,
    );
  }

  /** Derivado PURO del UUID: cero contadores, cero timestamps, misma salida en toda corrida. */
  private mint(uuid: string, kind: XmiIdKind, table: string): string {
    const xmiId = `${MINTED_PREFIX}${kind}_${uuid.replace(/-/g, '').toUpperCase()}`;
    this.minted += 1;
    this.collected.push({
      code: XMI_EXPORT_NOTE.XMI_ID_MINTED,
      subjectId: xmiId,
      detail: `${table} ${uuid} no traía xmi_id: se acuñó del UUID interno`,
    });
    return xmiId;
  }
}

/**
 * Contrato del exportador XMI — M5, rebanada 1 de 4 (Unidad 1, tarea 1.2).
 *
 * Solo tipos y constantes, sin dependencias de ejecución (misma regla que
 * `auth.ts`, `projects.ts` y `operations.ts`). `apps/api` es CommonJS: este
 * archivo exige `npm --prefix packages/contracts run build` antes de compilar
 * el backend, o `apps/api` compila contra el `dist` viejo.
 *
 * Diseño: `openspec/changes/xmi-export/design.md` §3 (D4, D6, D10) y §5.
 * Especificación: `.../specs/xmi-export-backend/spec.md`.
 * Apéndice autoritativo del mapeo: `PRD.md` Apéndice E.2.
 */

/**
 * Versión de XMI a emitir. `2.5.1` es el default (FR-E02, design.md D10).
 *
 * `'2.1'` NO significa «el esqueleto de E.1»: ese bloque del PRD es una
 * captura de un export real de Enterprise Architect en `windows-1252`, no una
 * plantilla. El exportador emite UTF-8 en las dos versiones (FR-E05, D10).
 */
export type XmiVersion = '2.1' | '2.5.1';

/** `DIAGRAM` = un diagrama; `PROJECT` = todos los diagramas vivos del proyecto (D11). */
export type XmiExportScope = 'DIAGRAM' | 'PROJECT';

/**
 * Cuerpo de las dos rutas de export. Sin `projectId`/`diagramId`: el objetivo
 * viaja en la URL, nunca en el cuerpo (mismo criterio que las mutaciones).
 */
export interface XmiExportRequest {
  /** Default `'2.5.1'` (FR-E02). */
  version?: XmiVersion;
  /**
   * Default `true` (FR-E09). En `false` el documento no contiene ni una
   * ocurrencia de `xmi:Extension` (SC-E15) y sigue siendo válido.
   */
  includeEaExtension?: boolean;
}

/**
 * Las once decisiones no triviales que el documento NO puede expresar
 * (FR-E11). `stereotype_not_in_model` y `comment_without_annotated_element`
 * son las dos que la §3 del diseño declara; el resto son pérdidas o
 * sustituciones que serían silenciosas sin esta lista.
 */
export const XMI_EXPORT_NOTE = {
  /** `stereotype` no tiene fila en E.2: sin perfil UML declarado no es expresable. */
  STEREOTYPE_NOT_IN_MODEL: 'stereotype_not_in_model',
  /** `COMMENT` no tiene columna de anotación: `parent_id` es el contenedor, no lo anotado. */
  COMMENT_WITHOUT_ANNOTATED_ELEMENT: 'comment_without_annotated_element',
  /** `seqno` de la extensión EA acuñado, no leído de la base. */
  SEQNO_SYNTHESIZED: 'seqno_synthesized',
  /** `typeName` sin `typeElementId` resoluble: se sintetizó un `uml:PrimitiveType` (D3). */
  SYNTHETIC_PRIMITIVE_TYPE: 'synthetic_primitive_type',
  /** Alcance de proyecto: sin identidad de elemento entre diagramas (D11). */
  NO_CROSS_DIAGRAM_IDENTITY: 'no_cross_diagram_identity',
  /** La relación fusionada tenía nombre propio y difiere del de la clase (D5). */
  ASSOCIATION_CLASS_NAME_DISCARDED: 'association_class_name_discarded',
  /** Hijos de la clase asociación suprimida, reparentados al padre de esa clase (D5). */
  ASSOCIATION_CLASS_CHILDREN_REPARENTED: 'association_class_children_reparented',
  /** Carácter de control ilegal en XML 1.0 eliminado de un texto de usuario (D9). */
  ILLEGAL_XML_CHAR_STRIPPED: 'illegal_xml_char_stripped',
  /** Elemento sin fila en `element_layouts`: sin geometría en la extensión EA. */
  ELEMENT_WITHOUT_LAYOUT: 'element_without_layout',
  /** `xmi_id` guardado que ya empieza con `UMLIVE_`: se emite tal cual (E.3 regla 3). */
  MINTED_PREFIX_IN_STORED_ID: 'minted_prefix_in_stored_id',
  /** La fila no traía `xmi_id`: se acuñó uno derivado del UUID interno. */
  XMI_ID_MINTED: 'xmi_id_minted',
} as const;

export type XmiExportNoteCode = (typeof XMI_EXPORT_NOTE)[keyof typeof XMI_EXPORT_NOTE];

/**
 * `subjectId` es el `xmi:id` del elemento afectado (nunca el UUID interno —
 * el mismo espacio de nombres que ve el usuario en el archivo), o `null`
 * cuando la nota no tiene un sujeto único.
 */
export interface XmiExportNote {
  code: XmiExportNoteCode;
  subjectId: string | null;
  detail: string;
}

export interface XmiExportReport {
  version: XmiVersion;
  scope: XmiExportScope;
  /**
   * Si el documento entregado CONTIENE el bloque `xmi:Extension`. Es un hecho
   * sobre los bytes, no sobre lo que se pidió: hasta que la Unidad 3 emita el
   * bloque, vale `false` aunque `includeEaExtension` fuera `true`.
   */
  eaExtensionIncluded: boolean;
  diagramIds: string[];
  counts: {
    elements: number;
    relationships: number;
    mintedXmiIds: number;
    syntheticPrimitiveTypes: number;
    associationClassesMerged: number;
  };
  notes: XmiExportNote[];
}

export interface XmiExportResponse {
  /** `{nombre saneado}.xmi` — lo usa el cliente para el `download`. */
  fileName: string;
  /** El documento completo, ya validado por las dos compuertas. */
  document: string;
  report: XmiExportReport;
}

/**
 * Los nueve fallos propios del exportador. La mitad son bugs NUESTROS y por
 * eso duelen (500): un `idref` colgado, un documento mal formado, una versión
 * que no coincide con la estrategia pedida, una geometría mal armada o una
 * colección desordenada. Los otros cuatro son estados del cliente o del
 * entorno: colisión de identidad, alcance vacío, esquema y validador ausente.
 */
export const XMI_ERROR = {
  /** Dos filas del alcance producen el mismo `xmi:id` (D2). Se emiten CERO bytes. */
  DUPLICATE_XMI_ID: 'duplicate_xmi_id',
  /** El documento no valida contra el XSD vendorizado (FR-E04, G2). Sin campo `document`. */
  SCHEMA_INVALID: 'schema_invalid',
  /** El validador XSD no cargó al bootstrap: fail-closed, nunca export sin validar (D6). */
  XMI_VALIDATOR_UNAVAILABLE: 'xmi_validator_unavailable',
  /** El alcance resuelto no tiene ningún diagrama que exportar (D11). */
  EMPTY_SCOPE: 'empty_scope',
  /** G1: un `idref` que no resuelve a ningún `xmi:id` definido en el documento. */
  DANGLING_IDREF: 'dangling_idref',
  /** G1: `XMLValidator` de `fast-xml-parser` rechazó el documento (D9: primer uso real de la dependencia). */
  MALFORMED_OUTPUT: 'malformed_output',
  /** G1: `xmi:version` o los dos `xmlns` no coinciden con la estrategia pedida (D4). */
  VERSION_MISMATCH: 'version_mismatch',
  /** G1: una `geometry` sin las cuatro claves o sin el `;` final (E.4, D5). */
  MALFORMED_GEOMETRY: 'malformed_geometry',
  /** G1/D8: `elements`/`relationships`/`layouts`/`relationshipLayouts` fuera de orden estricto. */
  ORDER_CONTRACT_VIOLATED: 'order_contract_violated',
} as const;

export type XmiErrorCode = (typeof XMI_ERROR)[keyof typeof XMI_ERROR];

/**
 * Mapa ÚNICO de código a estado HTTP. Vive en el contrato, no en el
 * controlador, para que el cliente pueda decidir sin duplicar la tabla — igual
 * criterio que `PROJECT_PERMISSIONS` para la autorización.
 */
export const XMI_ERROR_STATUS: Record<XmiErrorCode, number> = {
  duplicate_xmi_id: 409,
  schema_invalid: 422,
  xmi_validator_unavailable: 503,
  empty_scope: 409,
  dangling_idref: 500,
  malformed_output: 500,
  version_mismatch: 500,
  malformed_geometry: 500,
  order_contract_violated: 500,
};

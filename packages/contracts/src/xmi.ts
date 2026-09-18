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

// ─────────────────────────────────────────────────────────────────────────────
// AMPLIADO por `xmi-import` (M5, rebanada 2 de 4 — Unidad 1, tarea 1.1)
// ─────────────────────────────────────────────────────────────────────────────
// AGREGADO sobre lo que crea `xmi-export`, mismo criterio aditivo de siempre:
// nada de lo declarado arriba cambia de valor ni desaparece. Diseño:
// `openspec/changes/xmi-import/design.md` §3 (contratos) y §D3/D4/D7/D8.
// Especificación: `.../specs/xmi-import-backend/spec.md`.
//
// `duplicate_xmi_id` se comparte con el exportador (mismo literal, mismo 409),
// pero el resto de los códigos del import NO reusa `XMI_ERROR_STATUS`: el
// `dangling_idref` del lector es un `422` del archivo entrante, mientras que el
// del escritor es un `500` de un bug propio. Dos mapas, una sola verdad por
// dirección.
// ─────────────────────────────────────────────────────────────────────────────

/** Codificación declarada en el prólogo del archivo entrante (D4). Nunca `latin1`. */
export type XmiSourceEncoding = 'UTF-8' | 'windows-1252';

/**
 * Límite duro de subida (FR-E06, D3). Vive en el contrato porque **tres**
 * consumidores tienen que decir el mismo número: el `limits.fileSize` de
 * multer, el cuerpo del `413` y el mensaje del modal C5.
 */
export const XMI_MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * Tope de nombre de los DTOs compartidos por HTTP y socket (hallazgo
 * `operations-pipeline` RW-4). Todo lo que CREA un nombre —este importador
 * incluido— lo respeta; un nombre más largo se reporta y nunca se escribe.
 */
export const XMI_IMPORT_NAME_MAX_LENGTH = 120;

/**
 * Por qué una construcción no soportada lo es. Cierra el conjunto: el cliente
 * muestra el `reason` y el `xmi:id`, y ninguno se inventa.
 *
 * `association_class_not_supported_yet` se conserva declarado —lo nombra la
 * especificación de la capacidad— aunque la partición real de D7 esté
 * implementada: la columna `association_class_id` existe y el lector parte el
 * `uml:AssociationClass` en dos filas. El código queda como el interruptor que
 * la especificación describe, no como el camino que se ejecuta.
 */
export const XMI_UNSUPPORTED_REASON = {
  UNSUPPORTED_CONSTRUCT: 'unsupported_construct',
  NARY_ASSOCIATION: 'nary_association',
  DUPLICATE_NAME_PER_PARENT: 'duplicate_name_per_parent',
  DUPLICATE_ATTRIBUTE_NAME: 'duplicate_attribute_name',
  DUPLICATE_PARAMETER_RETURN: 'duplicate_parameter_return',
  UNNAMED_ELEMENT: 'unnamed_element',
  SELF_GENERALIZATION: 'self_generalization',
  NAME_TOO_LONG: 'name_too_long',
  PRIMITIVE_TYPE_NAME_UNDECODABLE: 'primitive_type_name_undecodable',
  ASSOCIATION_CLASS_NOT_SUPPORTED_YET: 'association_class_not_supported_yet',
} as const;

export type XmiUnsupportedReason = (typeof XMI_UNSUPPORTED_REASON)[keyof typeof XMI_UNSUPPORTED_REASON];

/**
 * FR-E16 exige **nombre, tipo y `xmi:id`** de lo que no entra. El orden de los
 * campos deja `xmiId` primero a propósito: es el que sobrevive cuando el
 * nombre es `null` (un elemento sin nombre es legal en UML).
 */
export interface XmiUnsupportedItem {
  /** `null` solo cuando la construcción no tiene `xmi:id` propio. */
  xmiId: string | null;
  name: string | null;
  /** El `xmi:type` de origen (`uml:AssociationClass`, `uml:Interaction`, …). */
  type: string;
  reason: XmiUnsupportedReason;
  detail?: string;
}

/**
 * Degradaciones que NO pierden la fila (nivel B del diseño): la construcción
 * entra, pero con una diferencia anunciada. Cubre las políticas del pre-vuelo
 * de Fase 4 y las del lector de Fase 2/3.
 */
export const XMI_IMPORT_WARNING = {
  /** Geometría ausente, malformada, incompleta o con ancho/alto no positivo (D8). */
  DEGENERATE_GEOMETRY: 'degenerate_geometry',
  /** `aggregation="composite"` con `upperValue="*"` → degrada a `SHARED` (D2). */
  COMPOSITE_MULTIPLICITY_DEGRADED: 'composite_multiplicity_degraded',
  /** `isAbstract="true"` sobre `Enumeration`/`DataType` → degrada a `false` (D2). */
  ABSTRACT_NOT_ALLOWED: 'abstract_not_allowed',
  /** `lowerValue`/`upperValue` inválidos en una feature → degrada a `[0..*]` (D2). */
  FEATURE_MULTIPLICITY_DEGRADED: 'feature_multiplicity_degraded',
  /**
   * D7: la paternidad de una `AssociationClass` exportada es irrecuperable —
   * el XMI no conserva dónde colgaban sus hijos. Se anuncia en el import.
   */
  ASSOCIATION_CLASS_PARENTHOOD_NOT_RECOVERABLE: 'association_class_parenthood_not_recoverable',
  /** El `seqno` de EA (z-order) no tiene columna: se ignora y se dice (E.4). */
  SEQNO_IGNORED: 'seqno_ignored',
} as const;

export type XmiWarningCode = (typeof XMI_IMPORT_WARNING)[keyof typeof XMI_IMPORT_WARNING];

export interface XmiImportWarning {
  xmiId: string | null;
  name: string | null;
  code: XmiWarningCode;
  detail?: string;
}

/**
 * Preview sin estado (D5). CERO filas: es un hecho sobre los bytes entrantes y
 * el plan en memoria. `contentDigest` cierra el hueco entre preview y confirm
 * sin persistir nada.
 */
export interface XmiImportPreview {
  /** `sha256` de los bytes CRUDOS del archivo, en hex (D5). */
  contentDigest: string;
  detectedVersion: XmiVersion;
  sourceEncoding: XmiSourceEncoding;
  /** `xmi:Documentation/@exporter`, o `null` si el documento no lo trae. */
  exporter: string | null;
  counts: {
    classifiers: number;
    relationships: number;
    features: number;
    withGeometry: number;
    totalPositionable: number;
  };
  /**
   * FR-E15 · SIEMPRE `0` hasta FR-E23 (D9): el import CREA, no reconcilia.
   * El campo existe para que el merge lo llene sin cambiar el contrato.
   */
  matchedExisting: number;
  unsupported: XmiUnsupportedItem[];
  warnings: XmiImportWarning[];
  target: { mode: 'new'; suggestedName: string } | { mode: 'existing'; diagramId: string };
}

/** Respuesta del confirm exitoso (`201`). */
export interface XmiImportResult {
  importId: string;
  diagramId: string;
  elementCount: number;
  unsupported: XmiUnsupportedItem[];
  warnings: XmiImportWarning[];
}

/**
 * Los doce códigos propios del importador (diseño §3). `duplicate_xmi_id`
 * comparte literal con el exportador; el resto solo existe acá.
 */
export const XMI_IMPORT_ERROR = {
  FILE_TOO_LARGE: 'file_too_large',
  UNSUPPORTED_ENCODING: 'unsupported_encoding',
  NOT_UML_DOCUMENT: 'not_uml_document',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  MALFORMED_XML: 'malformed_xml',
  DANGLING_IDREF: 'dangling_idref',
  VERSION_UNDETECTABLE: 'version_undetectable',
  DUPLICATE_XMI_ID: 'duplicate_xmi_id',
  XMI_ID_ALREADY_PRESENT: 'xmi_id_already_present',
  TARGET_CHANGED: 'target_changed',
  PREVIEW_MISMATCH: 'preview_mismatch',
  DIAGRAM_FROZEN: 'diagram_frozen',
} as const;

export type XmiImportErrorCode = (typeof XMI_IMPORT_ERROR)[keyof typeof XMI_IMPORT_ERROR];

/**
 * Mapa ÚNICO de código a estado HTTP del import (mismo criterio que
 * `XMI_ERROR_STATUS`). Vive en el contrato para que el cliente decida sin
 * duplicar la tabla y para que el importador no tenga un `switch` escondido.
 */
export const XMI_IMPORT_ERROR_STATUS: Record<XmiImportErrorCode, number> = {
  file_too_large: 413,
  unsupported_encoding: 415,
  not_uml_document: 415,
  unsupported_format: 415,
  malformed_xml: 422,
  dangling_idref: 422,
  version_undetectable: 422,
  duplicate_xmi_id: 409,
  xmi_id_already_present: 409,
  target_changed: 409,
  preview_mismatch: 409,
  diagram_frozen: 423,
};

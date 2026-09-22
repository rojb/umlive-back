/**
 * `demo-dataset.ts` — el modelo del dataset de demostración (`odd/tasks/demo-dataset-parity.md`,
 * T1/T2) y las dos funciones puras que lo convierten en bytes XMI.
 *
 * **Módulo de datos, no un script.** Lo importa `seed-demo-dataset.ts`; no tiene
 * `main()` propio y no se corre solo.
 *
 * ── Qué declara ──────────────────────────────────────────────────────────
 * `PROJECT_SPECS`: tres proyectos («Ventas», «Biblioteca», «Clínica»), dos
 * diagramas cada uno, en español, con clases de atributos siempre tipados
 * (ninguno se llama `id`: el generador lo inyecta solo) y asociaciones con
 * multiplicidades ortodoxas (`1`, `0..1`, `0..*`, `1..*`). Ninguna asociación
 * usa `COMPOSITE` ni `GENERALIZATION`, ninguna clase es `INTERFACE`: las
 * cinco reglas bloqueantes de `packages/contracts/src/uml.ts:737-781`
 * (`generalization_cycle`, `interface_instance_attribute`,
 * `duplicate_feature_signature`, `composite_multiplicity`,
 * `dangling_relationship_end`) quedan fuera de alcance por construcción, no
 * por suerte.
 *
 * ── Cómo se emite el XMI ────────────────────────────────────────────────
 * `emitXmiDocument` reproduce EXACTAMENTE el pipeline de
 * `src/interop/xmi-export.service.ts` (`assertOrderContract` →
 * `IdentityMap.build` → `TypeResolver.build` → `XmiEmitter` →
 * `serializeModel` → `emitEaExtension` → `assertInvariants`), la misma
 * técnica que `scripts/mobile-fixture-backend.ts` usa para `buildIr`: nada
 * de esto toca Prisma. El `IdentityScope` que alimenta a `IdentityMap` se
 * arma a mano a partir del `DiagramContent` en memoria, con `xmiId: null`
 * en las seis filas — todo se acuña, que es exactamente lo que pasa en un
 * diagrama que nunca tuvo un `xmi_id` guardado.
 *
 * **No corre `XsdValidatorService`** (esa pieza necesita el XSD vendorizado
 * y vive detrás de inyección de Nest): la prueba real de que el documento es
 * importable es que el importador de la propia API lo acepte, y eso lo hace
 * `seed-demo-dataset.ts` contra el servidor vivo, no este módulo.
 */

import { randomUUID } from 'node:crypto';
import type {
  DiagramContent,
  DiagramSummary,
  ElementLayoutView,
  RelationshipKind,
  UmlElementView,
  UmlFeatureView,
  UmlRelationshipEndView,
  UmlRelationshipView,
} from '@umlive/contracts';
import { DEFAULT_INCLUDE_EA_EXTENSION, emitEaExtension } from '../src/interop/ea-extension';
import { XmiEmitter } from '../src/interop/xmi-emitter';
import { IdentityMap, type IdentityScope } from '../src/interop/xmi-identity';
import { assertInvariants, assertOrderContract } from '../src/interop/xmi-invariants';
import { serializeModel } from '../src/interop/xmi-serializer';
import { emitPrimitiveTypesPackage, TypeResolver } from '../src/interop/xmi-types';
import { XMI_2_5_1 } from '../src/interop/xmi-version-strategy';

/** Fijo: `buildIr`/el emisor no leen el reloj y esto mantiene la corrida reproducible. */
const STAMP = '2026-09-22T00:00:00.000Z';

// ─────────────────────────────────────────────────────────────────────────────
// Modelo — un `ClassSpec`/`AssociationSpec` por diagrama, en español
// ─────────────────────────────────────────────────────────────────────────────

/** Un atributo UML. `type` tiene que ser uno de los 9 nombres canónicos de `type-mapping.ts`; `lower` es la cota inferior (0 = opcional/nullable, 1 = obligatorio). */
export interface AttributeSpec {
  name: string;
  type: string;
  lower: 0 | 1;
}

export interface ClassSpec {
  name: string;
  attributes: AttributeSpec[];
}

/** Un extremo de asociación. `upper: null` es `*`. Solo se usan las cuatro combinaciones ortodoxas del brief: `1`, `0..1`, `0..*`, `1..*`. */
export interface EndSpec {
  lower: 0 | 1;
  upper: 1 | null;
}

/**
 * `source` siempre es el lado «uno» (`upper: 1`) y `target` el lado «muchos»
 * (`upper: null`): la FK cae en `target`, `source` recibe la colección — el
 * mismo convenio que `scripts/mobile-fixture-backend.ts` usa para
 * `Cliente 1 — * Cita`.
 */
export interface AssociationSpec {
  source: string;
  target: string;
  sourceEnd: EndSpec;
  targetEnd: EndSpec;
}

export interface DiagramSpec {
  name: string;
  classes: ClassSpec[];
  associations: AssociationSpec[];
}

export interface ProjectSpec {
  name: string;
  description: string;
  diagrams: DiagramSpec[];
}

const t = (name: string, type: string, lower: 0 | 1): AttributeSpec => ({ name, type, lower });
const uno: EndSpec = { lower: 1, upper: 1 };
const unoOpcional: EndSpec = { lower: 0, upper: 1 };
const muchos: EndSpec = { lower: 0, upper: null };
const algunoOMas: EndSpec = { lower: 1, upper: null };

export const PROJECT_SPECS: ProjectSpec[] = [
  {
    name: 'Ventas',
    description: 'Ventas, clientes y control de inventario.',
    diagrams: [
      {
        name: 'Ventas',
        classes: [
          {
            name: 'Cliente',
            attributes: [t('nombre', 'String', 1), t('email', 'String', 0), t('telefono', 'String', 0)],
          },
          { name: 'Venta', attributes: [t('fecha', 'LocalDate', 1), t('total', 'BigDecimal', 1)] },
          {
            name: 'DetalleVenta',
            attributes: [t('cantidad', 'Integer', 1), t('precioUnitario', 'BigDecimal', 1)],
          },
          {
            name: 'Producto',
            attributes: [t('nombre', 'String', 1), t('precio', 'BigDecimal', 1), t('stock', 'Integer', 1)],
          },
          { name: 'Categoria', attributes: [t('nombre', 'String', 1), t('descripcion', 'String', 0)] },
        ],
        associations: [
          // Un cliente hace varias ventas.
          { source: 'Cliente', target: 'Venta', sourceEnd: uno, targetEnd: muchos },
          // Toda venta trae al menos un detalle.
          { source: 'Venta', target: 'DetalleVenta', sourceEnd: uno, targetEnd: algunoOMas },
          // Un producto aparece en muchos detalles.
          { source: 'Producto', target: 'DetalleVenta', sourceEnd: uno, targetEnd: muchos },
          // Una categoría agrupa varios productos.
          { source: 'Categoria', target: 'Producto', sourceEnd: uno, targetEnd: muchos },
        ],
      },
      {
        name: 'Inventario',
        classes: [
          { name: 'Proveedor', attributes: [t('nombre', 'String', 1), t('contacto', 'String', 0)] },
          { name: 'Almacen', attributes: [t('nombre', 'String', 1), t('ubicacion', 'String', 0)] },
          { name: 'Existencia', attributes: [t('cantidad', 'Integer', 1)] },
          {
            name: 'MovimientoInventario',
            attributes: [t('fecha', 'LocalDate', 1), t('tipo', 'String', 1), t('cantidad', 'Integer', 1)],
          },
        ],
        associations: [
          // Un proveedor origina varios movimientos.
          { source: 'Proveedor', target: 'MovimientoInventario', sourceEnd: uno, targetEnd: muchos },
          // Un almacén guarda varias existencias.
          { source: 'Almacen', target: 'Existencia', sourceEnd: uno, targetEnd: muchos },
          // Un movimiento puede no tener almacén asignado todavía (opcional).
          { source: 'Almacen', target: 'MovimientoInventario', sourceEnd: unoOpcional, targetEnd: muchos },
        ],
      },
    ],
  },
  {
    name: 'Biblioteca',
    description: 'Catálogo de libros y préstamos a socios.',
    diagrams: [
      {
        name: 'Catalogo',
        classes: [
          { name: 'Editorial', attributes: [t('nombre', 'String', 1), t('pais', 'String', 0)] },
          { name: 'Autor', attributes: [t('nombre', 'String', 1), t('nacionalidad', 'String', 0)] },
          {
            name: 'Libro',
            attributes: [t('titulo', 'String', 1), t('anioPublicacion', 'Integer', 0), t('isbn', 'String', 1)],
          },
          {
            name: 'Ejemplar',
            attributes: [t('codigoInventario', 'String', 1), t('disponible', 'Boolean', 1)],
          },
        ],
        associations: [
          // Una editorial publica varios libros.
          { source: 'Editorial', target: 'Libro', sourceEnd: uno, targetEnd: muchos },
          // Un autor firma varios libros.
          { source: 'Autor', target: 'Libro', sourceEnd: uno, targetEnd: muchos },
          // Todo libro tiene al menos un ejemplar físico.
          { source: 'Libro', target: 'Ejemplar', sourceEnd: uno, targetEnd: algunoOMas },
        ],
      },
      {
        name: 'Prestamos',
        classes: [
          { name: 'Socio', attributes: [t('nombre', 'String', 1), t('email', 'String', 0)] },
          {
            name: 'Prestamo',
            attributes: [t('fechaInicio', 'LocalDate', 1), t('fechaDevolucion', 'LocalDate', 0)],
          },
          { name: 'Reserva', attributes: [t('fecha', 'LocalDate', 1), t('estado', 'String', 1)] },
          { name: 'Sancion', attributes: [t('motivo', 'String', 1), t('monto', 'BigDecimal', 1)] },
        ],
        associations: [
          // Un socio hace varios préstamos.
          { source: 'Socio', target: 'Prestamo', sourceEnd: uno, targetEnd: muchos },
          // Un socio hace varias reservas.
          { source: 'Socio', target: 'Reserva', sourceEnd: uno, targetEnd: muchos },
          // Un socio puede acumular sanciones.
          { source: 'Socio', target: 'Sancion', sourceEnd: uno, targetEnd: muchos },
          // Una sanción puede (o no) venir de un préstamo puntual.
          { source: 'Prestamo', target: 'Sancion', sourceEnd: unoOpcional, targetEnd: muchos },
        ],
      },
    ],
  },
  {
    name: 'Clinica',
    description: 'Historia clínica de pacientes y agenda de turnos.',
    diagrams: [
      {
        name: 'Pacientes',
        classes: [
          {
            name: 'Paciente',
            attributes: [t('nombre', 'String', 1), t('fechaNacimiento', 'LocalDate', 1), t('telefono', 'String', 0)],
          },
          { name: 'HistoriaClinica', attributes: [t('numero', 'String', 1), t('observaciones', 'String', 0)] },
          { name: 'Consulta', attributes: [t('fecha', 'LocalDate', 1), t('diagnostico', 'String', 0)] },
          { name: 'Medico', attributes: [t('nombre', 'String', 1), t('especialidad', 'String', 1)] },
        ],
        associations: [
          // Un paciente abre varias historias clínicas (una por internación/episodio).
          { source: 'Paciente', target: 'HistoriaClinica', sourceEnd: uno, targetEnd: muchos },
          // Una historia clínica acumula varias consultas.
          { source: 'HistoriaClinica', target: 'Consulta', sourceEnd: uno, targetEnd: muchos },
          // Un médico atiende varias consultas.
          { source: 'Medico', target: 'Consulta', sourceEnd: uno, targetEnd: muchos },
        ],
      },
      {
        name: 'Agenda',
        classes: [
          { name: 'Especialidad', attributes: [t('nombre', 'String', 1), t('descripcion', 'String', 0)] },
          { name: 'Consultorio', attributes: [t('numero', 'String', 1), t('piso', 'Integer', 1)] },
          {
            name: 'Turno',
            attributes: [t('fecha', 'LocalDate', 1), t('hora', 'String', 1), t('estado', 'String', 1)],
          },
          {
            name: 'Horario',
            attributes: [t('diaSemana', 'String', 1), t('horaInicio', 'String', 1), t('horaFin', 'String', 1)],
          },
        ],
        associations: [
          // Una especialidad agrupa varios turnos.
          { source: 'Especialidad', target: 'Turno', sourceEnd: uno, targetEnd: muchos },
          // Un consultorio aloja varios turnos.
          { source: 'Consultorio', target: 'Turno', sourceEnd: uno, targetEnd: muchos },
          // Un consultorio tiene varios horarios disponibles.
          { source: 'Consultorio', target: 'Horario', sourceEnd: uno, targetEnd: muchos },
        ],
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// T1 — `DiagramSpec` → `DiagramContent` (misma técnica que `mobile-fixture-backend.ts`)
// ─────────────────────────────────────────────────────────────────────────────

function classElement(id: string, diagramId: string, name: string): UmlElementView {
  return {
    id,
    diagramId,
    parentId: null,
    kind: 'CLASS',
    name,
    isAbstract: false,
    stereotype: null,
    body: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function attributeFeature(id: string, ownerId: string, attribute: AttributeSpec, position: number): UmlFeatureView {
  return {
    id,
    ownerId,
    kind: 'ATTRIBUTE',
    name: attribute.name,
    visibility: 'PRIVATE',
    typeElementId: null,
    typeName: attribute.type,
    lowerBound: attribute.lower,
    upperBound: 1,
    position,
    defaultValue: null,
    isStatic: false,
    isReadonly: false,
    isDerived: false,
    isAbstract: false,
    isQuery: false,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

/** Arma un `DiagramContent` completo en memoria — cero filas, cero Prisma. */
export function buildDiagramContent(spec: DiagramSpec): DiagramContent {
  const diagramId = randomUUID();
  const diagram: DiagramSummary = {
    id: diagramId,
    name: spec.name,
    lockState: 'UNLOCKED',
    currentVersion: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
    freeze: null,
  };

  const elements: UmlElementView[] = [];
  const features: UmlFeatureView[] = [];
  const layouts: ElementLayoutView[] = [];
  const elementIdByName = new Map<string, string>();

  spec.classes.forEach((cls, classIndex) => {
    // `el-1`, `el-2`, … — nunca dos dígitos: assertOrderContract exige orden
    // estrictamente creciente por comparación de strings, y "el-10" < "el-2".
    // Con ≤5 clases por diagrama esto no se acerca al límite.
    const elementId = `el-${classIndex + 1}`;
    elementIdByName.set(cls.name, elementId);
    elements.push(classElement(elementId, diagramId, cls.name));
    layouts.push({
      elementId,
      x: (classIndex % 3) * 260,
      y: Math.floor(classIndex / 3) * 200,
      width: 220,
      height: 150,
      zIndex: classIndex,
    });
    cls.attributes.forEach((attribute, attributeIndex) => {
      features.push(attributeFeature(`feat-${classIndex + 1}-${attributeIndex + 1}`, elementId, attribute, attributeIndex));
    });
  });

  const relationships: UmlRelationshipView[] = [];
  const relationshipEnds: UmlRelationshipEndView[] = [];

  spec.associations.forEach((assoc, relIndex) => {
    const relId = `rel-${relIndex + 1}`;
    const sourceElementId = elementIdByName.get(assoc.source);
    const targetElementId = elementIdByName.get(assoc.target);
    if (sourceElementId === undefined || targetElementId === undefined) {
      throw new Error(`diagrama «${spec.name}»: la asociación ${assoc.source} → ${assoc.target} referencia una clase no declarada`);
    }
    relationships.push({
      id: relId,
      diagramId,
      kind: 'ASSOCIATION' as RelationshipKind,
      sourceElementId,
      targetElementId,
      name: null,
      stereotype: null,
      createdAt: STAMP,
      updatedAt: STAMP,
      associationClassId: null,
    });
    relationshipEnds.push(
      {
        id: `${relId}-source`,
        relationshipId: relId,
        endIndex: 0,
        elementId: sourceElementId,
        roleName: null,
        lowerBound: assoc.sourceEnd.lower,
        upperBound: assoc.sourceEnd.upper,
        isNavigable: true,
        aggregation: 'NONE',
      },
      {
        id: `${relId}-target`,
        relationshipId: relId,
        endIndex: 1,
        elementId: targetElementId,
        roleName: null,
        lowerBound: assoc.targetEnd.lower,
        upperBound: assoc.targetEnd.upper,
        isNavigable: true,
        aggregation: 'NONE',
      },
    );
  });

  return {
    diagram,
    elements,
    features,
    parameters: [],
    enumLiterals: [],
    layouts,
    relationships,
    relationshipEnds,
    relationshipLayouts: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T2 — `DiagramContent` → bytes XMI 2.5.1 con extensión EA, con el emisor real
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reproduce `XmiExportService.build` sin Prisma: el `IdentityScope` se arma a
 * mano desde el `DiagramContent` en memoria, con `xmiId: null` en las seis
 * filas (nunca hubo una exportación previa que guardara uno, así que todo se
 * acuña — exactamente D2/D3 del diseño del exportador). El documento queda
 * SOLO en memoria; nada se escribe a disco.
 */
export function emitXmiDocument(content: DiagramContent): string {
  assertOrderContract(content);

  const identityScope: IdentityScope = {
    elements: content.elements.map((element) => ({ id: element.id, name: element.name, xmiId: null })),
    features: content.features.map((feature) => ({ id: feature.id, name: feature.name, xmiId: null })),
    parameters: content.parameters.map((parameter) => ({ id: parameter.id, name: parameter.name, xmiId: null })),
    enumLiterals: content.enumLiterals.map((literal) => ({ id: literal.id, name: literal.name, xmiId: null })),
    relationships: content.relationships.map((relationship) => ({
      id: relationship.id,
      name: relationship.name,
      xmiId: null,
      associationClassId: relationship.associationClassId,
    })),
    relationshipEnds: content.relationshipEnds.map((end) => ({ id: end.id, name: end.roleName, xmiId: null })),
    diagrams: [{ id: content.diagram.id, name: content.diagram.name }],
  };
  const identity = IdentityMap.build(identityScope);

  const references = [
    ...content.features.map((feature) => ({ typeElementId: feature.typeElementId, typeName: feature.typeName })),
    ...content.parameters.map((parameter) => ({ typeElementId: parameter.typeElementId, typeName: parameter.typeName })),
  ];
  const types = TypeResolver.build(references, identity);

  const emitter = new XmiEmitter(XMI_2_5_1);
  emitter.openDocument();
  emitter.openModel();
  emitPrimitiveTypesPackage(emitter, types);
  serializeModel(emitter, { contents: [content], identity, types });
  emitter.closeModel();
  // Extensión EA encendida (default de la API, FR-E09): el brief la pide explícita.
  if (DEFAULT_INCLUDE_EA_EXTENSION) emitEaExtension(emitter, { contents: [content], identity });
  emitter.closeDocument();

  const document = emitter.toXml();
  assertInvariants(document, XMI_2_5_1);
  return document;
}

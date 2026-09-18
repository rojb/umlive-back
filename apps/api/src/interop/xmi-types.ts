import { XMI_ERROR, XMI_EXPORT_NOTE, type XmiExportNote } from '@umlive/contracts';
import { att, type XmiEmitter } from './xmi-emitter';
import type { IdentityMap } from './xmi-identity';
import { XmiExportError } from './xmi-invariants';

/**
 * `TypeResolver` (D3).
 *
 * `UmlFeatureView`/`UmlParameterView` llevan `typeElementId` (FK) **y**
 * `typeName` (texto libre). E.2 dice `type` por `xmi:idref`: con
 * `typeName = 'BigDecimal'` no hay a qué apuntar. De las cuatro opciones del
 * diseño se eligió **sintetizar siempre** un `uml:PrimitiveType` por cada
 * `typeName` distinto: cubre 17/17 más el texto libre, y —lo decisivo— el
 * inverso queda TOTAL y mecánico (una sola regla para el importador), cosa que
 * el híbrido con `href` no logra.
 *
 * **El id**: `UMLIVE_PT_` + los bytes UTF-8 del `typeName` en hex MAYÚSCULA.
 * Feo a propósito, y por tres razones que ninguna alternativa cumple a la vez:
 * (a) **inyectivo** — `Big Decimal` y `Big_Decimal` no colapsan (un slug
 * saneado sí, en silencio); (b) **NCName-válido** siempre, sea cual sea el
 * texto libre que escribió el usuario; (c) **reversible sin tabla** — el
 * importador hace hex→utf8.
 *
 * **`typeElementId` gana siempre sobre `typeName`**: es una referencia a un
 * elemento modelado de verdad. Y un elemento `kind = 'PRIMITIVE_TYPE'`
 * modelado es OTRA COSA: se emite en el paquete de su propio diagrama y no
 * entra al paquete acuñado. El discriminante es la **posición estructural**,
 * nunca el prefijo del id (un `xmi_id` ajeno que empiece con `UMLIVE_PT_` es
 * posible: nada en la base lo impide).
 */

/** Paquete de tipos acuñados: nivel superior, PRIMERO en el documento (D3). */
export const SYNTHETIC_TYPES_PACKAGE_ID = 'UMLIVE_TYPES';
export const SYNTHETIC_TYPES_PACKAGE_NAME = 'UMLivePrimitiveTypes';

export function syntheticTypeId(typeName: string): string {
  return `UMLIVE_PT_${Buffer.from(typeName, 'utf8').toString('hex').toUpperCase()}`;
}

export interface TypeReference {
  typeElementId: string | null;
  typeName: string | null;
}

export interface SyntheticType {
  id: string;
  name: string;
}

export class TypeResolver {
  private constructor(
    private readonly identity: IdentityMap,
    private readonly byName: ReadonlyMap<string, string>,
    private readonly ordered: readonly SyntheticType[],
    private readonly collected: readonly XmiExportNote[],
  ) {}

  static build(references: readonly TypeReference[], identity: IdentityMap): TypeResolver {
    const names = new Set<string>();
    for (const reference of references) {
      // Misma precedencia que `resolveType`: una referencia modelada resuelta
      // hace que el texto libre no cree un tipo sintético.
      if (reference.typeElementId !== null && identity.forElement(reference.typeElementId) !== null) continue;
      if (reference.typeName !== null) names.add(reference.typeName);
    }

    // Orden por `typeName` con comparación de unidades de código, nunca
    // `localeCompare`: el orden del documento no puede depender del locale de
    // la máquina que exporta.
    const ordered: SyntheticType[] = [...names]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => ({ id: syntheticTypeId(name), name }));

    const collected: XmiExportNote[] = [];
    for (const type of ordered) {
      if (identity.hasDefined(type.id)) {
        throw new XmiExportError(
          XMI_ERROR.DUPLICATE_XMI_ID,
          `el tipo sintético ${type.id} (typeName '${type.name}') ya está tomado por una fila del alcance`,
        );
      }
      collected.push({
        code: XMI_EXPORT_NOTE.SYNTHETIC_PRIMITIVE_TYPE,
        subjectId: type.id,
        detail: `typeName '${type.name}' sin typeElementId resoluble: se sintetizó ${type.id}`,
      });
    }

    return new TypeResolver(identity, new Map(ordered.map((type) => [type.name, type.id])), ordered, collected);
  }

  /** `typeElementId` resoluble gana; si no, el `typeName` sintetizado; si no hay ninguno, no se emite `type`. */
  resolveType(typeElementId: string | null, typeName: string | null): string | null {
    if (typeElementId !== null) {
      const resolved = this.identity.forElement(typeElementId);
      if (resolved !== null) return resolved;
    }
    if (typeName === null) return null;
    return this.byName.get(typeName) ?? null;
  }

  syntheticTypes(): readonly SyntheticType[] {
    return this.ordered;
  }

  count(): number {
    return this.ordered.length;
  }

  notes(): readonly XmiExportNote[] {
    return this.collected;
  }
}

/**
 * Emite el paquete `UMLIVE_TYPES` con sus `uml:PrimitiveType`, ordenados por
 * `typeName`. Devuelve `false` si no hay tipos sintéticos: un paquete
 * inventado y vacío es ruido, y «primero en el documento» solo significa algo
 * cuando el paquete existe.
 */
export function emitPrimitiveTypesPackage(emitter: XmiEmitter, types: TypeResolver): boolean {
  const synthetic = types.syntheticTypes();
  if (synthetic.length === 0) return false;

  emitter.subject(SYNTHETIC_TYPES_PACKAGE_ID);
  emitter.open('packagedElement', [
    att('xmi:type', 'uml:Package'),
    att('xmi:id', SYNTHETIC_TYPES_PACKAGE_ID),
    att('name', SYNTHETIC_TYPES_PACKAGE_NAME),
  ]);
  for (const type of synthetic) {
    emitter.subject(type.id);
    emitter.leaf('packagedElement', [att('xmi:type', 'uml:PrimitiveType'), att('xmi:id', type.id), att('name', type.name)]);
  }
  emitter.close('packagedElement');
  return true;
}

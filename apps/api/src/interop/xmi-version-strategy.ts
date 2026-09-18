import type { XmiVersion } from '@umlive/contracts';

/**
 * Estrategia de versión (D4, D10). **Solo datos**: dos constantes congeladas,
 * `2.5.1` por defecto (FR-E02). Sin lógica de emisión — el documento no se
 * construye acá.
 *
 * Los cuatro puntos de consulta de la estrategia son exactamente estos campos:
 * el atributo `xmi:version`, `xmlns:uml`, `xmlns:xmi` y la carga del XSD.
 * **El mapeo E.2 (`xmi-serializer.ts`) NO recibe esta estrategia**: no está en
 * su firma, así que no puede leerla ni por accidente. Esa ausencia es la
 * propiedad verificable de la propuesta y esta firma la hace estructural en
 * vez de disciplinada. Si un consumidor real de 2.1 rechazara el cuerpo con
 * forma de 2.5.1, la corrección es un campo NUEVO acá — nunca un
 * `if (version === '2.1')` en el mapeo.
 */
export interface XmiVersionStrategy {
  readonly version: XmiVersion;
  /** Valor del atributo `xmi:version`. Diferente del literal de la versión en 2.5.1. */
  readonly token: string;
  readonly umlNs: string;
  readonly xmiNs: string;
  /**
   * Nombre de archivo del XSD bajo `src/interop/xsd/` (D7). Acá es **dato**:
   * la Unidad 3 vendoriza los archivos con estos nombres exactos y los carga
   * con `join(__dirname, 'xsd', entry)`, nunca con `process.cwd()`.
   */
  readonly xsdEntry: string;
}

/**
 * XMI 2.5.1 — host `www.omg.org` y token de fecha (E.1).
 * `encoding="UTF-8"` en las dos versiones (FR-E05, D10).
 */
export const XMI_2_5_1: XmiVersionStrategy = Object.freeze({
  version: '2.5.1',
  token: '20131001',
  umlNs: 'http://www.omg.org/spec/UML/20131001',
  xmiNs: 'http://www.omg.org/spec/XMI/20131001',
  xsdEntry: 'XMI-2.5.1.xsd',
});

/**
 * XMI 2.1 — host `schema.omg.org` y token con punto (E.1). Misma FORMA de
 * documento que 2.5.1; cambian los nombres y el token, nada más.
 */
export const XMI_2_1: XmiVersionStrategy = Object.freeze({
  version: '2.1',
  token: '2.1',
  umlNs: 'http://schema.omg.org/spec/UML/2.1',
  xmiNs: 'http://schema.omg.org/spec/XMI/2.1',
  xsdEntry: 'XMI-2.1.xsd',
});

/** FR-E02: el default es 2.5.1, no 2.1 (resuelto en D10 contra E.1). */
export const DEFAULT_XMI_VERSION: XmiVersion = '2.5.1';

export const XMI_VERSION_STRATEGIES: Readonly<Record<XmiVersion, XmiVersionStrategy>> = Object.freeze({
  '2.1': XMI_2_1,
  '2.5.1': XMI_2_5_1,
});

/** Resolución perezosa del default — el único lugar que traduce `undefined` a `2.5.1`. */
export function versionStrategyFor(version: XmiVersion | undefined): XmiVersionStrategy {
  return XMI_VERSION_STRATEGIES[version ?? DEFAULT_XMI_VERSION];
}

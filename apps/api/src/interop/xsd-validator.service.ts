import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMI_ERROR, type XmiVersion } from '@umlive/contracts';
import { memoryPages, validateXML, type XMLFileInfo, type XMLValidationResult } from 'xmllint-wasm';
import { XmiExportError } from './xmi-invariants';
import { XMI_2_1, XMI_2_5_1, XMI_VERSION_STRATEGIES, type XmiVersionStrategy } from './xmi-version-strategy';

/**
 * G2 — compuerta de esquema (D6, tarea 3.3). FR-E04, SC-E10.
 *
 * ── Resultado del spike de la tarea 1.1, transcripto acá (no re-litigado) ──
 *
 * `xmllint-wasm@5.3.0` **ES CommonJS**: su `package.json` trae
 * `"main": "index-node.js"` y **no** trae campo `"type"`. La forma que
 * funcionó es la importación directa que está arriba:
 * `import { validateXML } from 'xmllint-wasm'` (compilado a
 * `require('xmllint-wasm')` por CommonJS). Validó un XML mínimo contra un XSD
 * mínimo → `{ valid: true, errors: [] }`, y rechazó el inválido con
 * `Schemas validity error : Element 'root': The attribute 'id' is required but
 * missing.`. El plan B (`createRequire` + `await import()` dinámico) también
 * funciona, pero NO hace falta; no hay caída a `libxmljs2` ni costo de node-gyp.
 * `xmllint.wasm` se resuelve solo: la validación corrió de verdad.
 *
 * ── Fail-closed (D6) ──────────────────────────────────────────────────────
 *
 * FR-E04 legisla «un documento que no valida no se entrega», pero **no** dice
 * qué pasa si el validador está AUSENTE. La lectura silenciosa —exportar sin
 * validar— es la peligrosa: degrada justo en la máquina donde las dependencias
 * no instalaron y se descubre en la defensa. Acá, al arranque (`OnModuleInit`)
 * se cargan el validador y los DOS XSD y se corre una sonda real contra cada
 * par; si algo falla, se loguea con `Logger.error` y el servicio queda
 * INDISPONIBLE. Mientras lo esté, toda ruta responde
 * `503 xmi_validator_unavailable` y no se entrega ningún documento.
 *
 * ── Los archivos ─────────────────────────────────────────────────────────
 *
 * Se leen con `join(__dirname, 'xsd', entry)` — **nunca** `process.cwd()`: es
 * la misma convención que `app.module.ts` ya estableció para el `.env`, con la
 * misma razón («se debe encontrar igual arranque desde donde arranque»), y es
 * lo que hace que el arranque desde `dist/` encuentre los `.xsd` que
 * `nest-cli.json` los copia con su glob de `assets` (D7/tarea 3.2).
 *
 * La clausura de importaciones viaja por `preload`: el contenedor importa su
 * clausura UML con `schemaLocation`, y sin preload los dos archivos no se
 * resuelven entre sí en el sistema de archivos en memoria de xmllint.
 */

/** Clausura de cada contenedor, por versión. El `entry` sale de la estrategia (D4). */
const SCHEMA_CLOSURE: Readonly<Record<XmiVersion, readonly string[]>> = {
  '2.5.1': ['UML-2.5.xsd'],
  '2.1': ['UML-2.1.xsd'],
};

interface SchemaSet {
  readonly entry: XMLFileInfo;
  readonly closure: readonly XMLFileInfo[];
  readonly probe: XMLFileInfo;
}

@Injectable()
export class XsdValidatorService implements OnModuleInit {
  private readonly logger = new Logger(XsdValidatorService.name);
  private readonly schemas = new Map<XmiVersion, SchemaSet>();
  private unavailableReason: string | null = null;

  async onModuleInit(): Promise<void> {
    try {
      for (const strategy of [XMI_2_5_1, XMI_2_1]) {
        const set = this.load(strategy);
        const probe = await this.run(set.probe, set);
        if (!probe.valid) {
          throw new Error(`la sonda de arranque de ${strategy.version} no validó: ${describe(probe.errors)}`);
        }
        this.schemas.set(strategy.version, set);
      }
      this.logger.log(`G2 lista: ${this.schemas.size} pares XMI/UML cargados (${[...this.schemas.keys()].join(', ')})`);
    } catch (error) {
      this.unavailableReason = error instanceof Error ? error.message : String(error);
      // `Logger.error` es lo que exige la tarea 3.3: el problema aparece en el
      // arranque, no en la corrección.
      this.logger.error(`G2 NO disponible: ${this.unavailableReason}. Todo export responderá 503 xmi_validator_unavailable.`);
    }
  }

  /** `false` mientras la sonda de arranque no haya pasado. No lanza: el service decide el 503. */
  get available(): boolean {
    return this.unavailableReason === null;
  }

  /**
   * Valida los bytes FINALES, después de G1 (tarea 3.5). Un documento que no
   * cumple el XSD corta acá con `422 schema_invalid` **y los errores del
   * validador**; un validador no disponible corta con `503`. Los dos son
   * `XmiExportError`, así que el service los traduce con `XMI_ERROR_STATUS`.
   */
  async assertValid(document: string, strategy: XmiVersionStrategy): Promise<void> {
    if (this.unavailableReason !== null) {
      throw new XmiExportError(
        XMI_ERROR.XMI_VALIDATOR_UNAVAILABLE,
        `el validador XSD no está disponible (${this.unavailableReason}): no se entrega ningún documento sin validar`,
      );
    }

    const set = this.schemas.get(strategy.version);
    if (set === undefined) {
      throw new XmiExportError(
        XMI_ERROR.XMI_VALIDATOR_UNAVAILABLE,
        `no hay esquema cargado para XMI ${strategy.version}: no se entrega ningún documento sin validar`,
      );
    }

    const result = await this.run({ fileName: `document-${strategy.version}.xmi`, contents: document }, set);
    if (result.valid) return;

    const errors = result.errors.map((error) => error.rawMessage);
    throw new XmiExportError(
      XMI_ERROR.SCHEMA_INVALID,
      `el documento no valida contra ${strategy.xsdEntry} (XMI ${strategy.version}): ${errors.length} error(es)`,
      [],
      errors,
    );
  }

  /**
   * Un `throw` de `xmllint-wasm` NO es «documento inválido»: es el motor que no
   * pudo correr (esquema que no compila, wasm que no carga). Se trata como
   * indisponibilidad — fail-closed, nunca como «validó» ni como «el documento
   * está mal».
   */
  private async run(xml: XMLFileInfo, set: SchemaSet): Promise<XMLValidationResult> {
    try {
      return await validateXML({
        xml,
        schema: set.entry,
        preload: set.closure,
        initialMemoryPages: 64 * memoryPages.MiB,
        maxMemoryPages: 256 * memoryPages.MiB,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`xmllint-wasm no pudo validar: ${reason}`);
    }
  }

  /** Lee el contenedor y su clausura del disco, al lado del JS compilado. */
  private load(strategy: XmiVersionStrategy): SchemaSet {
    const read = (fileName: string): XMLFileInfo => ({
      fileName,
      contents: readFileSync(join(__dirname, 'xsd', fileName), 'utf8'),
    });

    const closure = SCHEMA_CLOSURE[strategy.version].map(read);
    return {
      entry: read(strategy.xsdEntry),
      closure,
      probe: { fileName: `probe-${strategy.version}.xml`, contents: probeDocument(strategy) },
    };
  }
}

/**
 * Documento mínimo que el contenedor y su clausura aceptan. Valida que el
 * esquema COMPILE y que el motor esté vivo: un XSD roto o un `.xsd` que no
 * llegó a `dist/` hacen fallar la sonda en el arranque, no el primer export.
 */
function probeDocument(strategy: XmiVersionStrategy): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xmi:XMI xmi:version="${strategy.token}" xmlns:uml="${strategy.umlNs}" xmlns:xmi="${strategy.xmiNs}">`,
    '  <uml:Model xmi:type="uml:Model" name="UMLiveProbe" visibility="public"/>',
    '</xmi:XMI>',
    '',
  ].join('\n');
}

/** Un mensaje por error, sin el nombre de archivo temporal que agrega libxml2. */
function describe(errors: XMLValidationResult['errors']): string {
  return errors.map((error) => error.message).join(' | ');
}

/** Re-exportado para que el mapa de estrategias del validador sea el mismo del resto del pipeline. */
export const VALIDATED_VERSIONS = Object.keys(XMI_VERSION_STRATEGIES) as XmiVersion[];

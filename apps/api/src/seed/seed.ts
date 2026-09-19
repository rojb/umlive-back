import { NestFactory } from '@nestjs/core';
import { SeedBlockError, SeedBlocksService, type SeedBlockOutcome } from './seed-blocks';
import { SeedModule } from './seed.module';

/**
 * Punto de entrada del seed de la demo — `seed-data-and-demo-script` tarea 2.8.
 *
 * Es un script de una sola corrida: lo ejecuta el servicio `migrate` del
 * compose después de `prisma migrate deploy` (`node dist/seed/seed.js`) y a
 * mano en el hosteado. Ya **no** usa un `PrismaClient` suelto (como el seed
 * mínimo de `offline-docker-compose` D5): levanta un `ApplicationContext` de
 * Nest con `SeedModule` para importar con el mismo importador que la interfaz.
 *
 * ── Orden ───────────────────────────────────────────────────────────────────
 *
 *   `--reset` (opcional) → B1 usuarios → B2 proyecto → B3 miembros →
 *   B4 `Ventas` → B5 `Referencia` → B6 código de unión → `ctx.close()` → exit
 *
 * `--reset` corre ANTES de los bloques: borra de forma suave todos los
 * diagramas vivos de «Defensa» y revoca sus códigos, y **nunca toca
 * `ai_turns`**. Es lo que hace que dos ensayos arranquen del mismo estado.
 *
 * ── Salida ──────────────────────────────────────────────────────────────────
 *
 * Cada bloque loguea `seed[<bloque>]: aplicado | ya aplicado`. Un bloque puede
 * lanzar `SeedBlockError` (por ejemplo, un fixture ausente o `unsupported` no
 * vacío en `Referencia`); en ese caso se loguea el bloque y el motivo, y el
 * proceso sale con código 1. `ctx.close()` corre siempre en el `finally`.
 */
function logOutcome(outcome: SeedBlockOutcome): void {
  console.log(`seed[${outcome.id}]: ${outcome.applied ? 'aplicado' : 'ya aplicado'} — ${outcome.detail}`);
}

async function main(): Promise<void> {
  const reset = process.argv.slice(2).includes('--reset');
  const context = await NestFactory.createApplicationContext(SeedModule);
  let exitCode = 0;

  try {
    const blocks = context.get(SeedBlocksService);

    if (reset) {
      const result = await blocks.reset();
      console.log(
        `seed[reset]: ${result.diagrams} diagrama(s) borrado(s) de forma suave, ${result.codes} código(s) revocado(s) (ai_turns intacto)`,
      );
    }

    const users = await blocks.users();
    logOutcome(users.outcome);

    const project = await blocks.project(users.hostId);
    logOutcome(project.outcome);

    logOutcome(await blocks.members(project.projectId));

    const ventas = await blocks.ventasDiagram(project.projectId, users.hostId);
    logOutcome(ventas.outcome);

    logOutcome(await blocks.referenciaDiagram(project.projectId, users.hostId));

    logOutcome(await blocks.joinCode(ventas.diagramId, users.hostId));
  } catch (error) {
    if (error instanceof SeedBlockError) {
      console.error(`seed[${error.block}]: FALLÓ — ${error.message}`);
    } else {
      console.error(`seed: falló — ${error instanceof Error ? error.message : String(error)}`);
    }
    exitCode = 1;
  } finally {
    // `PrismaService.onModuleDestroy` desconecta; sin esto el proceso no suelta
    // la base y el contenedor `migrate` no termina.
    await context.close();
  }

  process.exit(exitCode);
}

void main().catch((error: unknown) => {
  console.error(`seed: falló al arrancar — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

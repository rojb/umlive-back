# Fixtures de la demo

Esta carpeta es donde el **seed** (`apps/api/src/seed/seed.ts`) lee los archivos XMI que importa para armar los dos diagramas de «Defensa». Los archivos los produce una persona en la **Fase 1** de `seed-data-and-demo-script`; mientras no estén, el seed falla con un mensaje que nombra el archivo y sale con código distinto de cero (nunca deja un diagrama a medio importar).

El seed los busca por ruta relativa al código compilado: `dist/seed/` → `../../fixtures/demo`. En la imagen Docker los copia el `COPY --from=api /app/apps/api ./apps/api` del `Dockerfile`, que ya arrastra todo `apps/api`.

## Archivos que van acá

| Archivo | Tarea | Qué es | Lo lee |
|---|---|---|---|
| `reference.xmi` | 1.2 | El **modelo de referencia** de la app: 10 clases, generalización con raíz abstracta, una composición, una relación `*—*`, un `enum` y la clase asociación `Matrícula(fecha, nota)`. Se construye en la app y se exporta en 2.5.1. | **Sí** — bloque B5, diagrama `Referencia` |
| `ventas.xmi` | 1.3 | El **modelo del acto 1**: `Cliente` (con `correo`), `Pedido` y el paquete `ventas`. Se construye en la app y se exporta. | **Sí** — bloque B4, diagrama `Ventas` |

- **B5 exige `unsupported = []`.** Si el import de `reference.xmi` reporta un solo elemento no soportado, el seed entero sale con código 1 y no crea el diagrama: el modelo de referencia que describe la defensa no puede perder elementos en silencio.
- **B4/B5 son idempotentes.** Si el diagrama ya existe **y** tiene una fila en `xmi_imports`, el bloque loguea «ya aplicado». Si el nombre existe pero no hay fila de import (importación incompleta), el diagrama se borra de forma suave y se reimporta.

## Archivos que NO van acá

| Archivo | Tarea | Dónde vive | Qué es |
|---|---|---|---|
| `reference.ea.xmi` | 1.5 | `demo/reference.ea.xmi` | `reference.xmi` pasado por Enterprise Architect 17 y exportado de vuelta. Lo usa una **persona** en el acto 2 (y es el respaldo si EA falla en vivo); el seed no lo lee. |
| `kr7-reference.jpg` | 3.10 | `demo/kr7-reference.jpg` | La foto del pizarrón con el modelo de 10 clases, para el acto 3 (KR7). |

Esos dos viven en `demo/` y no acá por el reparto de `design.md` D3: esta carpeta es del *runtime del contenedor*, `demo/` es de la persona que da la defensa.

## Cómo verificar sin la Fase 1

`SEED_FIXTURES_DIR` permite apuntar el seed a otra carpeta (por ejemplo, una temporal) para verificar los bloques B4/B5 antes de que existan los fixtures versionados. Sin esa variable, la ruta es la de esta carpeta.

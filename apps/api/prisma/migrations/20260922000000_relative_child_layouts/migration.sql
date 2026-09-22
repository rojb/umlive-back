-- `element-parent-containment` — cambia `element_layouts.x/y` de ABSOLUTO a
-- RELATIVO AL ELEMENTO PADRE (absoluto solo en la raíz, `parent_id IS NULL`).
--
-- El porqué del diseño: un arrastre de PAQUETE tenía que quedar como UNA sola
-- operación con UN solo lock (imposible de fallar a mitad de camino) en vez de
-- emitir un `element.move` por cada hijo. Guardando la posición de cada hijo
-- relativa a su padre, mover el paquete ya no toca la fila de ningún hijo: el
-- lienzo (xyflow, ver `derivedNodes` de `DiagramPage.tsx`) compone la posición
-- de pantalla sumando padre + hijo por sí solo. Ver el comentario del modelo
-- `ElementLayout` en schema.prisma y de `ElementLayoutView` en
-- packages/contracts/src/uml.ts para el contrato resultante, y
-- `absolutePositionOf` (mismo archivo de contracts) para cómo cualquier
-- consumidor reconstruye la posición absoluta sumando la cadena de
-- `parent_id`.
--
-- Nota de alcance: `parent_id` no es EXCLUSIVO de paquete-contiene-hijos — la
-- regla de `elements.service.ts` (`element.setParent`) también permite un
-- COMMENT colgado de cualquier elemento que no sea COMMENT (una nota pegada a
-- una clase, sin contención visual). Por eso el paso 2 de abajo convierte a
-- relativo TODO hijo con padre, sea cual sea el `kind` del padre — es el
-- mismo contrato para toda la tabla, "relativo al padre, absoluto en la
-- raíz", sin excepciones por tipo. Lo que SÍ está acotado a PACKAGE es el
-- paso 1 (encerrar al hijo agrandando al padre) y, del lado del lienzo, la
-- contención real de xyflow (`derivedNodes` solo fija `parentId` de xyflow
-- cuando el padre es un PACKAGE — el resto sigue con posición propia,
-- reconstruida a absoluta con `absolutePositionOf`). Verificado contra la
-- base real (2026-09-22): las 17 filas de `element_layouts` hoy son o bien
-- raíz o bien hijas directas de un PACKAGE — no hay ningún COMMENT todavía —
-- así que este caso no se ejerce con datos reales, pero la migración lo deja
-- bien definido para cuando exista.
--
-- ── Dos pasadas, EN ESTE ORDEN (el orden importa: la segunda lee lo que deja
--    la primera) ─────────────────────────────────────────────────────────────
--
-- 1) Cada PACKAGE con hijos que tengan layout se agranda para ENCERRARLOS,
--    calculando el rectángulo con las coordenadas ABSOLUTAS todavía vigentes
--    en toda la tabla (el paso 2 — el que vuelve todo relativo — todavía no
--    corrió). PAD = 32 en cada borde. Un paquete sin hijos con layout queda
--    intacto (no aparece en el `JOIN` de abajo).
--
-- 2) Cada elemento con padre pasa sus coordenadas a relativas al padre, ya
--    con la geometría que dejó el paso 1 (`x = x − padre.x`, `y = y − padre.y`).
--
-- ── Anidamiento (paquete dentro de paquete), profundidad arbitraria ─────────
-- El paso 1 tiene que procesar los niveles de más hondo a más superficial
-- (bottom-up): un paquete anidado agranda su PROPIA caja antes de que su
-- padre calcule la suya, así el padre encierra la caja YA agrandada del hijo
-- — si se procesara al revés, el padre encerraría el tamaño ORIGINAL del hijo
-- (que puede no alcanzar para nada de lo que el hijo a su vez contiene, como
-- pasa hoy mismo con `Online Shopping`: 260×160 declarado, pero sus 10 hijos
-- llegan hasta x=1152/y=1352). Los datos reales de hoy son de un solo nivel,
-- pero el bucle de abajo es correcto para cualquier profundidad: la
-- profundidad de cada elemento se calcula UNA sola vez con una CTE recursiva
-- sobre `parent_id` (en una tabla temporal), y se reusa en cada vuelta del
-- bucle porque el paso 1 nunca toca `parent_id` — solo x/y/width/height — así
-- que la profundidad no cambia entre iteraciones. Si algún día se colara un
-- ciclo de contención preexistente (el mismo caso que ya contempla
-- `qualifiedName` en packages/contracts/src/uml.ts), la CTE recursiva de
-- Postgres corta sola al no volver a visitar la misma fila — el bucle termina
-- igual, sin necesitar una guarda aparte.
--
-- ── Por qué esta migración NO es idempotente ─────────────────────────────────
-- Correrla una segunda vez le restaría el origen del padre una SEGUNDA vez a
-- cada hijo (y agrandaría cada paquete de nuevo con coordenadas que para
-- entonces ya son relativas, sin sentido como bbox absoluto). No hace falta
-- una guarda de "¿ya convertido?": `prisma migrate deploy` aplica cada
-- migración exactamente una vez y lo registra en `_prisma_migrations` — no
-- hay un `if not applied` que escribir a mano para esto sin agregar una
-- columna nueva solo para marcarlo, que sería más estado permanente que el
-- problema que resuelve.

BEGIN;

-- Profundidad de cada elemento por `parent_id` (raíz = 0). Tabla temporal:
-- vive solo dentro de esta transacción (`ON COMMIT DROP`), y el bucle de más
-- abajo la consulta en cada vuelta sin recalcularla.
CREATE TEMP TABLE element_depth ON COMMIT DROP AS
WITH RECURSIVE depths AS (
  SELECT id, 0 AS depth
  FROM uml_elements
  WHERE parent_id IS NULL
  UNION ALL
  SELECT e.id, d.depth + 1
  FROM uml_elements e
  JOIN depths d ON e.parent_id = d.id
)
SELECT id, depth FROM depths;

-- Paso 1: agrandar cada PACKAGE para encerrar a sus hijos, de más hondo a más
-- superficial.
DO $$
DECLARE
  pad CONSTANT integer := 32;
  d integer;
  max_d integer;
BEGIN
  SELECT COALESCE(MAX(depth), 0) INTO max_d FROM element_depth;

  -- El nivel más hondo que puede tener hijos es `max_d − 1`: un elemento en
  -- `max_d` es, por definición de máximo, una hoja (nada lo referencia como
  -- padre). `REVERSE` recorre de alto a bajo; con `max_d = 0` el rango queda
  -- vacío (`REVERSE (-1)..0`) y el bucle no corre ninguna vuelta — correcto,
  -- no hay ningún padre que agrandar.
  FOR d IN REVERSE (max_d - 1)..0 LOOP
    UPDATE element_layouts AS pl
    SET
      x = bbox.min_x - pad,
      y = bbox.min_y - pad,
      -- ancho/alto se derivan del nuevo origen, no al revés (mismo criterio
      -- que el comentario de `ElementLayout` en schema.prisma: width/height
      -- en vez de right/bottom, para no tener que releer la posición).
      width = (bbox.max_x - (bbox.min_x - pad)) + pad,
      height = (bbox.max_y - (bbox.min_y - pad)) + pad
    FROM (
      SELECT pe.id AS package_id,
             MIN(cl.x) AS min_x,
             MIN(cl.y) AS min_y,
             MAX(cl.x + cl.width) AS max_x,
             MAX(cl.y + cl.height) AS max_y
      FROM uml_elements AS pe
      JOIN element_depth AS ped ON ped.id = pe.id
      JOIN uml_elements AS ce ON ce.parent_id = pe.id
      JOIN element_layouts AS cl ON cl.element_id = ce.id
      WHERE pe.kind = 'PACKAGE' AND ped.depth = d
      GROUP BY pe.id
    ) AS bbox
    WHERE pl.element_id = bbox.package_id;
  END LOOP;
END $$;

-- Paso 2: todo elemento con padre pasa a coordenadas relativas al padre, ya
-- con la geometría que dejó el paso 1. Una sola pasada sobre TODOS los
-- niveles a la vez alcanza acá — a diferencia del paso 1, este paso solo
-- necesita el padre DIRECTO de cada fila (ya definitivo tras el paso 1), no
-- un recorrido bottom-up propio.
UPDATE element_layouts AS cl
SET
  x = cl.x - pl.x,
  y = cl.y - pl.y
FROM uml_elements AS ce
JOIN element_layouts AS pl ON pl.element_id = ce.parent_id
WHERE ce.id = cl.element_id
  AND ce.parent_id IS NOT NULL;

COMMIT;

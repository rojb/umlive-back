-- Backstop de coherencia `owner_id` ⇔ fila `HOST` (design.md §3.2).
--
-- Migración escrita a mano, aditiva a `20260912000001_integrity` (inmutable,
-- no se edita). Aplicar EXCLUSIVAMENTE con `prisma migrate deploy` — nunca con
-- `prisma migrate dev` pelado, porque Prisma no ve triggers ni funciones y los
-- ofrecería borrar como "drift" (prisma/README.md §5).
--
-- Por qué el trigger es DEFERRABLE INITIALLY DEFERRED y no inmediato: al crear
-- un proyecto, la fila `projects` existe ANTES que la fila `project_members`
-- correspondiente (la FK de `project_members.project_id` lo exige). Un trigger
-- inmediato sobre `projects` dispararía en el INSERT del proyecto, cuando la
-- fila HOST todavía no existe, y fallaría siempre. Diferido a COMMIT, la
-- transacción completa (proyecto + miembro HOST) ya escribió las dos filas
-- antes de que el trigger evalúe.
--
-- `project_members.role = 'HOST'` es la fuente de verdad de autorización.
-- `projects.owner_id` es una copia denormalizada de escritura única. Este
-- backstop detecta divergencia entre las dos, no la produce ni la resuelve.

CREATE OR REPLACE FUNCTION assert_project_host_is_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pid uuid;
  v_owner uuid;
  v_host uuid;
BEGIN
  -- Deliberadamente DOS sentencias separadas, una por rama, y no un único
  -- `CASE ... END` combinando `NEW.id`/`NEW.project_id`. PL/pgSQL compila un
  -- `CASE` embebido como UNA sola consulta SQL, y Postgres tipa TODAS sus
  -- ramas contra el tipo de fila real de `NEW` en esa invocación — la rama no
  -- tomada en tiempo de ejecución igual se valida en tiempo de compilación.
  -- Como esta función dispara sobre `projects` (sin columna `project_id`) y
  -- sobre `project_members`, una única expresión combinada revienta siempre
  -- en una de las dos tablas con "record NEW has no field project_id" (o
  -- "no field id"), sin importar qué rama del CASE correspondería en runtime.
  -- Partido en sentencias `IF`/`ELSE`, cada asignación es una consulta propia
  -- que el intérprete solo compila y ejecuta cuando esa rama se toma —así
  -- nunca se tipa un campo contra la tabla que no lo tiene.
  -- Descubierto verificando SC-A10 bis contra la base (tarea 0.5): la primera
  -- versión compilaba y aplicaba limpio, y solo fallaba al `COMMIT` real.
  IF TG_TABLE_NAME = 'projects' THEN
    pid := COALESCE(NEW.id, OLD.id);
  ELSE
    pid := COALESCE(NEW.project_id, OLD.project_id);
  END IF;

  SELECT owner_id INTO v_owner FROM projects WHERE id = pid;
  IF NOT FOUND THEN
    -- Proyecto borrado en la misma transacción: nada que comparar.
    RETURN NULL;
  END IF;

  SELECT user_id INTO v_host FROM project_members WHERE project_id = pid AND role = 'HOST';

  IF v_host IS DISTINCT FROM v_owner THEN
    RAISE EXCEPTION 'project %: owner_id (%) y fila HOST (%) divergen', pid, v_owner, v_host
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END $$;

-- Cubre: proyecto creado sin fila HOST, y `UPDATE projects SET owner_id = ...`
-- sin mover la membresía (FR-A17, futuro).
CREATE CONSTRAINT TRIGGER trg_projects_host_is_owner
  AFTER INSERT OR UPDATE OF owner_id ON projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION assert_project_host_is_owner();

-- Cubre: se borra o degrada la fila HOST sin actualizar `owner_id`. La app
-- (members.service.ts) ya rechaza esto con `403 cannot_remove_host` antes de
-- llegar acá; este trigger es el backstop de base, no la ruta de usuario.
CREATE CONSTRAINT TRIGGER trg_members_host_is_owner
  AFTER INSERT OR UPDATE OR DELETE ON project_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION assert_project_host_is_owner();

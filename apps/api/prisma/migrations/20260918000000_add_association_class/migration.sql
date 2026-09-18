-- FR-B10, `association-class` slice. Aditiva a `20260912000001_integrity`
-- y `20260912000002_project_host_coherence` (ambas inmutables, no se editan).
--
-- Generada con `prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` en vez de `prisma migrate dev --create-only`
-- (bloqueada en este entorno: "Prisma Migrate has detected that the
-- environment is non-interactive" incluso con `--create-only`/`CI=true`;
-- ver `sdd/association-class/apply-progress`). El diff se corrió contra la
-- base real, que ya tiene las tres migraciones aplicadas — mismo resultado
-- que `--create-only` habría producido, sin necesitar la shadow database
-- (que además falla en frío: `citext` se usa en `20260912000000_baseline`
-- pero la extensión se crea recién en `20260912000001_integrity`; se resolvió
-- para uso local pre-instalando `citext` en `template1` del servidor
-- Postgres, así cualquier shadow database nueva la hereda — no toca ninguna
-- migración existente. Deuda anotada, no de esta rebanada).
--
-- Verificado (diseño §3 paso 4): solo `ADD COLUMN`, `CREATE UNIQUE INDEX` y
-- `ADD CONSTRAINT … FOREIGN KEY` — ninguna línea de deriva contra objetos
-- preexistentes.

-- AlterTable
ALTER TABLE "uml_relationships" ADD COLUMN     "association_class_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "uml_relationships_association_class_id_key" ON "uml_relationships"("association_class_id");

-- AddForeignKey
ALTER TABLE "uml_relationships" ADD CONSTRAINT "uml_relationships_association_class_id_fkey" FOREIGN KEY ("association_class_id") REFERENCES "uml_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── CHECKs a mano (design.md D2) ────────────────────────────────────────────
-- Prisma no ve CHECK constraints (prisma/README.md §2); mismo precedente que
-- `20260912000001_integrity` y `20260912000002_project_host_coherence`:
-- se anexan a mano al final de la migración generada, nunca editando una
-- migración ya aplicada.
ALTER TABLE uml_relationships
  -- El camino 2 se apoya en que `kind` NO cambia: una clase asociación ES una
  -- asociación (D4 de `uml-relationships-backend`, intacta). Se garantiza en
  -- la base, no solo en el servicio, porque es la propiedad sobre la que se
  -- apoya todo el diseño.
  ADD CONSTRAINT ck_assoc_class_only_on_association
    CHECK (association_class_id IS NULL OR kind = 'ASSOCIATION'),
  -- La clase asociación lleva los atributos que NO pertenecen a ninguno de
  -- los dos extremos; si fuera un extremo, no habría nada que modelar.
  ADD CONSTRAINT ck_assoc_class_not_endpoint
    CHECK (association_class_id IS NULL OR
           (association_class_id <> source_element_id AND association_class_id <> target_element_id));

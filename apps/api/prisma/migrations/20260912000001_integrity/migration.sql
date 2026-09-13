-- ============================================================================
-- UMLive — integrity layer
-- ============================================================================
-- Everything Prisma cannot express: CHECK constraints, partial unique indexes,
-- NULLS NOT DISTINCT, extensions, and the append-only trigger.
--
-- This migration is HAND-WRITTEN and must never be regenerated. Create it with
--   npx prisma migrate dev --create-only --name integrity
-- and paste this content in. See prisma/README.md for the operating rules that
-- keep `prisma migrate dev` from trying to drop these objects.
--
-- Requirement traceability is in the comment above each block.
-- ============================================================================


-- ── Extensions ──────────────────────────────────────────────────────────────
-- citext backs the case-insensitive `@unique` on User.email and
-- DiagramJoinCode.code. Prisma cannot create it, but can use it.
CREATE EXTENSION IF NOT EXISTS citext;


-- ============================================================================
-- 1. USERS
-- ============================================================================

ALTER TABLE users
  ADD CONSTRAINT ck_users_email_shape
    CHECK (email::text LIKE '%_@_%._%'),
  ADD CONSTRAINT ck_users_display_name
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  ADD CONSTRAINT ck_users_locale
    CHECK (locale IN ('es', 'en'));

-- Optimization only: the session list reads live sessions (FR-A18).
CREATE INDEX ix_refresh_tokens_user_active
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;


-- ============================================================================
-- 2. PROJECTS  (FR-A06)
-- ============================================================================

ALTER TABLE projects
  ADD CONSTRAINT ck_projects_name
    CHECK (length(btrim(name)) BETWEEN 1 AND 120);

-- FR-A06: exactly one HOST per project.
-- Semantic partiality — this is a rule, not an optimization.
CREATE UNIQUE INDEX uq_project_single_host
  ON project_members (project_id) WHERE role = 'HOST';

CREATE INDEX ix_projects_owner_active
  ON projects (owner_id) WHERE deleted_at IS NULL;


-- ============================================================================
-- 3. DIAGRAMS  (FR-C09, FR-A10)
-- ============================================================================

ALTER TABLE diagrams
  ADD CONSTRAINT ck_diagrams_name
    CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- A row saying LOCKED_BY_HOST with locked_by = NULL is a state the FR-C09
  -- banner cannot render — it would have to name a host that does not exist.
  -- Making it unrepresentable is cheaper than handling it in the UI.
  ADD CONSTRAINT ck_diagrams_lock_coherent
    CHECK (
      (lock_state = 'UNLOCKED'       AND locked_by IS NULL     AND locked_at IS NULL) OR
      (lock_state = 'LOCKED_BY_HOST' AND locked_by IS NOT NULL AND locked_at IS NOT NULL)
    ),
  ADD CONSTRAINT ck_diagrams_version_nonneg
    CHECK (current_version >= 0);

CREATE INDEX ix_diagrams_project_active
  ON diagrams (project_id) WHERE deleted_at IS NULL;

ALTER TABLE diagram_join_codes
  ADD CONSTRAINT ck_join_code_shape
    CHECK (code::text ~ '^[A-Za-z0-9]{8}$'),
  ADD CONSTRAINT ck_join_code_uses
    CHECK (max_uses IS NULL OR use_count <= max_uses),
  ADD CONSTRAINT ck_join_code_use_count_nonneg
    CHECK (use_count >= 0);

-- FR-A10: unique among *active* codes only. A revoked code's string becomes
-- reusable, which is correct — uniqueness is a property of active codes, not
-- of history. `code` is citext, so this is already case-insensitive.
CREATE UNIQUE INDEX uq_join_code_active
  ON diagram_join_codes (code) WHERE revoked_at IS NULL;


-- ============================================================================
-- 4. UML ELEMENTS  (FR-B01, FR-B14)
-- ============================================================================

ALTER TABLE uml_elements
  -- Comments carry a body and no name; everything else carries a name.
  ADD CONSTRAINT ck_element_named
    CHECK (
      (kind = 'COMMENT'  AND body IS NOT NULL) OR
      (kind <> 'COMMENT' AND name IS NOT NULL AND length(btrim(name)) > 0)
    ),
  -- FR-B14: only classes and interfaces can be abstract.
  ADD CONSTRAINT ck_element_abstract
    CHECK (is_abstract = false OR kind IN ('CLASS', 'INTERFACE')),
  ADD CONSTRAINT ck_element_not_own_parent
    CHECK (parent_id IS NULL OR parent_id <> id);

-- FR-B14: no two classifiers with the same name in the same container.
--
-- NULLS NOT DISTINCT (PostgreSQL 15+) is what makes this correct. Without it,
-- PostgreSQL treats every NULL parent_id as distinct, so two root-level
-- classes both named "Order" would BOTH be accepted — the uniqueness rule
-- would silently not apply to exactly the elements that need it most.
CREATE UNIQUE INDEX uq_element_name_per_parent
  ON uml_elements (diagram_id, parent_id, name)
  NULLS NOT DISTINCT
  WHERE kind <> 'COMMENT';

-- Optimization only.
CREATE INDEX ix_elements_xmi
  ON uml_elements (diagram_id, xmi_id) WHERE xmi_id IS NOT NULL;


-- ============================================================================
-- 5. UML FEATURES  (FR-B02, FR-B03, FR-B14)
-- ============================================================================

ALTER TABLE uml_features
  ADD CONSTRAINT ck_feature_name
    CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT ck_feature_multiplicity
    CHECK (lower_bound >= 0 AND (upper_bound IS NULL OR upper_bound >= lower_bound)),
  -- isAbstract / isQuery are meaningless on an attribute.
  ADD CONSTRAINT ck_feature_operation_flags
    CHECK (kind = 'OPERATION' OR (is_abstract = false AND is_query = false)),
  -- isReadonly / isDerived are meaningless on an operation.
  ADD CONSTRAINT ck_feature_attribute_flags
    CHECK (kind = 'ATTRIBUTE' OR (is_readonly = false AND is_derived = false));

-- FR-B14: duplicate attribute names within a classifier are invalid.
-- Operations are deliberately excluded — overloading by signature is legal UML,
-- which is why this index is partial rather than a plain @@unique in Prisma.
CREATE UNIQUE INDEX uq_attribute_name_per_owner
  ON uml_features (owner_id, name) WHERE kind = 'ATTRIBUTE';

CREATE INDEX ix_features_type
  ON uml_features (type_element_id) WHERE type_element_id IS NOT NULL;


-- ============================================================================
-- 6. PARAMETERS & LITERALS
-- ============================================================================

ALTER TABLE uml_parameters
  ADD CONSTRAINT ck_parameter_name
    CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT ck_parameter_position_nonneg
    CHECK (position >= 0);

-- UML allows at most one return parameter per operation.
CREATE UNIQUE INDEX uq_parameter_single_return
  ON uml_parameters (operation_id) WHERE direction = 'RETURN';

ALTER TABLE uml_enum_literals
  ADD CONSTRAINT ck_literal_name
    CHECK (length(btrim(name)) > 0);


-- ============================================================================
-- 7. RELATIONSHIPS  (FR-B04, FR-B14)
-- ============================================================================

ALTER TABLE uml_relationships
  ADD CONSTRAINT ck_relationship_not_self_generalization
    CHECK (kind <> 'GENERALIZATION' OR source_element_id <> target_element_id);

ALTER TABLE uml_relationship_ends
  ADD CONSTRAINT ck_end_index
    CHECK (end_index IN (0, 1)),
  ADD CONSTRAINT ck_end_multiplicity
    CHECK (lower_bound >= 0 AND (upper_bound IS NULL OR upper_bound >= lower_bound)),
  -- FR-B14: a composite end may not have upper multiplicity > 1.
  -- A part cannot belong to many wholes at once — that is what composition
  -- *means*, and it is also what makes orphanRemoval safe in the generated
  -- JPA code (FR-F03).
  ADD CONSTRAINT ck_composite_multiplicity
    CHECK (
      aggregation <> 'COMPOSITE'
      OR (upper_bound IS NOT NULL AND upper_bound <= 1)
    );


-- ============================================================================
-- 8. LAYOUT
-- ============================================================================

ALTER TABLE element_layouts
  ADD CONSTRAINT ck_layout_size
    CHECK (width > 0 AND height > 0);

ALTER TABLE relationship_layouts
  ADD CONSTRAINT ck_waypoints_array
    CHECK (jsonb_typeof(waypoints) = 'array');


-- ============================================================================
-- 9. OPERATION LOG — APPEND-ONLY  (FR-C14)
-- ============================================================================

ALTER TABLE diagram_operations
  ADD CONSTRAINT ck_op_version_positive
    CHECK (version > 0);

-- "Append-only" written in a design document is a wish. This makes it a
-- property. FR-C16's restore-to-point depends on the log being trustworthy,
-- and history a bug can rewrite is not history.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'diagram_operations is append-only (FR-C14): % rejected on row %',
    TG_OP, OLD.id;
END;
$$;

CREATE TRIGGER trg_operations_append_only
  BEFORE UPDATE OR DELETE ON diagram_operations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();


-- ============================================================================
-- 10. AI  (FR-D15b)
-- ============================================================================

ALTER TABLE ai_turns
  ADD CONSTRAINT ck_ai_cost_nonneg
    CHECK (cost_usd >= 0),
  ADD CONSTRAINT ck_ai_tokens_nonneg
    CHECK (input_tokens >= 0 AND output_tokens >= 0),
  ADD CONSTRAINT ck_ai_iterations_nonneg
    CHECK (iterations >= 0);

ALTER TABLE project_ai_configs
  ADD CONSTRAINT ck_fallback_chain_array
    CHECK (jsonb_typeof(fallback_chain) = 'array');

-- FR-D15b: the spend check runs before every AI call and must stay cheap.
-- Failed and rejected turns are included on purpose — they cost real money,
-- and filtering to APPLIED would let the ceiling be crossed silently.
CREATE INDEX ix_ai_turns_billed
  ON ai_turns (created_at) WHERE status IN ('APPLIED', 'REJECTED', 'FAILED');

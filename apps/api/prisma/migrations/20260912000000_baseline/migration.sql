-- ============================================================================
-- BASELINE — crea el esquema completo de prisma/schema.prisma
-- ============================================================================
-- Generada el 2026-09-12 con:
--   prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script
--
-- POR QUÉ EXISTE, Y POR QUÉ LLEGÓ TARDE
--
-- Se escribió primero la migración de integridad (20260912000001_integrity)
-- dando por sentado que ya existía una baseline. No existía. El resultado era
-- que `prisma migrate deploy` sobre una base limpia moría en su primera
-- sentencia con `relation "users" does not exist`: la de integridad es toda
-- ALTER TABLE y CREATE INDEX sobre tablas que nada creaba.
--
-- EL ORDEN IMPORTA Y ESTÁ DADO POR EL NOMBRE. Esta migración es
-- ...000000_baseline y la de integridad ...000001_integrity, así que baseline
-- corre primero. Si alguna vez se renombran, ese orden hay que preservarlo:
-- la capa de integridad no puede aplicarse sobre un esquema vacío.
--
-- Esta migración es generada; la de integridad es escrita a mano. Ver
-- prisma/README.md antes de tocar cualquiera de las dos.
-- ============================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "project_role" AS ENUM ('HOST', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "diagram_lock_state" AS ENUM ('UNLOCKED', 'LOCKED_BY_HOST');

-- CreateEnum
CREATE TYPE "element_kind" AS ENUM ('PACKAGE', 'CLASS', 'INTERFACE', 'ENUMERATION', 'DATATYPE', 'PRIMITIVE_TYPE', 'COMMENT');

-- CreateEnum
CREATE TYPE "feature_kind" AS ENUM ('ATTRIBUTE', 'OPERATION');

-- CreateEnum
CREATE TYPE "relationship_kind" AS ENUM ('ASSOCIATION', 'GENERALIZATION', 'INTERFACE_REALIZATION', 'DEPENDENCY', 'USAGE');

-- CreateEnum
CREATE TYPE "visibility" AS ENUM ('PUBLIC', 'PRIVATE', 'PROTECTED', 'PACKAGE');

-- CreateEnum
CREATE TYPE "aggregation_kind" AS ENUM ('NONE', 'SHARED', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "parameter_direction" AS ENUM ('IN', 'OUT', 'INOUT', 'RETURN');

-- CreateEnum
CREATE TYPE "op_actor_kind" AS ENUM ('USER', 'AI', 'IMPORT');

-- CreateEnum
CREATE TYPE "ai_input_mode" AS ENUM ('TEXT', 'VOICE', 'IMAGE');

-- CreateEnum
CREATE TYPE "ai_turn_status" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "xmi_version" AS ENUM ('XMI_2_1', 'XMI_2_5_1');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" INET,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "project_role" NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE "diagrams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "lock_state" "diagram_lock_state" NOT NULL DEFAULT 'UNLOCKED',
    "locked_by" UUID,
    "locked_at" TIMESTAMPTZ(6),
    "current_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "diagrams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagram_join_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "max_uses" INTEGER,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "diagram_join_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_elements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "parent_id" UUID,
    "kind" "element_kind" NOT NULL,
    "name" TEXT,
    "is_abstract" BOOLEAN NOT NULL DEFAULT false,
    "stereotype" TEXT,
    "body" TEXT,
    "xmi_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uml_elements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_features" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_id" UUID NOT NULL,
    "kind" "feature_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "visibility" NOT NULL DEFAULT 'PRIVATE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "type_element_id" UUID,
    "type_name" TEXT,
    "lower_bound" INTEGER NOT NULL DEFAULT 1,
    "upper_bound" INTEGER DEFAULT 1,
    "default_value" TEXT,
    "is_static" BOOLEAN NOT NULL DEFAULT false,
    "is_readonly" BOOLEAN NOT NULL DEFAULT false,
    "is_derived" BOOLEAN NOT NULL DEFAULT false,
    "is_abstract" BOOLEAN NOT NULL DEFAULT false,
    "is_query" BOOLEAN NOT NULL DEFAULT false,
    "xmi_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uml_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_parameters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "direction" "parameter_direction" NOT NULL DEFAULT 'IN',
    "type_element_id" UUID,
    "type_name" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "default_value" TEXT,
    "xmi_id" TEXT,

    CONSTRAINT "uml_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_enum_literals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enumeration_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "xmi_id" TEXT,

    CONSTRAINT "uml_enum_literals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_relationships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "kind" "relationship_kind" NOT NULL,
    "source_element_id" UUID NOT NULL,
    "target_element_id" UUID NOT NULL,
    "name" TEXT,
    "stereotype" TEXT,
    "xmi_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "uml_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uml_relationship_ends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "relationship_id" UUID NOT NULL,
    "end_index" SMALLINT NOT NULL,
    "element_id" UUID NOT NULL,
    "role_name" TEXT,
    "lower_bound" INTEGER NOT NULL DEFAULT 0,
    "upper_bound" INTEGER DEFAULT 1,
    "is_navigable" BOOLEAN NOT NULL DEFAULT true,
    "aggregation" "aggregation_kind" NOT NULL DEFAULT 'NONE',
    "xmi_id" TEXT,

    CONSTRAINT "uml_relationship_ends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "element_layouts" (
    "element_id" UUID NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "z_index" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "element_layouts_pkey" PRIMARY KEY ("element_id")
);

-- CreateTable
CREATE TABLE "relationship_layouts" (
    "relationship_id" UUID NOT NULL,
    "waypoints" JSONB NOT NULL DEFAULT '[]',
    "source_anchor" TEXT,
    "target_anchor" TEXT,

    CONSTRAINT "relationship_layouts_pkey" PRIMARY KEY ("relationship_id")
);

-- CreateTable
CREATE TABLE "diagram_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "op_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_kind" "op_actor_kind" NOT NULL DEFAULT 'USER',
    "ai_turn_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagram_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagram_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "version" BIGINT NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagram_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xmi_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "user_id" UUID,
    "source_filename" TEXT NOT NULL,
    "detected_version" "xmi_version" NOT NULL,
    "source_encoding" TEXT,
    "exporter" TEXT,
    "element_count" INTEGER NOT NULL DEFAULT 0,
    "unsupported" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xmi_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_ai_configs" (
    "project_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gemini',
    "model" TEXT NOT NULL DEFAULT 'gemini-flash',
    "api_key_cipher" BYTEA,
    "fallback_chain" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_ai_configs_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "ai_turns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "diagram_id" UUID NOT NULL,
    "user_id" UUID,
    "input_mode" "ai_input_mode" NOT NULL,
    "prompt_text" TEXT,
    "image_sha256" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fallback_fired" BOOLEAN NOT NULL DEFAULT false,
    "fallback_from" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "status" "ai_turn_status" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_replaced_by_key" ON "refresh_tokens"("replaced_by");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");

-- CreateIndex
CREATE INDEX "project_members_user_id_role_idx" ON "project_members"("user_id", "role");

-- CreateIndex
CREATE INDEX "diagrams_project_id_idx" ON "diagrams"("project_id");

-- CreateIndex
CREATE INDEX "diagram_join_codes_diagram_id_idx" ON "diagram_join_codes"("diagram_id");

-- CreateIndex
CREATE INDEX "uml_elements_diagram_id_idx" ON "uml_elements"("diagram_id");

-- CreateIndex
CREATE INDEX "uml_elements_parent_id_idx" ON "uml_elements"("parent_id");

-- CreateIndex
CREATE INDEX "uml_elements_diagram_id_xmi_id_idx" ON "uml_elements"("diagram_id", "xmi_id");

-- CreateIndex
CREATE INDEX "uml_features_owner_id_kind_position_idx" ON "uml_features"("owner_id", "kind", "position");

-- CreateIndex
CREATE INDEX "uml_features_type_element_id_idx" ON "uml_features"("type_element_id");

-- CreateIndex
CREATE INDEX "uml_parameters_type_element_id_idx" ON "uml_parameters"("type_element_id");

-- CreateIndex
CREATE UNIQUE INDEX "uml_parameters_operation_id_position_key" ON "uml_parameters"("operation_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uml_enum_literals_enumeration_id_name_key" ON "uml_enum_literals"("enumeration_id", "name");

-- CreateIndex
CREATE INDEX "uml_relationships_diagram_id_idx" ON "uml_relationships"("diagram_id");

-- CreateIndex
CREATE INDEX "uml_relationships_source_element_id_idx" ON "uml_relationships"("source_element_id");

-- CreateIndex
CREATE INDEX "uml_relationships_target_element_id_idx" ON "uml_relationships"("target_element_id");

-- CreateIndex
CREATE INDEX "uml_relationship_ends_element_id_idx" ON "uml_relationship_ends"("element_id");

-- CreateIndex
CREATE UNIQUE INDEX "uml_relationship_ends_relationship_id_end_index_key" ON "uml_relationship_ends"("relationship_id", "end_index");

-- CreateIndex
CREATE INDEX "diagram_operations_diagram_id_version_idx" ON "diagram_operations"("diagram_id", "version");

-- CreateIndex
CREATE INDEX "diagram_operations_ai_turn_id_idx" ON "diagram_operations"("ai_turn_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagram_operations_diagram_id_version_key" ON "diagram_operations"("diagram_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "diagram_operations_diagram_id_op_id_key" ON "diagram_operations"("diagram_id", "op_id");

-- CreateIndex
CREATE INDEX "diagram_snapshots_diagram_id_version_idx" ON "diagram_snapshots"("diagram_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "diagram_snapshots_diagram_id_version_key" ON "diagram_snapshots"("diagram_id", "version");

-- CreateIndex
CREATE INDEX "xmi_imports_diagram_id_imported_at_idx" ON "xmi_imports"("diagram_id", "imported_at" DESC);

-- CreateIndex
CREATE INDEX "ai_turns_diagram_id_created_at_idx" ON "ai_turns"("diagram_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_turns_user_id_created_at_idx" ON "ai_turns"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_turns_status_idx" ON "ai_turns"("status");

-- CreateIndex
CREATE INDEX "audit_log_entries_project_id_created_at_idx" ON "audit_log_entries"("project_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_fkey" FOREIGN KEY ("replaced_by") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_locked_by_fkey" FOREIGN KEY ("locked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_join_codes" ADD CONSTRAINT "diagram_join_codes_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_join_codes" ADD CONSTRAINT "diagram_join_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_elements" ADD CONSTRAINT "uml_elements_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_elements" ADD CONSTRAINT "uml_elements_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "uml_elements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_features" ADD CONSTRAINT "uml_features_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "uml_elements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_features" ADD CONSTRAINT "uml_features_type_element_id_fkey" FOREIGN KEY ("type_element_id") REFERENCES "uml_elements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_parameters" ADD CONSTRAINT "uml_parameters_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "uml_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_parameters" ADD CONSTRAINT "uml_parameters_type_element_id_fkey" FOREIGN KEY ("type_element_id") REFERENCES "uml_elements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_enum_literals" ADD CONSTRAINT "uml_enum_literals_enumeration_id_fkey" FOREIGN KEY ("enumeration_id") REFERENCES "uml_elements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_relationships" ADD CONSTRAINT "uml_relationships_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_relationships" ADD CONSTRAINT "uml_relationships_source_element_id_fkey" FOREIGN KEY ("source_element_id") REFERENCES "uml_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_relationships" ADD CONSTRAINT "uml_relationships_target_element_id_fkey" FOREIGN KEY ("target_element_id") REFERENCES "uml_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_relationship_ends" ADD CONSTRAINT "uml_relationship_ends_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "uml_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uml_relationship_ends" ADD CONSTRAINT "uml_relationship_ends_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "uml_elements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "element_layouts" ADD CONSTRAINT "element_layouts_element_id_fkey" FOREIGN KEY ("element_id") REFERENCES "uml_elements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationship_layouts" ADD CONSTRAINT "relationship_layouts_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "uml_relationships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_operations" ADD CONSTRAINT "diagram_operations_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_operations" ADD CONSTRAINT "diagram_operations_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_operations" ADD CONSTRAINT "diagram_operations_ai_turn_id_fkey" FOREIGN KEY ("ai_turn_id") REFERENCES "ai_turns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagram_snapshots" ADD CONSTRAINT "diagram_snapshots_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xmi_imports" ADD CONSTRAINT "xmi_imports_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xmi_imports" ADD CONSTRAINT "xmi_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_ai_configs" ADD CONSTRAINT "project_ai_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_diagram_id_fkey" FOREIGN KEY ("diagram_id") REFERENCES "diagrams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_turns" ADD CONSTRAINT "ai_turns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


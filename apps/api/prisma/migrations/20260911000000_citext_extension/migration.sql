-- La migración baseline (20260912000000) declara columnas CITEXT (users.email,
-- join_codes.code), pero la extensión recién se crea en 20260912000001_integrity.
-- Sobre una base vacía, `prisma migrate deploy` falla en baseline con
-- «type "citext" does not exist». Esta migración lleva un timestamp anterior
-- para correr primero en bases nuevas (offline, hosteada); en las bases que ya
-- tienen las tres migraciones aplicadas es un no-op por el IF NOT EXISTS.
CREATE EXTENSION IF NOT EXISTS citext;

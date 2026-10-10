-- ARIAN TERMINAL — backup readiness metadata audit
-- READ ONLY: SQL SELECT statements against PostgreSQL catalogs.
-- Do not run against a public endpoint. Use an authorized Supabase SQL editor.
-- No passwords, user rows, tokens, or production mutations are involved.

-- 1. Schema inventory / RLS coverage / object kinds.
SELECT
  n.nspname AS schema_name,
  c.relkind AS object_kind,
  count(*) AS object_count,
  count(*) FILTER (WHERE c.relrowsecurity) AS rls_enabled_count,
  count(*) FILTER (WHERE c.relforcerowsecurity) AS force_rls_count
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
GROUP BY n.nspname, c.relkind
ORDER BY n.nspname, c.relkind;

-- 2. Large user tables (size estimate only, no row reads).
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  pg_catalog.pg_total_relation_size(c.oid) AS total_bytes,
  c.reltuples::bigint AS estimated_rows,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls,
  pg_catalog.pg_get_userbyid(c.relowner) AS table_owner
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
ORDER BY total_bytes DESC
LIMIT 25;

-- 3. Existing backup role flags, if any. Never expose password hashes.
SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_catalog.pg_roles
WHERE rolname = 'arian_backup_reader';

-- 4. Non-system schemas with table-level RLS policies.
SELECT
  schemaname, tablename,
  count(*) AS policy_count
FROM pg_catalog.pg_policies
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
GROUP BY schemaname, tablename
ORDER BY schemaname, tablename;

-- NOTE: A full pg_dump ordinarily disables row_security and fails if a
-- non-bypass role cannot dump protected rows. Do not set --enable-row-security
-- to suppress such errors: a partial backup is NOT a recovery backup.
-- Supabase Storage object bytes are outside a logical PostgreSQL dump.

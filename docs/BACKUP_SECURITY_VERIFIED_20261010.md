# Backup safety gate — 2026-10-10

## Verified live
- GitHub Environment `arian-backup-secure`: only branch `arian-backup-only` matches its deployment rule; Admin bypass disabled. No secrets or variables at last audit.
- Active branch ruleset ID 24831971: exact `arian-backup-only` target, `Restrict deletions` enabled, `Block force pushes` enabled. No bypass actors, no forced PR reviews/status checks; other branches unaffected.
- GitHub checks on dedicated branch previously passed: https://github.com/shahrokh5535-cmd/arian-terminal-worke/actions/runs/38028460037.
- Supabase role audit on 2026-10-10: `postgres` is login-enabled with BYPASSRLS/CREATEROLE/CREATEDB; `service_role` is non-login and BYPASSRLS; `authenticator` is login-enabled. No pre-existing roles with `arian%` prefix.
- Current backup scripts are COPY-ONLY examples; neither exports nor restores have been performed.
- **Do not use postgres password or service_role JWT as a backup workflow secret.**

## Remaining hard gates
1. Design dedicated `arian_backup_reader` PostgreSQL LOGIN role. It needs CONNECT, USAGE on required schemas, SELECT on required tables, and other minimal permissions for pg_dump metadata/sequence handling. Audit RLS: FORCE RLS, SECURITY DEFINER, extension-owned schemas, and objects outside public; otherwise an RLS-scoped dump may silently omit rows. Validate `pg_dump` of a representative table against known row counts before trusting any backup.
2. Secret provisioning must use the protected Environment only. Existing branch rules block deletion/force push but DO NOT prevent a writer from adding arbitrary workflow steps, so reviewer/approval safeguards and identity controls need assessment; repository is PUBLIC.
3. PostgreSQL 17 `pg_dump`, age recipient (public half only), secure database connection, and controlled upload credentials are not yet configured. Store the age private identity ONLY with owner offline.
4. Scope explicitly: complete project DR may additionally require `pg_dumpall --globals-only`, roles/grants, extensions, Supabase auth/storage objects, and object-storage files. A PG-only dump is NOT a complete Supabase recovery plan.
5. Do an actual encrypted export and independent Drive download + SHA-256 verify, decrypt, isolated PostgreSQL 17 restore, compare row counts and sample constraints. Retention/deletion changes remain prohibited until successful independent restore and a separately reviewed migration.

## Live changes in this milestone
GitHub ruleset creation only. Supabase role state was read using a SELECT-only query; no SQL write. No worker deployment, database export, delete or billing change.

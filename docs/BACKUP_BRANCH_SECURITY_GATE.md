# ARIAN backup-only environment — execution gate

Date: 2026-10-09
Repository: shahrokh5535-cmd/arian-terminal-worke (PUBLIC)
Branch: arian-backup-only (created off draft PR #8 safety code, not production main)
GitHub Environment: arian-backup-secure (created by owner)

## No-secrets stage
- GitHub Actions workflow `.github/workflows/arian-backup-preflight.yml` checks source and shell syntax **offline** only.
- It has no `environment:` declaration and requests only `contents: read`.
- It reads NO environment secrets and performs NO connections, exports, uploads, deployments, or SQL writes.
- This is deliberately not a working database backup.
- Production Worker main and Cloudflare arena23 must remain unchanged.

## IMPORTANT: Before any secrets
- Confirm the environment Branch policy has exact name `arian-backup-only` (not translation, pattern mismatch, or `main`); the UI should report 1 matching branch.
- **GitHub environment branch allowlisting is not a branch CODE protection mechanism.** The repo is public and owners/collaborators with write permission can modify workflows on the allowed branch.
- Inspect GitHub Branch Protection / Rulesets to require approval for changes to `.github/workflows/**`, `scripts/**`, and branch `arian-backup-only`; restrict who can push where supported. Do not put secrets into this Environment before that audit.
- Avoid the production superuser password as an Actions secret; prefer a dedicated read-only Postgres role with the least necessary grants created through an audited additive migration.
- Prepare a recoverable user-held age key pair; never upload the age secret/private key to Drive, GitHub or ChatGPT. Store it offline and test decryption before exporting any database data.
- Obtain a secure transfer method/identity to Drive without committing OAuth refresh tokens to source, and test it using non-sensitive dummy data.
- Verify Github Actions usage limits, retention of logs/artifacts, storage and trusted third-party actions before connecting Production.
- Carefully assess full logical restore: a selected-table custom format dump does NOT contain complete referenced schema or all dependent data. Do not claim complete disaster recovery on partial copies.

## Never automate destruction
No DELETE / TRUNCATE / DROP, no source retention changes, no Vacuum Full, no Worker or Fusion migration, no enabling R2 billing. Archived raw_events is copy-only. A separate full restore-test and documented approvals gate any future retention plan.

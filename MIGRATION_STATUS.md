# Collector migration status

Project `ctikvqtvzoaqqgnxqbgu`; repository name remains `arian-terminal-worke`.
Live worker: **0.11.0** (startup 2026-10-01 13:27:49 UTC).
All historical functions/jobs remain available. No retention, table drops, RLS relaxations, or scoring-weight changes.

| Collector | Legacy cron IDs | Worker | External RPC | Status / last verification | Rollback |
|---|---|---|---|---|---|
| Canonical DexScreener | 1,2 | 0.8.1 | arian_external_ingest_dexscreener_v1 | Migrated; snapshot success 06:34 UTC, legacy inactive | Stop collector; enable 1,2 |
| Jupiter quote | 3,4 | 0.8.1 | arian_external_ingest_jupiter_v1 | Migrated; 06:30 delivery timeout had committed successfully; next 06:34 scheduler success, legacy inactive | Stop collector; enable 3,4 |
| Canonical Solana signatures | 5 | 0.8.1 | arian_external_ingest_solana_signatures_v1 | Migrated; 3 new signatures at 06:34 UTC, legacy inactive | Stop collector; enable 5 |
| Solana details | 6 (mixed job split) | 0.8.1 | arian_external_claim_solana_transaction_details_v1 / arian_external_ingest_solana_transaction_detail_v1 | Two distinct successful cycles 06:31 and 06:34; 4 raw details, 0 errors. HTTP cutover ~06:38 UTC; job 6 active with DB-only command | Set ENABLE_SOLANA_DETAILS_INGEST=false; restore job 6 command SELECT public.arian_run_solana_transaction_worker(); active=true |
| Canonical RugCheck SOL | 9 | 0.8.1 | arian_external_ingest_rugcheck_v1 | Migrated; external assessment success 06:30 UTC, job 9 inactive | Stop canonical collector; enable 9 |
| Discovered-token risk HTTP | 18 mixed; 10 DB-local | 0.10.0 | arian_external_claim_discovered_risk_v1 / arian_external_ingest_discovered_risk_v1 / arian_external_peek_discovered_risk_v1 | Migrated: batches 12:23/12:26 UTC, four successful runs, processed raw events and current risk verified. Job 18 disabled 12:27:13 UTC; DB-only 10 remains active | Set ENABLE_DISCOVERED_RISK_INGEST=false; ensure 18/10 active |
| Discovered-token RugCheck finalizer | 10 (DB-local; 18 inactive) | DB-local | Existing arian_run_rugcheck_worker | Kept active: disabling it had stranded discovered-token assessments; two recovered at 05:48 UTC | Keep available for legacy drain/rollback |
| Token Discovery | 12,13 | 0.8.1 | arian_external_ingest_token_discovery_v1 | Two cycles 06:31/06:39 successful, each 2 raw records; latter created 3 instances/events/scores. Job 12 disabled ~06:41; legacy drained, then 13 disabled | Set ENABLE_TOKEN_DISCOVERY=false; enable 12,13 |
| Jupiter Token Enrichment | 16,17 | 0.8.1 | arian_external_claim_jupiter_token_enrichment_v1 / arian_external_ingest_jupiter_token_enrichment_v1 | Two cycles 06:30/06:34, 0 errors, 2 raw records each, decimals/metadata/route updated. Both jobs disabled ~06:38 UTC | Set ENABLE_JUPITER_TOKEN_ENRICHMENT=false; enable 16,17 |
| Promoted market snapshots | 20 HTTP/selection; 21 DB-local | 0.9.0 | arian_external_claim_promoted_market_v1 / arian_external_peek_promoted_market_v1 / arian_external_ingest_promoted_market_v1 | Two cycles 11:26/11:29 successful, snapshots 3782/3785 and raw events verified, error_count=0. Job 20 disabled 11:33:24 UTC; DB-only 21 active | Stop new collector; ensure 20,21 active |
| Promoted pool signatures | 23 HTTP/selection; 24 DB-local | 0.9.0 | arian_external_claim_promoted_signatures_v1 / arian_external_peek_promoted_signatures_v1 / arian_external_ingest_promoted_signatures_v1 | Two cycles 11:26/11:29 successful, 3 signatures matched normalized transactions per batch, error_count=0. Job 23 disabled 11:33:24 UTC; DB-only 24 active | Stop new collector; ensure 23,24 active |
| X linked public posts | 30 mixed; 31 DB-local | 0.11.0 | arian_external_peek_x_public_social_v1 / arian_external_claim_x_public_social_v1 / arian_external_ingest_x_public_social_v1 | Deployed; probe success, first real scheduler run 13958 at 13:57 UTC verified. Await second cycle; 30/31 active | Set ENABLE_X_PUBLIC_SOCIAL_INGEST=false; ensure 30/31 active |
| X profile timelines | 32 mixed; 33 DB-local | legacy | Existing functions | Selected account unavailable (404); same endpoint works for Solana. Handle backoff applied; legacy HTTP retained | Keep 32/33 available |

## Production cutover evidence

0.8.1 `/health` and `/status`: 200. Discovery, enrichment and detail probes: 200/success/writes_to_supabase=false.
External run IDs: details 13104/13105 (one cycle), 13112/13113 (second cycle);
enrichment 13102 and 13111; discovery 13103 and 13120.
All successful with error_count=0 and transport=blitz_worker.
Raw/normalized records checked directly; discovery 13120 had 3 instances, 3 discovery events and 3 scores.
Job 6 command is now `SELECT public.arian_run_solana_local_processing_v1();`.
It drains old detail responses and runs canonical swap detection without enqueueing HTTP.
Job 26 retains PumpSwap detection; job 10 retains discovered-risk finalization.
Old discovery requests were drained before job 13 was disabled.

## Promoted collector verification / cutover

Live 0.9.0 `/health` and `/status`: 200, both schedulers enabled (5-minute intervals).
`/probe/promoted-market` and `/probe/promoted-signatures`: 200/success/writes_to_supabase=false.
The earlier workspace HTTP 403 did not recur from Blitz.
Two independent scheduled cycles after current startup:
market runs 13593/13599, snapshots 3782/3785; signature runs 13594/13598, 3 transactions touched per batch.
All successful with error_count=0, transport=blitz_worker; raw evidence and normalized records checked.
HTTP jobs 20 and 23 disabled at **2026-10-01 11:33:24.945 UTC**. DB-only 21 and 24 remain active.
One outstanding legacy market run from 11:32 was finalized successfully at 11:33:31; no enqueue restored.
No scoring logic moved to Node. Existing market_score result `not_ready` was preserved and does not mean API ingestion failed.
Claims serialize on connector, respect outstanding runs, expire abandoned runs after 10 minutes.
Run ID ingestion is idempotent. RPC ACLs checked: SECURITY DEFINER/search_path=pg_catalog; service_role/postgres only.
Security advisor reports only existing informational RLS-without-policy findings.

## Detail freshness correction

At 11:28, canonical detail processing lagged: last processed block 07:18 despite fresh signatures arriving at 11:29.
Read-only eligibility count found 65 finalized canonical transactions pending; 830 unclaimed total included ineligible/failed transactions.
`db/detail_claim_freshness.sql` replaces only selection in the existing claim RPC (no Node redeploy).
The same 2-request/5-minute budget now reserves odd slots for canonical work, preferring blocks from the last 10 minutes.
Even slots prefer promoted pools, then oldest canonical backlog. Empty groups fall back to other eligible transactions.
Locking/leases/attempt limits remain intact. A rolled-back SQL test verified fresh canonical selection and distinct held claims.
Apply this SQL after the initial `db/solana_external_details.sql` if rebuilding preparation files.
Rollback of selection alone: original definition remains in the initial preparation file; ingestion remains unchanged.

## Remaining collector audit

18: mixed DB selection plus RugCheck HTTP; HTTP migrated in 0.10.0, enqueue inactive; DB-only 10 retained.
19: DB-local promotion, keep in Supabase.
30: mixed DB target selection plus free FxTwitter HTTP; 31: DB-local response handling/scoring.
32: mixed DB selection plus profile HTTP; 33: DB-local response handling/scoring.
X mirror has recent successes and failures; source stability must be proven before any legacy cutover.

## Storage baseline / recovery history

2026-10-01 ~05:36 UTC total relation bytes / estimated rows:
asset_feature_snapshots 278,233,088 / 116,497; wallet_feature_snapshots 135,921,664 / 194,028;
raw_events 131,760,128 / 20,236; ingestion_runs 10,428,416 / 12,981;
blockchain_transactions 10,125,312 / 7,357; cron.job_run_details 27,983,872.
No measured IO/CPU reduction claimed; history size is a separate retention phase requiring explicit approval.
Original disabled-job-6 gap was recovered at ~05:34; 16 detail records and new swaps advanced to 05:51 before external cutover.
Full production audit dump stays outside the repository. Published SQL contains only the targeted authorized RPC definitions.

Post-cutover check 2026-10-01 06:48 UTC: jobs 12/13/16/17 inactive, job 6 DB-only active;
external details/enrichment succeeded at 06:39 and 06:44 with zero errors; latest swap at 06:45.
Live 0.8.1 health/status healthy. New 0.9.0 local health/status both 200, seven new collector tests passed.
Rolled-back SQL verified market/signature ingestion idempotence and signature failure release.

06:50 verification: external discovery 13145 created 3 further records after legacy disable;
enrichment 13146 and details 13147/13148 succeeded, error_count=0.
One legacy Jupiter request (13116) had started at 06:38 just before cutover;
manually drained both token/route stages successfully at ~06:51 without re-enabling enqueue cron.
0.9.0 code was published in commit d48f41e and deployed; current promoted cutover evidence is above.

Post-cutover verification 11:35 UTC: market run 13616 / snapshot 3788 and signature run 13617
succeeded after jobs 20/23 were disabled; one raw event each, error_count=0. No pending legacy promoted runs.
Balanced detail selection succeeded in real Blitz runs 13619/13620: canonical block 11:29:26 and
oldest backlog block 07:23:22 both processed at 11:34, preserving the existing two-fetch budget.
Claim ACLs/security_definer/search_path rechecked. This SQL/documentation update needs no Blitz rebuild.

11:36 UTC downstream proof: a new swap was inserted at 11:36:00; job 6 DB-local cron succeeded.
Jobs 20/23 inactive and 6/21/24/26 active. Canonical detail freshness correction now advances swap detection.

## Discovered-risk preparation (2026-10-01 ~11:55 UTC)

New RPCs keep legacy target selection and risk normalization/scoring DB-side.
Claims lock asset rows with SKIP LOCKED, exclude pending legacy runs, cap at two,
expire abandoned external claims after 15 minutes, and preserve dataset token_report_summary.
404 backoff six hours; 429 ten minutes; other failures fifteen minutes.
Run-ID locks make ingestion idempotent. ACL checks: SECURITY DEFINER,
search_path=pg_catalog, no anon/authenticated execution, service_role/postgres only.
Rolled-back SQL verified distinct claims, exact safety conversion, one raw event on retry,
and failed-claim 404 backoff. No test assessments/runs were retained.
Five module tests passed: read-only probe, failure isolation/release, identical retry,
null-score rejection, and overlap lock. Full existing test suite also passed.
Live /health and /status remain 200/v0.9.0; all nine collectors report success.
Latest external runs 13659–13662 at 11:54 UTC succeeded with zero errors.
No job 18 cutover yet; external scheduled risk evidence requires deployment.

Social audit: over the sampled three hours, linked-post ingestion had 3 successes,
14 failures and one running request; profile ingestion had 18 failures and no success.
Jobs 30/32 are mixed HTTP/DB; 31/33 are DB-local. Leave all active while source
stability is unresolved; no paid API introduced. Job 19 remains DB-only.

## Discovered-risk production cutover (2026-10-01 12:27 UTC)

0.10.0 health/status 200. New scheduler enabled, interval 600000 ms.
Read-only /probe/discovered-risk: 200/success/writes_to_supabase=false.
Two independent real scheduler batches: 13728/13729 at 12:23:54 and 13741/13742
at 12:26:19 (a deployment restart occurred between these startup batches).
All four transport=blitz_worker, success, error_count=0, records_fetched/inserted=1.
Raw events 21171/21172/21187/21188 processed; corresponding asset_risk_current
assessments advanced, safety scores 99/67/71/66. No synthetic test runs used.
Guarded cutover disabled job 18 at 2026-10-01T12:27:13.928873Z.
Jobs 10 and 19 remain active; no pending legacy RugCheck requests.
Post-cutover status 12:27:20: worker 0.10.0, scheduler enabled, last batch success.
Rollback: set ENABLE_DISCOVERED_RISK_INGEST=false, then
SELECT cron.alter_job(18, active := true); keep job 10 active.
No rebuild is needed for this documentation-only update.

## X connection audit (2026-10-01 ~12:42 UTC)

User requested checking free X news collection before obtaining an official API key.
A read-only request to https://api.fxtwitter.com/status/2105630940537983114
returned HTTP 200, code=200, matching tweet ID and nonempty text.
The existing profile timeline request for peeledstickers returned HTTP 404.
This confirms individual public post retrieval works, but profile timeline retrieval
is unresolved; account login alone does not supply an API integration.
Seven linked-token post ingestions succeeded in the sampled three hours.
Production runs 13697/13730/13763 were joined to processed raw events,
content_items with nonempty text, and token content_mentions.
Latest verified success: 2026-10-01 12:41 UTC, content 912 / raw event 21221.
This is collection of discovery-linked public posts, not broad X search or complete timelines.
No official API key, account cookies, paid API, scoring changes, or cron cutover added.
Jobs 30/31/32/33 remain available and active while replacement scope is evaluated.

## Linked X public-post preparation (2026-10-01 ~13:20 UTC)

Current GitHub HEAD was inspected before edits: 0fbe270; deployed worker is 0.10.0.
Only job 30 external HTTP is prepared for offload; job 31 DB-local and jobs 32/33 remain active.
The three new RPCs are SECURITY DEFINER/search_path=pg_catalog;
PUBLIC/anon/authenticated revoked, service_role/postgres granted and verified.
Target selection preserves discovery-link provenance and promotion-hold filtering,
uses explicit x.com/twitter.com domain matching, excludes ingested posts/pending claims,
and adds per-post retry_after for failed external requests. Connector row lock serializes claims.
One request per ten-minute cycle; abandoned external claims expire after ten minutes.
External ingestion preserves the original finalizer's normalization, influencer/content/mention
upserts and social scoring/confidence policy. Payload ID must match the claimed post.
Existing implicit link attribution is preserved; it is not proof of token endorsement or a wallet buy.
Rolled-back SQL tests verified pending-claim exclusion, mismatched-ID rejection,
one raw event on repeated ingestion, content mention presence, and six-hour 404 backoff.
No synthetic external run was retained (confirmed external x_public_social run count = 0).
Seven Node tests passed; full existing suite passed; local health/status 200/v0.11.0.
Read-only workspace provider probe at 13:19:50: success, writes_to_supabase=false,
post 2105638157492326666, author devilsiopf. Workspace Node uses the session proxy
for this check; production still uses native fetch without added dependencies.
Security advisor shows only existing informational RLS-without-policy findings:
https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
No job 30 cutover, profile migration, paid API, or official X credentials added.
After deployment: check /health,/status,/probe/x-social; verify two scheduled successful
blitz_worker runs with zero errors, processed raw events, content and mention/scoring updates;
then disable only job 30 and verify freshness. Keep job 31 for legacy drain/rollback.

## X shadow-scheduler overlap repair (2026-10-01 13:57 UTC)

Live 0.11.0 health/status and /probe/x-social: HTTP 200; probe success and no writes.
The deployed scheduler initially idled because each legacy HTTP request had returned,
but job 31 finalized it after the external timer's ten-minute slot.
Claim RPC now drains at most one already-returned legacy linked-post response using
the existing DB-only finalizer, before taking the connector lock. Run locks use SKIP LOCKED;
lock order remains run then connector. Unresolved requests still block claims.
No HTTP enqueue, cron disable or Node change was required for this SQL correction.
Prepared SQL file updated; claim SECURITY DEFINER/search_path/ACL verified again.
Rolled-back SQL exercised duplicate-claim exclusion and failure release.
First actual Blitz run 13958 at 13:57:51: success/error_count=0, fetched/inserted=1.
Raw event 21426 processed, content 923 has text, token mention exists, DB social score
48.25/confidence 65.75 and last-source evidence updated. Existing attribution/scoring preserved.
Job 30 remains active until a second successful scheduler cycle is verified.
Rollback of this shadow drain alone: remove the pre-lock legacy drain block from the
claim RPC; original guard then returns pending_linked_post until job 31 processes it.

## Profile source diagnosis / selection backoff (2026-10-01 14:05 UTC)

Upstream current routes document /2/profile/{handle}/statuses:
https://github.com/FxEmbed/FxEmbed/blob/main/src/realms/api/routes.ts
Read-only HTTP tests: peeledstickers profile and timeline return 404/User not found;
the same timeline endpoint for Solana returns 200 with posts. The endpoint itself
is available; production's first eligible account was monopolizing polling slots.
All 18 sampled three-hour profile failures targeted peeledstickers / asset instance 35.
`db/x_profile_legacy_backoff.sql` preserves existing function name, HTTP endpoint,
normalization, privilege ACL and SECURITY INVOKER behavior. It adds only a handle-level
failed-request backoff (404 six hours, other failures fifteen minutes), allowing
existing next-target selection to continue to other accounts.
Rolled-back validation: asset instance 35 returned NULL and created no new run/request.
Jobs 32/33 remain active; this is a selection repair, not an external profile cutover.
A successful next-account scheduled profile ingestion still needs verification.
Rollback: remove the marked backoff IF block from this preparation definition.
No API key, X account login, paid service, Node change or rebuild is required.

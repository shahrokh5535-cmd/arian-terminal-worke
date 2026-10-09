-- ARIAN TERMINAL: read-only promoted market/Fusion readiness verification.
-- Verified against Supabase production on 2026-10-08 19:30:52 UTC.
-- This script does not claim work, write data, relax gates, or change schema.
-- Run before/after a controlled Worker canary; compare results after >=30 minutes.
-- The gate function below was inspected: it reads existing scoring/snapshot tables.
WITH eligible AS (
  SELECT DISTINCT m.id AS market_id, lp.token0_instance_id AS asset_instance_id
  FROM public.markets m
  JOIN public.liquidity_pools lp ON lp.market_id = m.id
  JOIN public.venues v ON v.id = m.venue_id
  WHERE m.status = 'active'
    AND lp.status = 'active'
    AND v.venue_key = 'pumpswap'
    AND COALESCE((m.metadata_json ->> 'promoted_from_discovery')::boolean, false) = true
), fresh AS (
  SELECT e.market_id, e.asset_instance_id,
    COUNT(ms.id) FILTER (
      WHERE ms.snapshot_at >= now() - interval '30 minutes'
        AND ms.price_usd IS NOT NULL
        AND ms.liquidity_usd IS NOT NULL
    ) AS valid_snapshots_30m,
    MAX(ms.snapshot_at) FILTER (
      WHERE ms.price_usd IS NOT NULL
        AND ms.liquidity_usd IS NOT NULL
    ) AS newest_valid_at
  FROM eligible e
  LEFT JOIN public.market_snapshots ms ON ms.market_id = e.market_id
  GROUP BY e.market_id, e.asset_instance_id
), readiness AS (
  SELECT f.*, public.arian_check_production_fusion_readiness(f.asset_instance_id) AS gate
  FROM fresh f
)
SELECT now() AS checked_at,
  COUNT(*) AS eligible_markets,
  SUM(valid_snapshots_30m) AS valid_snapshots_30m,
  COUNT(*) FILTER (
    WHERE valid_snapshots_30m >= 3
      AND newest_valid_at >= now() - interval '15 minutes'
  ) AS market_data_ready,
  COUNT(*) FILTER (
    WHERE valid_snapshots_30m BETWEEN 1 AND 2
  ) AS market_data_partial,
  COUNT(*) FILTER (WHERE valid_snapshots_30m = 0) AS market_data_missing,
  COUNT(*) FILTER (WHERE gate ->> 'allowed' = 'true') AS fusion_ready,
  COUNT(*) FILTER (WHERE gate -> 'blockers' ? 'risk_not_ready') AS risk_blocked,
  COUNT(*) FILTER (WHERE gate -> 'blockers' ? 'social_confidence_low') AS social_confidence_blocked
FROM readiness;

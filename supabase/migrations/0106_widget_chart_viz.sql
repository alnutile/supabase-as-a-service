-- Dashboard widgets — richer charts (configuration-as-data, still no per-tenant
-- code). The `dashboard_widgets` schema is unchanged: everything new rides in
-- the existing `spec` jsonb, so this migration only re-teaches the seeded
-- `create_widget` tool the new options. Two additions to a `chart` widget:
--   * spec.viz    — 'bar' (default) | 'line' | 'area' | 'donut'. bar/line/area
--                   draw the per-day time series; donut is a grouped breakdown.
--   * spec.groupBy — an allow-listed dimension to group + count by instead of
--                   the time series: todos→done, artifacts→type, files→mime_type,
--                   activity→type. Validated in src/lib/widgets.ts and
--                   _shared/widgets.ts against a fixed per-source list, so a
--                   stored value is always one of our own columns (never
--                   free-form) and RLS is still the row boundary.
--
-- Idempotent: updates the create_widget row in place (no-op on fresh installs
-- that already seeded 0078, and safe to re-apply). Only the description +
-- input_schema change; the handler already sanitizes via validateWidget.

update public.tools
set
  description = 'Add a widget to the user''s Home dashboard from a description. Pick a `kind`: "stat" (a single count), "list" (recent rows), or "chart". Pick a `source` (the data): todos | artifacts | files | links | collections | activity. Optional `spec`: {"window": today|7d|30d|all, "mine": true, "status": open|done (todos only), "limit": 1-20 (list only), "viz": bar|line|area|donut (chart only), "groupBy": a dimension (chart only)}. A chart defaults to a per-day count for the last 14 days; use viz:"line"/"area" for a trend, or set groupBy for a category breakdown (todos→done, artifacts→type, files→mime_type, activity→type) with viz:"donut" or "bar". Give it a short `title`. Example: "artifacts by type as a donut" → kind:"chart", source:"artifacts", spec:{"groupBy":"type","viz":"donut","mine":true}.',
  input_schema = '{"type":"object","properties":{"title":{"type":"string","description":"Short widget title shown on the card."},"kind":{"type":"string","enum":["stat","list","chart"],"description":"The renderer."},"source":{"type":"string","enum":["todos","artifacts","files","links","collections","activity"],"description":"Which data the widget shows."},"spec":{"type":"object","description":"Optional filters.","properties":{"window":{"type":"string","enum":["today","7d","30d","all"]},"mine":{"type":"boolean"},"status":{"type":"string","enum":["open","done"]},"limit":{"type":"number"},"viz":{"type":"string","enum":["bar","line","area","donut"],"description":"Chart style. bar/line/area = per-day time series; donut = grouped breakdown (needs groupBy)."},"groupBy":{"type":"string","description":"Chart only: group + count by a dimension. Allowed: todos→done, artifacts→type, files→mime_type, activity→type."}}}},"required":["title","kind","source"]}'::jsonb,
  updated_at = now()
where name = 'create_widget' and is_builtin = true;

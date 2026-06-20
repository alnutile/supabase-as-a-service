-- Deterministic webhooks: let a webhook call a tool/function DIRECTLY instead of
-- running its payload through the AI. When `tool_id` is set, the webhook function
-- validates the inbound payload against the tool's input_schema (the "fields and
-- types") and POSTs it straight to the tool — no model, no guardrail needed (the
-- schema validation is the gate). This is the "n8n function node" path and pairs
-- with Forge: forged functions are http tools, so a webhook can drive one.
--
-- Mode precedence in the webhook function: tool_id (deterministic) → agent_id
-- (agent loop) → prompt (bare prompt). Nullable; existing webhooks are unaffected.
alter table public.webhooks
  add column tool_id uuid references public.tools (id) on delete set null;

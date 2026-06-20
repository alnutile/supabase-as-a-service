-- Optional per-webhook shared secret. When set, the webhook function requires the
-- caller to present it (Authorization: Bearer <secret>  OR  X-Webhook-Secret:
-- <secret>) — a real auth check on top of the unguessable URL token, so a leaked
-- URL alone isn't enough. Null = no secret required (unchanged behavior). Like
-- `token`, this is a plaintext shared secret stored on the row (same trust model).
alter table public.webhooks
  add column secret text;

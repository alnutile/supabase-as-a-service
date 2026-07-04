-- http_request responses default to markdown: the builtin now converts an HTML
-- response body to markdown before the 50k-char slice (tag soup wasted most of
-- the budget), with format: "raw" as the escape hatch. This migration teaches
-- the MODEL about it — the seeded tool row's description/input_schema are what
-- the loops advertise, so they must match the new behavior in
-- _shared/builtins.ts. JSON/other content types are untouched either way.
update public.tools
set
  description = 'Make an HTTP request to any web API. HTML responses are converted to markdown automatically (pass format: "raw" for the untouched body); JSON and other content comes back as-is. For authenticated APIs, reference a team vault secret inside a header value, e.g. {"Authorization": "Bearer {{vault:my_api_key}}"} — the placeholder is filled in server-side and the real value never enters the conversation. A secret only works against the hosts listed on it in the Secrets page (Allowed hosts); a secret with no allowed hosts cannot be used here. Use list_secrets to discover available credential names. Prefer a purpose-built tool when one exists.',
  input_schema = '{"type":"object","required":["url"],"properties":{"url":{"type":"string","description":"Full http(s) URL of the endpoint"},"method":{"type":"string","enum":["GET","POST","PUT","PATCH","DELETE"],"description":"Defaults to GET (POST when a body is given)"},"headers":{"type":"object","description":"Request headers; values may embed {{vault:secret_name}}"},"body":{"description":"Request body: an object is sent as JSON, a string as-is"},"format":{"type":"string","enum":["markdown","raw"],"description":"Response handling for HTML pages: markdown (default) converts to readable markdown; raw returns the untouched HTML"}}}'::jsonb
where name = 'http_request' and is_builtin;

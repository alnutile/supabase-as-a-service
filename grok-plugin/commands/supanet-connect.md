---
description: Connect Grok to a SupaNet workspace - check the MCP server, find the right URL, and walk through the OAuth approval.
---

Help the user get the `supanet` MCP server connected. Work through this in order
and stop as soon as it is working.

1. **Check the current state.** Are `supanet` tools (`list_collections`,
   `create_artifact`, `search_documents`, …) available in this session?
   - If yes, confirm it by calling `list_collections` and report what you see -
     workspace reachable, this many collections. Then stop; there is nothing to fix.
   - If no, continue.

2. **Check the environment variable.** Run `echo "${SUPANET_MCP_URL:-(unset)}"`.
   - Unset → the plugin has no workspace to point at. Ask the user for their
     SupaNet app domain (the one they sign in to, e.g. `https://acme.supanet.io`),
     then tell them to run, and persist in their shell profile:
     ```bash
     export SUPANET_MCP_URL="https://<their-domain>/mcp"
     ```
   - Set but pointing at `*.supabase.co/functions/v1/mcp` → this breaks OAuth
     discovery, because Supabase's gateway owns the root on a shared host and
     returns 401 for the well-known documents. Tell them to use the **app
     domain** with `/mcp` instead.
   - Set and app-domain-shaped → move on.

3. **Restart Grok.** The value is read once when the MCP server is launched, so a
   variable exported after startup will not be picked up. Say this explicitly -
   it is the most common reason step 2 "did not work".

4. **Approve the OAuth prompt.** On first connection Grok opens the workspace's
   own login page. The user signs in with their **workspace email and password**
   and approves. There is no API key to paste and no client ID to configure -
   registration is dynamic.

5. **Verify.** Call `list_collections` (or `list_artifacts`) and report the
   result. If a call comes back 401, have them reconnect from `/mcps`. If calls
   are allowed but the data is empty, that may simply be a new workspace - say so
   rather than assuming a fault.

If anything is still failing, read the `supanet-getting-started` skill and use its
troubleshooting table before guessing.

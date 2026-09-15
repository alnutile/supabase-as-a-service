---
name: supanet-tables
description: >-
  Work with SupaNet data tables - real Postgres tables with typed columns - and
  build public write-forms that submit into them from a shared HTML artifact.
  Use when the user wants to create, query, or update a workspace table, track
  structured records, build a contact form / signup sheet / RSVP / lead capture
  page, or when a form embedded in a SupaNet artifact works in Safari but not in
  Chrome or Firefox.
---

# SupaNet tables and public forms

A SupaNet "table" is a **real Postgres table**, not a JSON blob - full SQL power,
typed columns, and proper row-level security. Browsers never run DDL: every
structural change goes through validated security-definer functions, so any
member can create a table without opening an injection surface.

## Tools

| Tool | Notes |
| --- | --- |
| `create_table` | name plus a typed column spec |
| `list_tables` | check before creating - avoid near-duplicates |
| `query_table` | returns **row ids**; supports filters and `since` |
| `add_table_row` | insert one row |
| `update_table_row` | **requires a `match` filter** |
| `delete_table_row` | scoped by a match, same as update |
| `add_table_to_collection` | file a table into a collection |

Column types: `text`, `longtext`, `number`, `integer`, `boolean`, `date`,
`datetime`, `json`.

`update_table_row` requiring a `match` is a deliberate guard - a call cannot
rewrite a whole table by omitting the filter. Pass the narrowest match you can,
and prefer the row id returned by `query_table` over a value match when you have
it.

Visibility mirrors the rest of the workspace: `private` (owner and admins) or
`workspace` (every member reads **and** writes, like a shared base). Say which
you chose when creating one.

## Public write-forms

A table can accept **anonymous** submissions - a contact form or signup sheet
baked into a shared artifact - without ever granting `anon` access to the
underlying table. The owner opts in per table and picks a column **allow-list**;
submissions go to a public endpoint that enforces everything server-side.

### Getting a token

The table's owner creates the form in the app: **Tables → open the table →
Forms → New form**, pick the columns and which are required, then **Copy HTML**
(a ready-made snippet) or **Copy token**. The generated snippet already follows
every rule below - prefer it, and hand-build only when customizing the design.

The `token` is a **public capability id**, like a webhook token. It is safe to
embed in public HTML and it is *not* a secret: the server decides which table and
which columns it maps to. Anything not on the allow-list is dropped, `owner_id`
is forced server-side, it is insert-only, required fields and types are
validated, and submissions are rate-limited per hour.

### The endpoint contract

```
POST https://<project-ref>.supabase.co/functions/v1/form-submit

Body:    { "token": "<form token>", "values": { "<column_key>": <value>, ... } }
200      { "ok": true, "id": "<row id>" }
400      { "error": "..." }                       validation failed
404      { "error": "This form is not available." }
429                                                rate limited
```

Field names must match the table's **column keys** (snake_case), and only the
columns enabled on that form are accepted. A checkbox is only sent when checked,
which is how booleans arrive as `true`.

### Gotcha 1 - the artifact sandbox blocks native form submits

SupaNet artifacts render with `sandbox="allow-scripts"` and **no
`allow-same-origin`, no `allow-forms`** (an opaque origin, deliberately, so user
HTML never touches credentials). So:

- A `type="submit"` button inside a real `<form>` is **blocked by Chromium and
  Firefox before your submit handler runs**. The console shows
  `Blocked form submission because the form's frame is sandboxed and the
  'allow-forms' permission is not set.` Safari is lenient and lets it through.
- **This is the usual cause of "works in Safari, not Chrome/Firefox."** It is not
  a CORS problem; the endpoint's CORS is already correct.

**Rule: never rely on native form submission.** Use `<button type="button">` and
bind a **`click`** handler. No `submit` event, no `type="submit"`, no
`form.requestSubmit()`. Inputs may still live inside a `<form>` for layout and
`reportValidity()` - just never submit it natively.

### Gotcha 2 - use real CORS and read the response

- Use `mode: 'cors'` (the default) with `Content-Type: application/json`.
- **Read the response** (`r.ok`, `r.json()`) so you can report real success or
  failure.
- **Never** use `mode: 'no-cors'`, `text/plain`, `keepalive`, or
  `navigator.sendBeacon`. Those produce an opaque, unreadable response, so the
  page reports "sent" even when nothing was saved - which hides gotcha 1 instead
  of surfacing it.

### Proven template

Style it freely; keep the marked lines exactly.

```html
<form id="signup" novalidate>
  <label>First name<input type="text" name="first_name"></label>
  <label>Last name *<input type="text" name="last_name" required></label>
  <label>Email<input type="email" name="email"></label>
  <!-- type="button" - NOT submit - so the sandbox doesn't block it -->
  <button id="signup-btn" type="button">Submit</button>
  <p id="signup-msg" role="status" aria-live="polite"></p>
</form>
<script>
(function () {
  var ENDPOINT = 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/form-submit';
  var TOKEN = 'YOUR_PUBLIC_FORM_TOKEN';
  var form = document.getElementById('signup');
  var btn  = document.getElementById('signup-btn');
  var msg  = document.getElementById('signup-msg');

  btn.addEventListener('click', function () {         // click, not submit
    if (!form.reportValidity()) return;
    var values = {};
    new FormData(form).forEach(function (v, k) { values[k] = v; });

    btn.disabled = true;
    msg.textContent = 'Sending…';

    fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',                                   // real CORS, NOT no-cors
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },// JSON, NOT text/plain
      body: JSON.stringify({ token: TOKEN, values: values })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {                          // READ the response
        if (res.ok && res.d && res.d.ok) {
          form.reset();
          msg.textContent = 'Thanks! Your submission was received.';
        } else {
          msg.textContent = (res.d && res.d.error) || 'Something went wrong.';
        }
      })
      .catch(function () { msg.textContent = 'Network error. Please try again.'; })
      .finally(function () { btn.disabled = false; });
  });
})();
</script>
```

### Debugging a broken form

1. Console shows `Blocked form submission … 'allow-forms'` → you are using a
   native submit. Switch to `type="button"` plus a click handler.
2. No network request at all on click → same sandbox block; same fix.
3. Always reports success even when nothing saves → you are on `no-cors`. Switch
   to `mode: 'cors'` and read `r.ok` and the JSON body.
4. `404 This form is not available.` → bad or inactive token, or the form's owner
   lost write access to the table. Re-copy the token from Tables → Forms.
5. `400` → a required field is missing or a value failed type coercion; the error
   message names the field.
6. Bypass the browser to isolate it:
   ```bash
   curl -i -X POST '<endpoint>' -H 'Content-Type: application/json' \
     --data '{"token":"...","values":{"last_name":"Test"}}'
   ```

### Scope

This is the **write** path only. Public reads are deliberately not exposed - a
public read would leak every row - so do not try to build one on this endpoint.

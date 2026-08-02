---
name: supanet-table-forms
description: Build a public write-form (contact form, signup sheet, RSVP, lead capture) that submits into a SupaNet user table from a shared HTML artifact. Use whenever the user wants a form embedded in an artifact / public page that saves rows to one of their Tables, or when a form works in Safari but not Chrome/Firefox. Covers the sandbox `allow-forms` gotcha, correct CORS fetch, and the form-submit endpoint contract.
---

# SupaNet public table write-forms

How to build a form that an anonymous visitor fills out and it saves one row into a
SupaNet user table (the "Tables" feature), embedded inside a shared HTML artifact.

## The #1 gotcha: the artifact sandbox blocks native `<form>` submits

SupaNet artifacts render inside `ArtifactFrame` with `sandbox="allow-scripts"` and
**no `allow-same-origin` and no `allow-forms`** (opaque origin — deliberate, so user
HTML never gets credentials). Consequence:

- A `type="submit"` button inside a real `<form>` is **blocked by Chromium and
  Firefox** before your `submit` handler runs. Console shows:
  `Blocked form submission because the form's frame is sandboxed and the
  'allow-forms' permission is not set.` Safari is lenient and lets it through.
- **This is the usual cause of "works in Safari, not Chrome/Firefox."** It is NOT a
  CORS problem — the `form-submit` endpoint already returns correct CORS.

### Rule: never rely on native form submission

Use a plain `<button type="button">` and bind a **`click`** handler. Do not use a
`submit` event, `type="submit"`, or `form.requestSubmit()`. (Inputs can still live
inside a `<form>` for layout/validation; just don't submit it natively.)

## The #2 gotcha: use real CORS and READ the response

The endpoint supports normal CORS (`Access-Control-Allow-Origin: *`, handles the
`OPTIONS` preflight, returns JSON on success and error). So:

- Use `mode: 'cors'` (the default) and `Content-Type: application/json`.
- **Read the response** (`r.ok`, `r.json()`) to show real success/failure.
- **Never** use `mode: 'no-cors'`, `text/plain`, `keepalive`, or `navigator.sendBeacon`.
  Those make an opaque, unreadable response, so the page reports "sent" even when the
  row was never saved — hiding the real failure above.

## The endpoint contract

`POST https://<project-ref>.supabase.co/functions/v1/form-submit`

```
Body:     { "token": "<form token>", "values": { "<column_key>": <value>, ... } }
Success:  200 { "ok": true, "id": "<row id>" }
Error:    400 { "error": "..." }   (validation)   404 { "error": "This form is not available." }   429 (rate limited)
```

- **`token`** is a **public capability id** (like `webhooks.token`), safe to embed in
  public HTML. It is NOT a secret. The server enforces which table + columns it maps to.
- Only the owner's **allow-listed columns** are written; everything else is dropped.
  `owner_id` is forced server-side; it's insert-only; required/typed fields are validated;
  submissions are rate-limited per hour.
- Field `name` attributes must match the table's **column keys** (snake_case), and only
  the columns the owner enabled on the form are accepted.
- Booleans render as checkboxes — a checkbox is only sent when checked (→ `true`).

## Getting a token

The owner creates the form in the app: **Tables → open a table → "Forms" → New form**,
pick the columns (+ required), then **Copy HTML** (a ready snippet) or **Copy token**.
The generated snippet already follows every rule below — prefer it. Hand-build only when
customizing the design.

## Proven-correct template

Style freely; keep the marked lines exactly.

```html
<form id="signup" novalidate>
  <label>First name<input type="text" name="first_name"></label>
  <label>Last name *<input type="text" name="last_name" required></label>
  <label>Email<input type="email" name="email"></label>
  <!-- type="button" — NOT submit — so the sandbox doesn't block it -->
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

  btn.addEventListener('click', function () {        // click, not submit
    if (!form.reportValidity()) return;              // native required-field UI
    var values = {};
    new FormData(form).forEach(function (v, k) { values[k] = v; });

    btn.disabled = true;
    msg.textContent = 'Sending…';

    fetch(ENDPOINT, {
      method: 'POST',
      mode: 'cors',                                  // real CORS, NOT no-cors
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

## Debugging a broken form

1. Open the artifact and check the browser console. `Blocked form submission … 'allow-forms'`
   → you're using a native submit; switch to `type="button"` + click handler.
2. Network tab: no request at all on click → same sandbox-submit block (fix as above).
3. Request sent but always "success" even when nothing saves → you're on `no-cors`;
   switch to `mode:'cors'` and read `r.ok` / the JSON body.
4. `404 {"error":"This form is not available."}` → bad/inactive token, or the form's
   owner lost write access to the table. Re-copy the token from Tables → Forms.
5. `400 {"error": ...}` → a required field is missing or a value failed type coercion;
   the message names the field.
6. Verify the endpoint directly (bypasses the browser):
   `curl -i -X POST '<endpoint>' -H 'Content-Type: application/json' --data '{"token":"...","values":{"last_name":"Test"}}'`

## Optional app-side change

If you'd rather allow native `<form>` submits in artifacts generally, add `allow-forms`
to the sandbox in `src/components/ArtifactFrame.tsx`
(`sandbox="allow-scripts allow-forms"`). It affects every artifact, so the localized
`type="button"` approach above is preferred for forms and needs no app change.

## Scope note

This is the **write** path only. Public reads are intentionally not exposed (a public
read would leak every row) — that needs a separate curated/published view.

// Pure helpers for the "Public forms" feature (write-forms that submit a row
// into a user table via the `form-submit` edge function). The HTML-snippet
// builder is kept here (not in TablesPage) so it's unit-testable — the snippet
// is what a customer pastes into a shared artifact/page, so its escaping and
// field mapping need to be correct.

export interface FormField {
  key: string
  label: string
  type: string
  required?: boolean
}

/** Escape a string for safe interpolation into HTML text / attribute context. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Map a user-table column type to the right HTML input.
function inputFor(field: FormField): string {
  const name = escapeHtml(field.key)
  const req = field.required ? ' required' : ''
  switch (field.type) {
    case 'longtext':
    case 'json':
      return `<textarea name="${name}" rows="3"${req}></textarea>`
    case 'boolean':
      return `<input type="checkbox" name="${name}">`
    case 'number':
      return `<input type="number" step="any" name="${name}"${req}>`
    case 'integer':
      return `<input type="number" step="1" name="${name}"${req}>`
    case 'date':
      return `<input type="date" name="${name}"${req}>`
    case 'datetime':
      return `<input type="datetime-local" name="${name}"${req}>`
    default:
      return `<input type="text" name="${name}"${req}>`
  }
}

/**
 * Build a complete, self-contained HTML form snippet a customer can paste into
 * an `html` artifact (or any page). It POSTs { token, values } to the public
 * `form-submit` endpoint — the token is a secret-URL capability, safe to embed.
 * Booleans render as checkboxes (only submitted when checked, → true).
 */
export function buildFormSnippet(opts: {
  endpoint: string
  token: string
  title: string
  fields: FormField[]
}): string {
  const { endpoint, token, title, fields } = opts
  const rows = fields
    .map((f) => {
      const label = escapeHtml(f.label || f.key)
      const star = f.required ? ' <span style="color:#e11d48">*</span>' : ''
      if (f.type === 'boolean') {
        return `      <label class="frow fcheck">${inputFor(f)} <span>${label}</span></label>`
      }
      return `      <label class="frow"><span>${label}${star}</span>${inputFor(f)}</label>`
    })
    .join('\n')

  // NOTE: keep this a single, dependency-free string. It runs inside the
  // artifact sandbox (opaque origin, no session) — it only knows the public
  // endpoint + the form token, never any credential.
  return `<!-- Public form → writes to "${escapeHtml(title)}". Paste into an HTML artifact. -->
<div class="formcard">
  <form id="supanet-form">
    <h2>${escapeHtml(title)}</h2>
${rows}
    <button type="submit">Submit</button>
    <p id="supanet-form-msg" class="fmsg"></p>
  </form>
</div>
<style>
  .formcard{max-width:28rem;margin:2rem auto;font-family:system-ui,sans-serif}
  .formcard form{display:flex;flex-direction:column;gap:.85rem;padding:1.5rem;border:1px solid #e2e8f0;border-radius:1rem;background:#fff}
  .formcard h2{margin:0 0 .25rem;font-size:1.15rem;color:#0f172a}
  .frow{display:flex;flex-direction:column;gap:.3rem;font-size:.85rem;color:#334155}
  .frow input,.frow textarea{padding:.55rem .7rem;border:1px solid #cbd5e1;border-radius:.55rem;font:inherit;color:#0f172a}
  .fcheck{flex-direction:row;align-items:center;gap:.5rem}
  .formcard button{margin-top:.4rem;padding:.6rem 1rem;border:0;border-radius:.6rem;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
  .formcard button:disabled{opacity:.6;cursor:default}
  .fmsg{margin:.25rem 0 0;font-size:.85rem;min-height:1.1em}
</style>
<script>
  (function () {
    var ENDPOINT = ${JSON.stringify(endpoint)};
    var TOKEN = ${JSON.stringify(token)};
    var form = document.getElementById('supanet-form');
    var msg = document.getElementById('supanet-form-msg');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('button');
      btn.disabled = true;
      msg.style.color = '#64748b';
      msg.textContent = 'Sending…';
      var values = Object.fromEntries(new FormData(form).entries());
      try {
        var r = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN, values: values }),
        });
        var d = await r.json().catch(function () { return {}; });
        if (r.ok) {
          form.reset();
          msg.style.color = '#16a34a';
          msg.textContent = 'Thanks! Your submission was received.';
        } else {
          msg.style.color = '#e11d48';
          msg.textContent = d.error || 'Something went wrong. Please try again.';
        }
      } catch (_) {
        msg.style.color = '#e11d48';
        msg.textContent = 'Network error. Please try again.';
      } finally {
        btn.disabled = false;
      }
    });
  })();
</script>`
}

const $app = document.getElementById('app');
let me = null;
let state = { names: [], general: [], brief: '' };

// ---- tiny helpers --------------------------------------------------------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    me = null;
    renderLogin();
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  document.querySelector('.toast')?.remove();
  const t = el(`<div class="toast ${isErr ? 'err' : ''}">${esc(msg)}</div>`);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

// ---- login ---------------------------------------------------------------

function renderLogin() {
  $app.innerHTML = '';
  const view = el(`
    <div class="wrap">
      <div class="login panel">
        <h1>Team Name Vote</h1>
        <p>Enter the shared password and your name to join.</p>
        <div class="field"><input id="name" placeholder="Your name" autocomplete="nickname" /></div>
        <div class="field"><input id="pw" type="password" placeholder="Shared password" autocomplete="current-password" /></div>
        <div class="error" id="err"></div>
        <button class="primary" id="go" style="width:100%">Enter</button>
      </div>
    </div>
  `);
  $app.appendChild(view);

  const name = view.querySelector('#name');
  const pw = view.querySelector('#pw');
  const err = view.querySelector('#err');
  const go = view.querySelector('#go');

  async function submit() {
    err.textContent = '';
    go.disabled = true;
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ name: name.value, password: pw.value }),
      });
      me = data.name;
      await load();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      go.disabled = false;
    }
  }
  go.onclick = submit;
  pw.onkeydown = (e) => e.key === 'Enter' && submit();
  name.focus();
}

// ---- main app ------------------------------------------------------------

function nameCard(n) {
  const card = el(`
    <div class="card" data-id="${n.id}">
      <div class="head">
        <div class="vote ${n.mine ? 'mine' : ''}" role="button" title="Toggle your vote">
          <div class="count">${n.votes}</div>
          <div class="lbl">${n.mine ? 'voted' : 'vote'}</div>
        </div>
        <div style="flex:1">
          <div class="name">${esc(n.name)} ${n.source === 'ai' ? '<span class="tag ai">AI</span>' : ''}</div>
          ${n.rationale ? `<div class="rationale">${esc(n.rationale)}</div>` : ''}
        </div>
        <button class="link del" title="Remove">✕</button>
      </div>
      <div class="fb">
        ${n.feedback
          .map((f) => `<div class="item"><b>${esc(f.voter)}:</b> ${esc(f.body)}</div>`)
          .join('')}
        <div class="add">
          <input placeholder="Add feedback on this name…" />
          <button class="ghost">Send</button>
        </div>
      </div>
    </div>
  `);

  card.querySelector('.vote').onclick = () => vote(n.id);
  card.querySelector('.del').onclick = () => removeName(n.id, n.name);
  const fbInput = card.querySelector('.fb .add input');
  const fbBtn = card.querySelector('.fb .add button');
  const send = () => addFeedback(n.id, fbInput.value, fbInput);
  fbBtn.onclick = send;
  fbInput.onkeydown = (e) => e.key === 'Enter' && send();
  return card;
}

function render() {
  $app.innerHTML = '';
  const view = el(`
    <div class="wrap">
      <header class="top">
        <h1>Team Name Vote</h1>
        <div class="who">Hi <b>${esc(me)}</b> · <button class="link" id="logout">sign out</button></div>
      </header>

      <div class="panel">
        <h2>The brief <button class="link" id="editBrief" style="float:right">edit</button></h2>
        <div class="brief-text" id="briefText">${esc(state.brief)}</div>
      </div>

      <div class="panel">
        <h2>Ask Claude for fresh names</h2>
        <div class="gen-controls">
          <span class="muted small">How many:</span>
          <input id="genCount" type="number" min="1" max="15" value="8" />
          <button class="primary" id="gen">✨ Generate</button>
          <span class="muted small">Claude uses the brief + every vote &amp; comment below.</span>
        </div>
      </div>

      <div class="panel">
        <h2>Add your own</h2>
        <div class="row">
          <input id="newName" placeholder="A name you like" style="flex:2;min-width:160px" />
          <input id="newWhy" placeholder="Why? (optional)" style="flex:3;min-width:160px" />
          <button id="addName">Add</button>
        </div>
      </div>

      <div class="row" style="margin:4px 2px 12px">
        <h2 class="muted" style="margin:0;text-transform:uppercase;letter-spacing:.08em;font-size:14px">
          ${state.names.length} name${state.names.length === 1 ? '' : 's'} · sorted by votes
        </h2>
      </div>
      <div class="cards" id="cards"></div>

      <div class="panel" style="margin-top:18px">
        <h2>General feedback (directions, vibes, what to avoid)</h2>
        <div id="general">
          ${state.general
            .map((f) => `<div class="item small"><b>${esc(f.voter)}:</b> ${esc(f.body)}</div>`)
            .join('') || '<div class="muted small">No general notes yet.</div>'}
        </div>
        <div class="fb add" style="display:flex;gap:8px;margin-top:10px">
          <input id="genFb" placeholder="e.g. lean shorter, avoid anything with 'AI'…" style="flex:1" />
          <button class="ghost" id="genFbBtn">Send</button>
        </div>
      </div>
    </div>
  `);
  $app.appendChild(view);

  const cards = view.querySelector('#cards');
  if (state.names.length === 0) {
    cards.appendChild(el('<div class="muted small">No names yet — generate some or add your own.</div>'));
  } else {
    state.names.forEach((n) => cards.appendChild(nameCard(n)));
  }

  view.querySelector('#logout').onclick = logout;
  view.querySelector('#editBrief').onclick = editBrief;

  view.querySelector('#gen').onclick = generate;
  view.querySelector('#addName').onclick = addName;
  view.querySelector('#newName').onkeydown = (e) => e.key === 'Enter' && addName();
  view.querySelector('#newWhy').onkeydown = (e) => e.key === 'Enter' && addName();

  const genFb = view.querySelector('#genFb');
  const sendGen = () => addFeedback(null, genFb.value, genFb);
  view.querySelector('#genFbBtn').onclick = sendGen;
  genFb.onkeydown = (e) => e.key === 'Enter' && sendGen();
}

// ---- actions -------------------------------------------------------------

function applyState(data) {
  state = { names: data.names, general: data.general, brief: data.brief ?? state.brief };
  render();
}

async function load() {
  const data = await api('/api/state');
  me = me || (await api('/api/me')).name;
  applyState(data);
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  me = null;
  renderLogin();
}

async function vote(id) {
  try {
    applyState(await api('/api/vote', { method: 'POST', body: JSON.stringify({ name_id: id }) }));
  } catch (e) {
    toast(e.message, true);
  }
}

async function addName() {
  const name = document.querySelector('#newName').value.trim();
  const rationale = document.querySelector('#newWhy').value.trim();
  if (!name) return;
  try {
    applyState(await api('/api/names', { method: 'POST', body: JSON.stringify({ name, rationale }) }));
    toast('Added');
  } catch (e) {
    toast(e.message, true);
  }
}

async function removeName(id, name) {
  if (!confirm(`Remove "${name}"?`)) return;
  try {
    applyState(await api(`/api/names/${id}`, { method: 'DELETE' }));
  } catch (e) {
    toast(e.message, true);
  }
}

async function addFeedback(nameId, body, input) {
  body = body.trim();
  if (!body) return;
  try {
    const data = await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ name_id: nameId, body }),
    });
    if (input) input.value = '';
    applyState(data);
  } catch (e) {
    toast(e.message, true);
  }
}

async function generate() {
  const btn = document.querySelector('#gen');
  const count = Number(document.querySelector('#genCount').value) || 8;
  btn.disabled = true;
  btn.textContent = '✨ Thinking…';
  try {
    const data = await api('/api/generate', { method: 'POST', body: JSON.stringify({ count }) });
    applyState(data);
    toast(data.added ? `Added ${data.added} new name${data.added === 1 ? '' : 's'}` : 'No new names this round');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generate';
  }
}

async function editBrief() {
  const next = prompt('Edit the brief Claude uses:', state.brief);
  if (next == null) return;
  try {
    const data = await api('/api/brief', { method: 'PUT', body: JSON.stringify({ brief: next }) });
    state.brief = data.brief;
    render();
    toast('Brief updated');
  } catch (e) {
    toast(e.message, true);
  }
}

// ---- boot ----------------------------------------------------------------

(async function boot() {
  try {
    me = (await api('/api/me')).name;
    await load();
  } catch {
    renderLogin();
  }
})();

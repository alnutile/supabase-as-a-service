import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { db, getBrief, setBrief } from './db.js';
import { generateNames } from './generate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;
const COOKIE = 'nv_user';

if (!APP_PASSWORD) {
  console.warn(
    '[namevote] APP_PASSWORD is not set — the app will reject every login. ' +
      'Set it in your Railway variables.'
  );
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[namevote] ANTHROPIC_API_KEY is not set — name generation will fail.');
}
if (!process.env.SESSION_SECRET) {
  console.warn(
    '[namevote] SESSION_SECRET not set — using a random one (logins reset on restart). ' +
      'Set SESSION_SECRET to keep people signed in across deploys.'
  );
}

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// ---- auth helpers --------------------------------------------------------

function currentUser(req) {
  const name = req.signedCookies[COOKIE];
  return typeof name === 'string' && name.length ? name : null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

// constant-time password compare
function passwordOk(input) {
  if (!APP_PASSWORD || typeof input !== 'string') return false;
  const a = Buffer.from(input);
  const b = Buffer.from(APP_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- auth routes ---------------------------------------------------------

app.post('/api/login', (req, res) => {
  const { password, name } = req.body || {};
  const displayName = String(name || '').trim().slice(0, 40);
  if (!displayName) return res.status(400).json({ error: 'Enter your name' });
  if (!passwordOk(password)) return res.status(401).json({ error: 'Wrong password' });

  res.cookie(COOKIE, displayName, {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  });
  res.json({ name: displayName });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ name: req.user });
});

// ---- data helpers --------------------------------------------------------

function listNames(user) {
  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.rationale, n.source, n.created_by, n.created_at,
              COUNT(v.id) AS votes,
              MAX(CASE WHEN v.voter = ? THEN 1 ELSE 0 END) AS mine
       FROM names n
       LEFT JOIN votes v ON v.name_id = n.id
       GROUP BY n.id
       ORDER BY votes DESC, n.created_at DESC`
    )
    .all(user);

  const fb = db
    .prepare(
      `SELECT id, name_id, voter, body, created_at
       FROM feedback ORDER BY created_at ASC`
    )
    .all();

  const byName = new Map();
  const general = [];
  for (const f of fb) {
    if (f.name_id == null) general.push(f);
    else {
      if (!byName.has(f.name_id)) byName.set(f.name_id, []);
      byName.get(f.name_id).push(f);
    }
  }

  return {
    names: rows.map((r) => ({
      id: r.id,
      name: r.name,
      rationale: r.rationale,
      source: r.source,
      created_by: r.created_by,
      votes: r.votes,
      mine: !!r.mine,
      feedback: byName.get(r.id) || [],
    })),
    general,
  };
}

// ---- app routes (all require auth) --------------------------------------

app.get('/api/state', requireAuth, (req, res) => {
  res.json({ ...listNames(req.user), brief: getBrief() });
});

app.put('/api/brief', requireAuth, (req, res) => {
  const value = String(req.body?.brief || '').trim();
  if (!value) return res.status(400).json({ error: 'Brief cannot be empty' });
  setBrief(value);
  res.json({ brief: value });
});

app.post('/api/names', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const rationale = String(req.body?.rationale || '').trim().slice(0, 280);
  if (!name) return res.status(400).json({ error: 'Enter a name' });
  try {
    db.prepare(
      `INSERT INTO names (name, rationale, source, created_by)
       VALUES (?, ?, 'human', ?)`
    ).run(name, rationale, req.user);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That name is already on the board' });
    }
    throw e;
  }
  res.json(listNames(req.user));
});

app.delete('/api/names/:id', requireAuth, (req, res) => {
  db.prepare(`DELETE FROM names WHERE id = ?`).run(Number(req.params.id));
  res.json(listNames(req.user));
});

app.post('/api/vote', requireAuth, (req, res) => {
  const nameId = Number(req.body?.name_id);
  if (!nameId) return res.status(400).json({ error: 'Missing name_id' });
  const existing = db
    .prepare(`SELECT id FROM votes WHERE name_id = ? AND voter = ?`)
    .get(nameId, req.user);
  if (existing) {
    db.prepare(`DELETE FROM votes WHERE id = ?`).run(existing.id);
  } else {
    db.prepare(`INSERT INTO votes (name_id, voter) VALUES (?, ?)`).run(nameId, req.user);
  }
  res.json(listNames(req.user));
});

app.post('/api/feedback', requireAuth, (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 500);
  const nameId = req.body?.name_id ? Number(req.body.name_id) : null;
  if (!body) return res.status(400).json({ error: 'Write some feedback' });
  db.prepare(`INSERT INTO feedback (name_id, voter, body) VALUES (?, ?, ?)`).run(
    nameId,
    req.user,
    body
  );
  res.json(listNames(req.user));
});

app.post('/api/generate', requireAuth, async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 8, 1), 15);
  try {
    const state = listNames(req.user);
    const existing = state.names.map((n) => ({
      name: n.name,
      votes: n.votes,
      source: n.source,
    }));
    const feedback = [
      ...state.general.map((f) => ({ name: null, body: f.body })),
      ...state.names.flatMap((n) => n.feedback.map((f) => ({ name: n.name, body: f.body }))),
    ];

    const suggestions = await generateNames({
      brief: getBrief(),
      existing,
      feedback,
      count,
    });

    let added = 0;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO names (name, rationale, source, created_by)
       VALUES (?, ?, 'ai', 'Claude')`
    );
    for (const s of suggestions) {
      const name = String(s.name || '').trim().slice(0, 80);
      if (!name) continue;
      const info = insert.run(name, String(s.rationale || '').trim().slice(0, 280));
      if (info.changes) added++;
    }

    res.json({ added, ...listNames(req.user) });
  } catch (e) {
    console.error('[namevote] generate failed:', e);
    res.status(500).json({ error: e.message || 'Generation failed' });
  }
});

// ---- static + SPA fallback ----------------------------------------------

app.use(express.static(join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[namevote] listening on http://localhost:${PORT}`);
});

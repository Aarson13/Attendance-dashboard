/* api.js — the sync API the tracker talks to when it is running on this site's own database.
 *
 * The tracker's document is one JSON object (js/sync.js reads and writes it by rev) living as a
 * row in D1: `docs(space, kind, body, rev)`. Every write states the rev it was based on, and a write
 * whose base rev has moved is rejected with 409 so the client re-reads, merges and retries.
 *
 * A space is one attendance document's home (a person, a class, a semester). It is created by the
 * first device to ask for one and is protected by a random key: the server keeps only the SHA-256
 * of that key, and every read and write must present it. No account, no token from a third party —
 * the link (space + key) is the credential, exactly like the repository+token pair it replaces, but
 * nothing has to be pasted anywhere to start: the first visit provisions one.
 *
 * This module is deliberately free of Worker-only globals beyond Web Crypto, so `node --test` can
 * exercise the whole contract (worker/api.js) against an in-memory store while the SQL behind the
 * real store is checked by the wrangler smoke test.
 */

const KINDS = ['doc', 'images'];
const SPACE_RE = /^[a-z0-9][a-z0-9-]{5,31}$/;
const KEY_RE = /^[a-f0-9]{32}$/;
const MAX_BODY_CHARS = 1000000; // the whole JSON document, images included
const MAX_SPACES_PER_HOUR = 10; // per IP — a space is cheap, but not free

/* ---------- small helpers ---------- */
function json(body, status, extra) {
  const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {});
  return new Response(JSON.stringify(body), { status: status || 200, headers });
}

function fail(status, code, message, extra) {
  return json(Object.assign({ error: code, message }, extra || {}), status);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Character-by-character comparison with the work done in constant time. */
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const validSpace = (space) => typeof space === 'string' && SPACE_RE.test(space);
const validKey = (key) => typeof key === 'string' && KEY_RE.test(key);
const validKind = (kind) => KINDS.indexOf(kind) >= 0;

/** Browsers announce a cross-site Origin on state-changing requests; curl and the app itself do not. */
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch (err) {
    return false;
  }
}

/* ---------- the store: the only part that speaks SQL ---------- */
export function createStore(db) {
  return {
    db,
    async init() {
      await db
        .prepare(
          'CREATE TABLE IF NOT EXISTS spaces (space TEXT PRIMARY KEY, key_hash TEXT NOT NULL, created_at TEXT NOT NULL)',
        )
        .run();
      await db
        .prepare(
          'CREATE TABLE IF NOT EXISTS docs (space TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (space, kind))',
        )
        .run();
    },

    /** false when the space already exists — the INSERT is atomic, so two devices racing cannot both win. */
    async createSpace(space, keyHash, now) {
      const res = await db
        .prepare('INSERT INTO spaces (space, key_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(space) DO NOTHING')
        .bind(space, keyHash, now)
        .run();
      return res.meta.changes > 0;
    },

    async keyHashOf(space) {
      const row = await db.prepare('SELECT key_hash FROM spaces WHERE space = ?').bind(space).first();
      return row ? row.key_hash : null;
    },

    async getDoc(space, kind) {
      return db.prepare('SELECT body, rev, updated_at FROM docs WHERE space = ? AND kind = ?').bind(space, kind).first();
    },

    /**
     * Conditional write: the UPDATE carries the rev the edit was based on, so two devices that read
     * the same rev cannot both succeed. A missing row is rev 0 and goes through the INSERT, whose
     * primary key settles any race the UPDATE could not see. Returns { rev, updatedAt } or null (a
     * lost race — the caller reads the winner and reports 409).
     */
    async putDoc(space, kind, body, baseRev, now) {
      const upd = await db
        .prepare('UPDATE docs SET body = ?, rev = rev + 1, updated_at = ? WHERE space = ? AND kind = ? AND rev = ?')
        .bind(body, now, space, kind, baseRev)
        .run();
      if (upd.meta.changes > 0) return { rev: baseRev + 1, updatedAt: now };
      if (baseRev === 0) {
        const ins = await db
          .prepare('INSERT INTO docs (space, kind, body, rev, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(space, kind) DO NOTHING')
          .bind(space, kind, body, now)
          .run();
        if (ins.meta.changes > 0) return { rev: 1, updatedAt: now };
      }
      return null;
    },
  };
}

/* One D1 migration per isolate, remembered so the next request skips it. */
const schemas = new WeakMap();
async function ensureSchema(store) {
  const db = store.db;
  if (!db) return store;
  let done = schemas.get(db);
  if (!done) {
    done = store.init().catch((err) => {
      schemas.delete(db);
      throw err;
    });
    schemas.set(db, done);
  }
  return done.then(() => store);
}

/* ---------- the handlers ---------- */
async function authorize(store, request, space) {
  if (!validSpace(space)) return { error: fail(400, 'bad-space', 'Space must be 6-32 characters of a-z, 0-9 or -.') };
  const key = request.headers.get('x-sync-key') || '';
  if (!validKey(key)) return { error: fail(401, 'no-key', 'This space is locked — the sync key is missing.') };
  const hash = await store.keyHashOf(space);
  if (!hash) return { error: fail(404, 'no-space', 'No such space on this site.') };
  if (!(await safeEqual(await sha256Hex(key), hash))) return { error: fail(403, 'bad-key', 'Wrong sync key for this space.') };
  return { space };
}

async function createSpace(store, request, url) {
  const now = new Date().toISOString();
  let wanted = '';
  try {
    const body = await request.json();
    wanted = String((body && body.space) || '').trim().toLowerCase();
  } catch (err) {
    wanted = '';
  }
  if (wanted && !validSpace(wanted)) return fail(400, 'bad-space', 'Space must be 6-32 characters of a-z, 0-9 or -.');

  // The key is generated here and returned exactly once; only its hash is stored.
  const key = randomHex(16);
  const keyHash = await sha256Hex(key);
  let space = wanted;
  for (let attempt = 0; !space || !(await store.createSpace(space, keyHash, now)); attempt++) {
    if (attempt === 0 && wanted) return fail(409, 'space-taken', 'That space name is already in use — pick another or use the key you were given.');
    if (attempt >= 5) return fail(503, 'busy', 'Could not reserve a space just now — try again in a moment.');
    space = randomHex(6);
  }
  return json({ space, key, createdAt: now }, 201);
}

async function readDoc(store, request, url) {
  const auth = await authorize(store, request, url.searchParams.get('space'));
  if (auth.error) return auth.error;
  const kind = url.searchParams.get('kind') || 'doc';
  if (!validKind(kind)) return fail(400, 'bad-kind', 'Unknown document kind.');
  const row = await store.getDoc(auth.space, kind);
  let data = null;
  if (row) {
    try {
      data = JSON.parse(row.body);
    } catch (err) {
      return fail(500, 'corrupt', 'The stored document is not readable JSON — restore it from a backup export.');
    }
  }
  return json({ space: auth.space, kind, data, rev: row ? row.rev : 0, updatedAt: row ? row.updated_at : null });
}

async function writeDoc(store, request, url) {
  if (!sameOrigin(request, url)) return fail(403, 'foreign-origin', 'Writes are only accepted from this site itself.');
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return fail(400, 'bad-json', 'The request body is not JSON.');
  }
  body = body || {};
  const auth = await authorize(store, request, String(body.space || ''));
  if (auth.error) return auth.error;
  const kind = String(body.kind || 'doc');
  if (!validKind(kind)) return fail(400, 'bad-kind', 'Unknown document kind.');

  let serialized = '';
  try {
    serialized = JSON.stringify(body.data === undefined ? null : body.data);
  } catch (err) {
    return fail(400, 'bad-data', 'That document is not JSON-serialisable.');
  }
  if (!serialized || serialized.length > MAX_BODY_CHARS) {
    return fail(413, 'too-big', `A document may be at most ${(MAX_BODY_CHARS / 1000000).toFixed(0)} MB — export the images instead of storing them all.`);
  }

  const baseRev = Number.isInteger(body.baseRev) && body.baseRev >= 0 ? body.baseRev : 0;
  const now = new Date().toISOString();
  const written = await store.putDoc(auth.space, kind, serialized, baseRev, now);
  if (written) return json({ space: auth.space, kind, rev: written.rev, updatedAt: written.updatedAt });

  // Someone else moved the document first: send back what they wrote so the client can merge.
  const current = await store.getDoc(auth.space, kind);
  let currentData = null;
  try {
    currentData = current ? JSON.parse(current.body) : null;
  } catch (err) {
    currentData = null;
  }
  return fail(409, 'conflict', 'The document was saved by another device while this one was editing.', {
    rev: current ? current.rev : 0,
    data: currentData,
  });
}

export async function handleApi(request, env, deps) {
  const url = new URL(request.url);
  const injected = deps && deps.store;
  const store = injected || createStore(env.DB);
  if (!injected) await ensureSchema(store);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json({ ok: true, service: 'attendance-sync' });
  }
  if (request.method === 'POST' && url.pathname === '/api/spaces') {
    if (!sameOrigin(request, url)) return fail(403, 'foreign-origin', 'Spaces are only created from this site itself.');
    if (env.__noRateLimit !== true && !underRateLimit(request)) return fail(429, 'rate-limited', 'Too many spaces created just now — wait a minute.');
    return createSpace(store, request, url);
  }
  if (url.pathname === '/api/doc') {
    if (request.method === 'GET') return readDoc(store, request, url);
    if (request.method === 'PUT') return writeDoc(store, request, url);
  }
  return fail(404, 'no-such-endpoint', 'Nothing lives here.');
}

/* ---------- per-isolate rate limiting for space creation ---------- */
const recent = new Map(); // ip -> [timestamps]
function underRateLimit(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  const now = Date.now();
  const window = 60 * 60 * 1000;
  const list = (recent.get(ip) || []).filter((t) => now - t < window);
  if (list.length >= MAX_SPACES_PER_HOUR) {
    recent.set(ip, list);
    return false;
  }
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 500) {
    // Isolates are recycled often enough that this never needs to be clever.
    for (const [k, v] of recent) if (!v.length || now - v[v.length - 1] > window) recent.delete(k);
  }
  return true;
}

export const internals = { sha256Hex, randomHex, safeEqual, validSpace, validKey, validKind, createStore };

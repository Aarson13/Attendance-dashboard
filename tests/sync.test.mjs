/* Tests for the sync client: the tracker talking to this site's own database (worker/api.js).
 * There is nothing to configure — the first save claims a space and keeps the key — so what is
 * pinned here is the transport: claiming a space, carrying the key, the rev that orders the writes,
 * the two document kinds, a lost race that merges and retries, and what a wrong key feels like.
 * Run: npm test  (node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../js/sync.js');
await import('../js/store.js');
const { Sync, Store } = globalThis.AD;

/* ---------- a scripted database, speaking the API worker/api.js defines ---------- */
function database({ failSpaces } = {}) {
  const spaces = new Map(); // space -> key
  const docs = new Map(); // `${space}/${kind}` -> { data, rev, updatedAt }
  const calls = [];
  let created = 0;

  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const target = new URL(url, 'https://attendance.test');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path: target.pathname, body, headers: opts.headers });

    const key = opts.headers && opts.headers['X-Sync-Key'];
    const json = (status, payload) => ({
      status,
      statusText: String(status),
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      json: async () => payload,
    });

    if (method === 'POST' && target.pathname === '/api/spaces') {
      if (failSpaces) return json(503, { error: 'busy', message: 'Could not reserve a space just now.' });
      created += 1;
      const space = `space${created}`;
      const spaceKey = `key${created}`;
      spaces.set(space, spaceKey);
      return json(201, { space, key: spaceKey, createdAt: new Date().toISOString() });
    }

    if (target.pathname === '/api/doc') {
      const space = method === 'GET' ? target.searchParams.get('space') : body.space;
      const kind = method === 'GET' ? target.searchParams.get('kind') : body.kind;
      if (spaces.get(space) !== key) return json(403, { error: 'bad-key', message: 'Wrong sync key for this space.' });
      const row = docs.get(`${space}/${kind}`) || null;

      if (method === 'GET') {
        return json(200, { space, kind, data: row ? row.data : null, rev: row ? row.rev : 0, updatedAt: row ? row.updatedAt : null });
      }
      const baseRev = body.baseRev;
      // A space with no row for this kind yet is at rev 0, exactly like the real D1 handler.
      if ((row ? row.rev : 0) !== baseRev) {
        return json(409, { error: 'conflict', message: 'Saved by another device.', rev: row ? row.rev : 0, data: row ? row.data : null });
      }
      const next = { data: body.data, rev: baseRev + 1, updatedAt: new Date().toISOString() };
      docs.set(`${space}/${kind}`, next);
      return json(200, { space, kind, rev: next.rev, updatedAt: next.updatedAt });
    }
    return json(404, { error: 'no-such-endpoint' });
  };

  return { spaces, docs, calls, puts: () => calls.filter((c) => c.method === 'PUT'), gets: () => calls.filter((c) => c.method === 'GET') };
}

/** A first visitor: no space, no key, nothing configured — and nothing needs to be. */
function fresh() {
  Sync.disconnect();
}

const docWith = (overrides) => Object.assign(Store.defaults(), overrides || {});

test('the database needs nothing from the user: it is configured from the first moment', () => {
  database();
  fresh();
  assert.ok(Sync.isConfigured());
  assert.equal(Sync.describe(), 'cloud database');
});

test('the first save claims a space and every write carries the key', async () => {
  const db = database();
  fresh();
  const data = docWith({ subjects: [{ id: 'sub_1', name: 'Maths' }] });

  const { data: saved } = await Sync.sync(data, { message: 'first save' });
  assert.equal(db.spaces.size, 1, 'one space was claimed');
  assert.deepEqual(saved.subjects.map((s) => s.name), ['Maths']);

  const write = db.puts()[0];
  assert.equal(write.path, '/api/doc');
  assert.equal(write.headers['X-Sync-Key'], 'key1', 'every write carries the key');
  assert.equal(write.body.baseRev, 0, 'a brand-new document is based on rev 0');
});

test('the rev orders the writes: each one quotes the rev the previous one returned', async () => {
  const db = database();
  fresh();
  await Sync.sync(docWith({ subjects: [] }), {});
  await Sync.sync(docWith({ subjects: [], records: [{ id: 'r1', subjectId: 'sub_1' }] }), {});

  const writes = db.puts();
  assert.deepEqual(writes.map((w) => w.body.baseRev), [0, 1]);
  assert.equal(db.docs.get('space1/doc').rev, 2);
});

test('a lost race re-reads, merges both devices and retries once', async () => {
  const db = database();
  fresh();
  await Sync.sync(docWith({ subjects: [{ id: 'sub_a', name: 'From device A' }] }), {});

  // Another device saves while this one is not looking: the server's rev moves on.
  db.docs.set('space1/doc', {
    data: docWith({ subjects: [{ id: 'sub_b', name: 'From device B' }] }),
    rev: 7,
    updatedAt: new Date().toISOString(),
  });

  const { data, pulled } = await Sync.sync(docWith({ subjects: [{ id: 'sub_a', name: 'From device A' }] }), {});
  assert.equal(pulled, true, 'the client was told it had to merge');
  assert.deepEqual(
    data.subjects.map((s) => s.name).sort(),
    ['From device A', 'From device B'],
    'nothing from either device was dropped',
  );
  assert.equal(db.docs.get('space1/doc').rev, 8, 'the retry quoted the rev it had just read');
});

test('screenshots ride in their own kind and are only written when they change', async () => {
  const db = database();
  fresh();
  await Sync.sync(docWith(), {});
  await Sync.syncImages([{ id: 'img1', dataUrl: 'data:image/png;base64,AAAA' }], {});
  const kinds = db.puts().map((w) => w.body.kind);
  assert.deepEqual(kinds, ['doc', 'images']);

  await Sync.syncImages([{ id: 'img1', dataUrl: 'data:image/png;base64,AAAA' }], {});
  assert.equal(db.puts().length, 2, 'an unchanged set costs no write at all');
});

test('pull reads both kinds, and a space with nothing in it is "not created yet", not an error', async () => {
  const db = database();
  fresh();
  await Sync.sync(docWith({ subjects: [{ id: 'sub_1', name: 'DBMS' }] }), {});
  const pulled = await Sync.pull();
  assert.equal(pulled.doc.data.subjects[0].name, 'DBMS');
  assert.equal(pulled.images, null, 'no screenshots have been uploaded');

  const empty = database();
  fresh();
  const none = await Sync.pull();
  assert.equal(none.doc, null);
  assert.equal(empty.docs.size, 0);
});

test('a key the server refuses is an auth error, and the chip turns red instead of pretending', async () => {
  database();
  fresh();
  // This device presents the wrong key on every request: the space is claimed fine, but every
  // document call comes back 403.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) =>
    realFetch(url, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { 'X-Sync-Key': 'wrong-key' }) }));
  await assert.rejects(
    () => Sync.sync(docWith(), {}),
    (err) => err.kind === 'auth',
  );
  assert.equal(Sync.state().status, 'error', 'the chip turns red instead of pretending');
});

test('simultaneous interactions share the queue while sequential ones each commit', async () => {
  const db = database();
  fresh();
  await Sync.pull(); // claim the space first so the race below is only about writes
  const one = docWith({ records: [{ id: 'r1', subjectId: 'sub_1' }] });
  const two = docWith({ records: [{ id: 'r1', subjectId: 'sub_1' }, { id: 'r2', subjectId: 'sub_1' }] });
  const p1 = Sync.queueSync(one, { message: 'first' });
  const p2 = Sync.queueSync(two, { message: 'second' });
  await Promise.all([p1, p2]);
  assert.equal(db.docs.get('space1/doc').data.records.length, 2, 'the newest state won, nothing was lost');

  await Sync.queueSync(docWith({ records: [] }), { message: 'third' });
  assert.ok(db.docs.get('space1/doc').rev >= 2, 'a later interaction still commits');
});

test('a dead network is a network error that leaves the change flagged as unsaved', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  fresh();
  await assert.rejects(() => Sync.sync(docWith()), (err) => err.kind === 'network');
  assert.equal(Sync.state().status, 'error');
  assert.equal(Sync.state().pending, true, 'the UI has to be able to say the change is not saved');
});

test('merge unions subjects and marks by id, and refuses a prototype-shaped remote document', () => {
  const remote = docWith({ subjects: [{ id: 's1', name: 'Remote' }], records: [{ id: 'r1', subjectId: 's1' }] });
  const local = docWith({ subjects: [{ id: 's2', name: 'Local' }], records: [{ id: 'r2', subjectId: 's2' }] });
  const merged = Sync.merge(remote, local);
  assert.deepEqual(merged.subjects.map((s) => s.id).sort(), ['s1', 's2']);
  assert.deepEqual(merged.records.map((r) => r.id).sort(), ['r1', 'r2']);

  const hostile = JSON.parse('{"subjects":[],"records":[],"__proto__":{"polluted":true}}');
  const clean = Sync.merge(hostile, local);
  assert.equal({}.polluted, undefined, 'the prototype was not touched');
  assert.equal(clean.polluted, undefined);
});

test('a successful save is reported as saved, with the time it happened', async () => {
  database();
  fresh();
  const seen = [];
  const off = Sync.onChange((s) => seen.push(s.status));
  await Sync.pull();
  await Sync.queueSync(docWith(), { message: 'x' });
  off();
  assert.ok(seen.includes('saved'));
  assert.equal(Sync.state().status, 'saved');
  assert.ok(Sync.state().lastSyncAt);
});

test('file:// has no database to talk to, so it stays unconfigured', async () => {
  database();
  fresh();
  globalThis.location = { protocol: 'file:' };
  try {
    assert.equal(Sync.isConfigured(), false);
    await assert.rejects(() => Sync.sync(docWith()), (err) => err.kind === 'not-configured');
  } finally {
    delete globalThis.location;
  }
});

/* Tests for the built-in sync target: the tracker talking to this site's own database (worker/api.js)
 * instead of GitHub. The contract is deliberately the same one github.js already speaks — read by
 * sha, write with the sha the edit was based on, re-read/merge/retry on a lost race — so what is
 * pinned here is the transport: claiming a space, carrying the key, the rev that replaces the sha,
 * the two document kinds, and what a wrong key feels like.
 * Run: npm test  (node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../js/github.js');
await import('../js/store.js');
const { Github, Store } = globalThis.AD;

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

/** Cloud mode, no credentials yet — exactly what a first visitor starts with. */
function fresh() {
  Github.disconnect();
  Github.setCloud('', '');
  Github.configure({ mode: 'cloud' });
}

const docWith = (overrides) => Object.assign(Store.defaults(), overrides || {});

test('cloud mode needs nothing from the user: it is configured from the first moment', () => {
  database();
  fresh();
  assert.equal(Github.mode(), 'cloud');
  assert.ok(Github.isConfigured(), 'no owner, no token, no paste — the site provisions the space itself');
});

test('the first sync claims a space and keeps the key that came back', async () => {
  const db = database();
  fresh();
  const data = docWith({ subjects: [{ id: 'sub_1', name: 'Maths' }] });

  const { data: saved } = await Github.sync(data, { message: 'first save' });
  assert.equal(db.spaces.size, 1, 'one space was claimed');
  assert.deepEqual(Github.cloudInfo().space, 'space1');
  assert.equal(Github.cloudInfo().key, 'key1');
  assert.deepEqual(saved.subjects.map((s) => s.name), ['Maths']);

  const write = db.puts()[0];
  assert.equal(write.path, '/api/doc');
  assert.equal(write.headers['X-Sync-Key'], 'key1', 'every write carries the key');
  assert.equal(write.body.baseRev, 0, 'a brand-new document is based on rev 0');
  assert.match(Github.describe(), /space1/, 'the status chip names the space');
});

test('the rev replaces the sha: each write quotes the rev the previous one returned', async () => {
  const db = database();
  fresh();
  await Github.sync(docWith({ subjects: [] }), {});
  await Github.sync(docWith({ subjects: [], records: [{ id: 'r1', subjectId: 'sub_1' }] }), {});

  const writes = db.puts();
  assert.deepEqual(writes.map((w) => w.body.baseRev), [0, 1]);
  assert.equal(db.docs.get('space1/doc').rev, 2);
});

test('a lost race re-reads, merges both devices and retries once — same as on GitHub', async () => {
  const db = database();
  fresh();
  await Github.sync(docWith({ subjects: [{ id: 'sub_a', name: 'From device A' }] }), {});

  // Device B saves while this one is not looking: the server's rev moves on.
  db.docs.set('space1/doc', {
    data: docWith({ subjects: [{ id: 'sub_b', name: 'From device B' }] }),
    rev: 7,
    updatedAt: new Date().toISOString(),
  });

  const { data, pulled } = await Github.sync(docWith({ subjects: [{ id: 'sub_a', name: 'From device A' }] }), {});
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
  await Github.sync(docWith(), {});
  await Github.syncImages([{ id: 'img1', dataUrl: 'data:image/png;base64,AAAA' }], {});
  const kinds = db.puts().map((w) => w.body.kind);
  assert.deepEqual(kinds, ['doc', 'images']);

  await Github.syncImages([{ id: 'img1', dataUrl: 'data:image/png;base64,AAAA' }], {});
  assert.equal(db.puts().length, 2, 'an unchanged set costs no write at all');
});

test('pull reads both kinds, and a space with nothing in it is "not created yet", not an error', async () => {
  const db = database();
  fresh();
  await Github.sync(docWith({ subjects: [{ id: 'sub_1', name: 'DBMS' }] }), {});
  const pulled = await Github.pull();
  assert.equal(pulled.doc.data.subjects[0].name, 'DBMS');
  assert.equal(pulled.images, null, 'no screenshots have been uploaded');

  const empty = database();
  fresh();
  const none = await Github.pull();
  assert.equal(none.doc, null);
  assert.equal(empty.docs.size, 0);
});

test('a key the server refuses is an auth error that says how to rejoin, not a silent local save', async () => {
  database();
  fresh();
  Github.setCloud('space1', 'key-the-server-does-not-know');
  await assert.rejects(
    () => Github.sync(docWith(), {}),
    (err) => err.kind === 'auth' && /space id and key/.test(err.message),
  );
  assert.equal(Github.state().status, 'error', 'the chip turns red instead of pretending');
});

test('a database that cannot answer is a network error, and the sync chain keeps running', async () => {
  database({ failSpaces: true });
  fresh();
  await assert.rejects(() => Github.sync(docWith(), {}), (err) => err.kind === 'bad-response');

  // The failure must not wedge the queue: a later, working save still goes through.
  database();
  const { pulled } = await Github.sync(docWith({ subjects: [] }), {});
  assert.ok(pulled === false || pulled === true);
  assert.equal(Github.state().status, 'saved');
});

test('disconnecting leaves the space and its key in place, so switching back resumes the semester', async () => {
  const db = database();
  fresh();
  await Github.sync(docWith({ subjects: [{ id: 'sub_1', name: 'Physics' }] }), {});
  const { space, key } = Github.cloudInfo();

  Github.disconnect();
  assert.equal(Github.mode(), 'github');
  assert.equal(Github.isConfigured(), false, 'nothing is saved while disconnected');
  assert.deepEqual(Github.cloudInfo(), { space, key }, 'the credential is kept, only the syncing stopped');

  Github.configure({ mode: 'cloud' });
  const pulled = await Github.pull();
  assert.equal(pulled.doc.data.subjects[0].name, 'Physics', 'the same document is picked up again');
  assert.equal(db.docs.get(`${space}/doc`).rev, 1);
});

test('joining a space is the space id plus the key, and nothing weaker', async () => {
  const db = database();
  db.spaces.set('shared', 'sharedkey');
  db.docs.set('shared/doc', { data: docWith({ subjects: [{ id: 'sub_1', name: 'Chemistry' }] }), rev: 3, updatedAt: new Date().toISOString() });

  fresh();
  Github.setCloud('shared', 'wrong-key');
  await assert.rejects(() => Github.pull(), (err) => err.kind === 'auth');

  Github.setCloud('shared', 'sharedkey');
  const pulled = await Github.pull();
  assert.equal(pulled.doc.data.subjects[0].name, 'Chemistry');
  assert.equal(db.gets().filter((c) => c.path === '/api/doc').length >= 3, true);
});

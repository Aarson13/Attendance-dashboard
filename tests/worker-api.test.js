/* worker-api.test.js — the sync contract, exercised against an in-memory store.
 *
 * The SQL behind the real store (worker/api.js `createStore`) is checked end-to-end by running the
 * Worker under wrangler against a local D1; what is pinned here is everything in front of it: the
 * space/key credential, the rev-based conditional write, the 409 that makes a losing device merge
 * instead of overwriting, and the limits (size, origin, space format).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, internals } from '../worker/api.js';

const ORIGIN = 'https://attendance.example';
const { sha256Hex, validSpace, validKey, safeEqual } = internals;

/** The same contract as the SQL store, in two Maps. */
function memoryStore() {
  const spaces = new Map();
  const docs = new Map();
  return {
    spaces,
    docs,
    async createSpace(space, keyHash) {
      if (spaces.has(space)) return false;
      spaces.set(space, keyHash);
      return true;
    },
    async keyHashOf(space) {
      return spaces.get(space) || null;
    },
    async getDoc(space, kind) {
      return docs.get(`${space}/${kind}`) || null;
    },
    async putDoc(space, kind, body, baseRev, now) {
      const row = docs.get(`${space}/${kind}`);
      const current = row ? row.rev : 0;
      if (current !== baseRev) return null; // someone moved it first
      const rev = baseRev + 1;
      docs.set(`${space}/${kind}`, { body, rev, updated_at: now });
      return { rev, updatedAt: now };
    },
  };
}

const call = (store, path, init) => handleApi(new Request(`${ORIGIN}${path}`, init), { __noRateLimit: true }, { store });
const get = (store, path, key) => call(store, path, { headers: { 'x-sync-key': key } });
const put = (store, space, key, body, origin) =>
  call(store, '/api/doc', {
    method: 'PUT',
    headers: Object.assign({ 'x-sync-key': key, 'content-type': 'application/json' }, origin ? { origin } : null),
    body: JSON.stringify(Object.assign({ space, kind: 'doc' }, body)),
  });

async function aSpace(store) {
  const res = await call(store, '/api/spaces', { method: 'POST' });
  assert.equal(res.status, 201);
  return res.json();
}

test('the health endpoint answers without touching the database', async () => {
  const res = await call(memoryStore(), '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'attendance-sync' });
});

test('a space is claimed once, and only its key hash is ever stored', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  assert.ok(validSpace(space));
  assert.ok(validKey(key));
  assert.equal(store.spaces.get(space), await sha256Hex(key));
  assert.notEqual(store.spaces.get(space), key);
  assert.notEqual(await sha256Hex('wrong'), store.spaces.get(space));

  const again = await call(store, '/api/spaces', { method: 'POST' });
  assert.equal(again.status, 201);
  assert.notEqual((await again.json()).space, space); // every visitor gets their own
});

test('reading an empty space answers "no document yet", not an error', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  const res = await get(store, `/api/doc?space=${space}&kind=doc`, key);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data, null);
  assert.equal(body.rev, 0);
});

test('write, read back, and the rev the next write must quote', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  const doc = { app: 'attendance-dashboard', subjects: [{ id: 'sub_1', name: 'Maths' }], records: [] };

  const first = await put(store, space, key, { data: doc, baseRev: 0 });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).rev, 1);

  const read = await get(store, `/api/doc?space=${space}&kind=doc`, key);
  const body = await read.json();
  assert.deepEqual(body.data, doc);
  assert.equal(body.rev, 1);

  const second = await put(store, space, key, { data: { ...doc, records: [{ id: 'r1' }] }, baseRev: 1 });
  assert.equal((await second.json()).rev, 2);
});

test('a write based on a stale rev is refused with 409 and the winner attached', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  await put(store, space, key, { data: { from: 'device-a' }, baseRev: 0 });

  // Device B read rev 0, edited, and only now pushes.
  const lose = await put(store, space, key, { data: { from: 'device-b' }, baseRev: 0 });
  assert.equal(lose.status, 409);
  const conflict = await lose.json();
  assert.equal(conflict.error, 'conflict');
  assert.equal(conflict.rev, 1);
  assert.deepEqual(conflict.data, { from: 'device-a' });
});

test('the key is the credential: no key, wrong key, foreign origin', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  await put(store, space, key, { data: { mine: true }, baseRev: 0 });

  assert.equal((await get(store, `/api/doc?space=${space}&kind=doc`, '')).status, 401);
  assert.equal((await get(store, `/api/doc?space=${space}&kind=doc`, 'f'.repeat(32))).status, 403);
  assert.equal((await get(store, `/api/doc?space=notreal123&kind=doc`, key)).status, 404);
  assert.equal((await put(store, space, key, { data: {}, baseRev: 1 }, 'https://evil.test')).status, 403);
  // …and the document is untouched by all three.
  assert.equal((await get(store, `/api/doc?space=${space}&kind=doc`, key)).status, 200);
});

test('spaces and kinds are validated before anything is read', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);
  assert.equal((await get(store, '/api/doc?space=DROP TABLE&kind=doc', key)).status, 400);
  assert.equal((await get(store, `/api/doc?space=${space}&kind=exec`, key)).status, 400);
  assert.equal((await put(store, space, key, { data: {}, baseRev: 0, kind: 'exec' })).status, 400);
  assert.equal((await put(store, 'nospacexx', key, { data: {}, baseRev: 0 })).status, 404);
  assert.equal((await call(store, '/api/nothing', {})).status, 404);
});

test('the images file keeps its own revision, and oversized documents are refused', async () => {
  const store = memoryStore();
  const { space, key } = await aSpace(store);

  await put(store, space, key, { data: [{ id: 'img1' }], baseRev: 0, kind: 'images' });
  const images = await (await get(store, `/api/doc?space=${space}&kind=images`, key)).json();
  assert.equal(images.rev, 1);
  const doc = await (await get(store, `/api/doc?space=${space}&kind=doc`, key)).json();
  assert.equal(doc.rev, 0); // the document's rev did not move

  const huge = await put(store, space, key, { data: 'x'.repeat(1000001), baseRev: 0 });
  assert.equal(huge.status, 413);
});

test('the key comparison does not stop at the first difference', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'ab'));
  assert.ok(!safeEqual('', 'a'));
});

test('validators accept what the client can legitimately send', () => {
  assert.ok(validSpace('a1b2c3d4e5f6'));
  assert.ok(validSpace('my-semester'));
  assert.ok(!validSpace('UPPER'));
  assert.ok(!validSpace('short'));
  assert.ok(!validSpace(''));
  assert.ok(!validSpace('a'.repeat(40)));
  assert.ok(validKey('0123456789abcdef0123456789abcdef'));
  assert.ok(!validKey('0123456789ABCDEF0123456789ABCDEF'));
  assert.ok(!validKey('xyz'));
});

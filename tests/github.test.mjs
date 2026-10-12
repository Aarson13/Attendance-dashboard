/* Tests for the sync client: the only place attendance data goes somewhere other than this device.
 * A scripted API stands in for github.com, so every branch that matters can be exercised without a
 * token: reading a file with its sha, writing it back, losing the race (409), a bad token, a rate
 * limit, and two interactions landing while one write is in flight.
 * Run: npm test  (node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../js/github.js');
await import('../js/store.js');
const { Github, Store } = globalThis.AD;

/* ---------- a scripted GitHub ---------- */
function api(handlers) {
  const calls = [];
  const files = new Map();
  const tracker = { concurrent: 0, maxConcurrent: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1] || '');
    calls.push({ method, path, body, url, headers: opts.headers });
    tracker.concurrent++;
    tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.concurrent);
    try {
      const handler = handlers[`${method} ${path}`] || handlers[method] || handlers['*'];
      if (!handler) return reply(404, { message: 'Not Found' });
      return await handler({ method, path, body, files, calls });
    } finally {
      tracker.concurrent--;
    }
  };
  return {
    calls,
    files,
    tracker,
    puts: () => calls.filter((c) => c.method === 'PUT'),
    gets: () => calls.filter((c) => c.method === 'GET'),
  };
}
const reply = (status, body, headers = {}) => ({
  status,
  statusText: String(status),
  ok: status >= 200 && status < 300,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : String(headers[String(k).toLowerCase()])) },
  json: async () => body,
});
const fileReply = (text, sha) => reply(200, { type: 'file', sha, size: text.length, content: Github.encode(text) });
const okWrite = (sha) => reply(200, { content: { sha } });

/** Every test starts from a clean connection: no token, no remembered sha. */
function connect(extra) {
  Github.disconnect();
  Github.configure(Object.assign({ owner: 'Aarson13', repo: 'Attendance-dashboard', branch: 'main', path: 'attendance.json', token: 'github_pat_test' }, extra));
}
const docWith = (overrides) => Object.assign(Store.defaults(), overrides || {});

/* ---------- configuration ---------- */
test('configuration: a pasted URL is cleaned, defaults fill in, and a token is required before anything syncs', () => {
  connect();
  Github.configure({ owner: 'https://github.com/Aarson13/', repo: 'https://github.com/Aarson13/Attendance-dashboard.git', path: '/attendance.json' });
  assert.deepEqual(
    { owner: Github.config().owner, repo: Github.config().repo, path: Github.config().path, branch: Github.config().branch },
    { owner: 'Aarson13', repo: 'Attendance-dashboard', path: 'attendance.json', branch: 'main' },
  );
  assert.equal(Github.imagesPath(), 'attendance-images.json', 'the bulky field gets its own file beside the data');
  assert.ok(Github.isConfigured());
  Github.setToken('', false);
  assert.equal(Github.isConfigured(), false, 'no token means nowhere to write');
  assert.equal(Github.describe(), 'Aarson13/Attendance-dashboard · attendance.json (main)');
});

test('the token is never part of the document and never shown back', () => {
  connect({ rememberToken: true });
  const shown = Github.config();
  assert.equal(shown.token, '***');
  assert.equal(JSON.stringify(docWith()).includes('github_pat_test'), false);
});

test('base64 round-trips the real strings in a timetable, not just ASCII', () => {
  const text = JSON.stringify({ faculty: 'Dr. Anitha Rao · MTE — "duty leave"', note: 'café ☕ 09:00–09:55' });
  assert.equal(Github.decode(Github.encode(text)), text);
});

/* ---------- reading ---------- */
test('pull: reads the file with its sha, and treats a missing file as "not created yet"', async () => {
  connect();
  const remote = docWith({ records: [{ id: 'r1', date: '2026-10-01', subjectId: 's1', kind: 'extra', status: 'present' }] });
  const scripted = api({
    'GET attendance.json': () => fileReply(JSON.stringify(remote), 'sha-doc'),
    'GET attendance-images.json': () => reply(404, { message: 'Not Found' }),
  });
  const pulled = await Github.pull();
  assert.equal(pulled.doc.sha, 'sha-doc');
  assert.equal(pulled.doc.data.records.length, 1);
  assert.equal(pulled.images, null);
  assert.match(scripted.calls[0].url, /\/repos\/Aarson13\/Attendance-dashboard\/contents\/attendance\.json\?ref=main$/);

  api({ '*': () => reply(404, { message: 'Not Found' }) });
  assert.equal((await Github.pull()).doc, null, 'a 404 is a first run, not an error');
});

test('a file larger than the inline limit is read through the blob endpoint', async () => {
  connect();
  const remote = docWith({ subjects: [{ id: 's1', name: 'Big', code: 'B1', credits: 3 }] });
  api({
    'GET attendance.json': () => reply(200, { type: 'file', sha: 'sha-big', size: 2 * 1024 * 1024, content: '' }),
    'GET attendance-images.json': () => reply(404, {}),
  });
  // The blob endpoint lives outside the contents path, so the scripted api falls back to 404 for it;
  // point the fallback at a blob reply to prove the round trip.
  globalThis.fetch = (async (url) => {
    if (url.includes('/git/blobs/')) return reply(200, { content: Github.encode(JSON.stringify(remote)) });
    if (url.includes('attendance-images.json')) return reply(404, {});
    return reply(200, { type: 'file', sha: 'sha-big', size: 2 * 1024 * 1024, content: '' });
  });
  const pulled = await Github.pull();
  assert.equal(pulled.doc.data.subjects[0].name, 'Big');
});

test('broken JSON on GitHub is reported as such instead of being half-applied', async () => {
  connect();
  api({ 'GET attendance-images.json': () => reply(404, {}), 'GET attendance.json': () => fileReply('{ this is not json', 'sha-x') });
  await assert.rejects(() => Github.pull(), (err) => err.kind === 'bad-response' && /not valid JSON/.test(err.message));
});

/* ---------- writing ---------- */
test('an interaction pushes once, with the sha it read and the commit message it was given', async () => {
  connect();
  let stored = JSON.stringify(docWith());
  let put = null;
  api({
    'GET attendance.json': () => fileReply(stored, 'sha-1'),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance.json': ({ body }) => {
      put = body;
      stored = Github.decode(body.content);
      return okWrite('sha-2');
    },
  });
  await Github.pull(); // baseSha = sha-1
  const data = docWith({ records: [{ id: 'r1', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'present' }] });
  const res = await Github.sync(data, { message: 'Mark CS2001 present' });
  assert.equal(res.sha, 'sha-2');
  assert.equal(res.pulled, false, 'nothing changed underneath us, so nothing was merged');
  assert.equal(put.sha, 'sha-1', 'the PUT carries the sha it read: that is what makes a lost race detectible');
  assert.equal(put.branch, 'main');
  assert.equal(put.message, 'Mark CS2001 present');
  assert.equal(JSON.parse(Github.decode(put.content)).records.length, 1);
});

test('a lost race (409) re-reads, merges both devices and writes once more', async () => {
  connect();
  const mine = docWith({ records: [{ id: 'mine', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'present' }] });
  const theirs = docWith({ records: [{ id: 'theirs', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'absent' }] });
  let storedSha = 'sha-old';
  let storedText = JSON.stringify(docWith());
  let putCount = 0;
  const puts = [];
  api({
    'GET attendance.json': () => fileReply(storedText, storedSha),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance.json': ({ body }) => {
      putCount++;
      puts.push(body);
      if (putCount === 1) {
        // The other device wrote in the meantime: the file (and its sha) moved under us.
        storedText = JSON.stringify(theirs);
        storedSha = 'sha-theirs';
        return reply(409, { message: 'sha does not match' });
      }
      storedText = Github.decode(body.content);
      storedSha = 'sha-new';
      return okWrite('sha-new');
    },
  });
  await Github.pull();
  const res = await Github.sync(mine, { message: 'Mark present' });
  assert.equal(putCount, 2, 'one conflict, one retry — not a loop');
  assert.equal(puts[1].sha, 'sha-theirs', 'the retry uses the sha the second read returned');
  assert.equal(res.pulled, true);
  const pushed = JSON.parse(Github.decode(puts[1].content));
  assert.deepEqual(
    pushed.records.map((r) => r.id).sort(),
    ['mine', 'theirs'],
    'the other device\'s mark survives the merge',
  );
});

test('two interactions during one write are queued, not raced: one request at a time, newest state wins', async () => {
  connect();
  const bodies = [];
  let stored = JSON.stringify(docWith());
  const scripted = api({
    'GET attendance.json': () => fileReply(stored, 'sha-q'),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance.json': ({ body }) => {
      bodies.push(JSON.parse(Github.decode(body.content)));
      stored = Github.decode(body.content);
      return okWrite('sha-q');
    },
  });
  await Github.pull();
  const first = docWith({ records: [{ id: 'a', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'present' }] });
  const second = docWith({ records: [{ id: 'a', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'present' }, { id: 'b', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'absent' }] });
  // Both land before the first write has begun: one commit, carrying both marks.
  const p1 = Github.queueSync(first, { message: 'first' });
  const p2 = Github.queueSync(second, { message: 'second' });
  await Promise.all([p1, p2]);
  assert.equal(bodies.length, 1, 'a queued interaction that has not started is folded into one commit');
  assert.equal(bodies[0].records.length, 2, 'and that commit carries the newest state, so nothing was lost');
  assert.equal(scripted.tracker.maxConcurrent, 1, 'the API never saw two writes at once');
});

test('interactions that follow each other are each committed, in order', async () => {
  connect();
  const messages = [];
  let stored = JSON.stringify(docWith());
  const one = [{ id: 'a', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'present' }];
  const two = one.concat([{ id: 'b', date: '2026-10-02', subjectId: 's1', kind: 'extra', status: 'absent' }]);
  api({
    'GET attendance.json': () => fileReply(stored, 'sha-seq'),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance.json': ({ body }) => {
      messages.push(body.message);
      stored = Github.decode(body.content);
      return okWrite('sha-seq');
    },
  });
  await Github.pull();
  await Github.queueSync(docWith({ records: one }), { message: 'Mark present' });
  await Github.queueSync(docWith({ records: two }), { message: 'Mark absent' });
  assert.deepEqual(messages, ['Mark present', 'Mark absent'], 'the repository history reads like the log of what happened');
});

/* ---------- failures the UI has to explain ---------- */
test('a rejected token, a permission error and a rate limit are three different messages', async () => {
  connect();
  api({ 'GET attendance.json': () => reply(401, { message: 'Bad credentials' }) });
  await assert.rejects(() => Github.pull(), (err) => err.kind === 'auth' && /Contents: read and write/.test(err.message));

  connect();
  api({ 'GET attendance.json': () => reply(403, { message: 'Resource not accessible' }) });
  await assert.rejects(() => Github.pull(), (err) => err.kind === 'permission');

  connect();
  const soon = Math.floor(Date.now() / 1000) + 120;
  api({ 'GET attendance.json': () => reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': soon }) });
  await assert.rejects(() => Github.pull(), (err) => err.kind === 'rate-limit');
  assert.ok(Github.rateLimitedUntil() > Date.now(), 'the reset time is remembered');
  // Once limited, further syncs stop before spending a request on something that will fail.
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return reply(200, {});
  };
  await assert.rejects(() => Github.sync(docWith()), (err) => err.kind === 'rate-limit');
  assert.equal(called, 0);
});

test('a dead network is a network error, not a silent success', async () => {
  connect();
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(() => Github.sync(docWith()), (err) => err.kind === 'network');
  assert.equal(Github.state().status, 'error');
  assert.equal(Github.state().pending, true, 'the UI has to be able to say the change is not saved');
});

test('sync refuses to pretend when there is nothing configured', async () => {
  Github.disconnect();
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return reply(200, {});
  };
  await assert.rejects(() => Github.sync(docWith()), (err) => err.kind === 'not-configured');
  assert.equal(called, 0);
});

/* ---------- merge ---------- */
test('merge unions the lists by id, keeps this device\'s values on a clash, and never drops a subject', () => {
  const remote = docWith({
    subjects: [{ id: 's1', name: 'From the other device', code: 'S1', credits: 3 }, { id: 's2', name: 'Only remote', code: 'S2', credits: 4 }],
    records: [{ id: 'r1', status: 'absent' }],
    settings: Object.assign(Store.defaults().settings, { threshold: 0.8 }),
  });
  const local = docWith({
    subjects: [{ id: 's1', name: 'Mine', code: 'S1', credits: 3 }],
    records: [{ id: 'r2', status: 'present' }],
    settings: Object.assign(Store.defaults().settings, { threshold: 0.75 }),
  });
  const merged = Github.merge(remote, local);
  assert.deepEqual(merged.subjects.map((s) => s.id).sort(), ['s1', 's2']);
  assert.equal(merged.subjects.find((s) => s.id === 's1').name, 'Mine', 'the edit made here wins');
  assert.deepEqual(merged.records.map((r) => r.id).sort(), ['r1', 'r2']);
  assert.equal(merged.settings.threshold, 0.75, 'this device is the working copy for everything else');
});

test('merge refuses a prototype-shaped remote document instead of adopting it', () => {
  // The remote file lives in a repository, so its contents are not this app's to trust. JSON.parse
  // keeps `__proto__` as a plain own key, but folding it into another object with Object.assign would
  // run the setter and hand the merged document an attacker-chosen prototype.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"settings":{"__proto__":{"threshold":0}},"subjects":[{"id":"s1","name":"Plant","__proto__":{"junk":1}},{"id":"s2","name":"Trap","__proto__":{"junk":2}}]}');
  const local = docWith({ subjects: [{ id: 's3', name: 'Mine' }] });
  const merged = Github.merge(hostile, local);
  assert.equal({}.polluted, undefined, 'Object.prototype is untouched');
  assert.equal(merged.polluted, undefined);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype, 'the merged document keeps a clean prototype');
  assert.ok(!Object.prototype.hasOwnProperty.call(merged, '__proto__'));
  assert.deepEqual(merged.subjects.map((s) => s.id), ['s1', 's2', 's3'], 'the union still happens');
  merged.subjects.forEach((s) => assert.equal(Object.getPrototypeOf(s), Object.prototype));
  assert.equal(merged.subjects.find((s) => s.id === 's1').name, 'Plant');
  assert.equal(merged.settings.threshold, Store.defaults().settings.threshold, 'this device wins on the clash');
});

/* ---------- images ride in their own file ---------- */
test('timetable screenshots are committed separately, and only when they change', async () => {
  connect();
  const writes = [];
  api({
    'GET attendance.json': () => fileReply(JSON.stringify(docWith()), 'sha-doc'),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance-images.json': ({ body }) => {
      writes.push(JSON.parse(Github.decode(body.content)));
      return okWrite('sha-img-' + writes.length);
    },
    'PUT attendance.json': () => okWrite('sha-doc'),
  });
  const images = [{ id: 'i1', name: 'tt.jpg', dataUrl: 'data:image/jpeg;base64,AAAA', addedAt: '2026-10-01' }];
  assert.equal((await Github.syncImages(images)).skipped, false);
  assert.equal((await Github.syncImages(images)).skipped, true, 'the same set is not committed twice');
  assert.equal(writes.length, 1);
  await Github.syncImages([{ id: 'i1', name: 'tt.jpg', dataUrl: 'data:image/jpeg;base64,BBBBBB', addedAt: '2026-10-01' }]);
  assert.equal(writes.length, 2, 'a re-cropped image is a real change');
});

/* ---------- what the app is told ---------- */
test('a successful sync is reported as saved, with the time it happened', async () => {
  connect();
  let sawPending = false;
  api({
    'GET attendance.json': () => fileReply(JSON.stringify(docWith()), 'sha-s'),
    'GET attendance-images.json': () => reply(404, {}),
    'PUT attendance.json': () => okWrite('sha-s'),
  });
  const off = Github.onChange((state) => {
    if (state.status === 'pending') sawPending = true;
  });
  await Github.pull();
  await Github.queueSync(docWith(), { message: 'x' });
  off();
  assert.ok(sawPending, 'the chip can say "saving…" while a write is in flight');
  assert.equal(Github.state().status, 'saved');
  assert.ok(Github.state().lastSyncAt);
});

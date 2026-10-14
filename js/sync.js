/* sync.js — the only place that talks to the network.
 *
 * Attendance is not kept on this device. The document lives as one JSON object in this site's
 * Cloudflare D1 database (worker/api.js, tables `spaces` + `docs`), and every interaction pulls it,
 * applies the change and pushes it back, so the database is the single source of truth.
 *
 * There is nothing to configure and no Settings screen for it: the first visit claims a space
 * automatically and this browser keeps its key in localStorage. The server stores only a hash of
 * that key. Export / Import JSON in Settings remains the backup and the way to move semesters.
 *
 * Two deliberate details:
 *  - `ocr.images` (base64 screenshot references, the only bulky field) travels in a second document
 *    kind and is pushed only when it actually changed. Paying for that on every tap would write
 *    megabytes for no reason.
 *  - a push that loses the race re-pulls, merges and retries once, instead of overwriting the other
 *    device's edit.
 */
(function (global) {
  'use strict';

  // Per-browser: which space of this site's own database this device writes to, and the key that
  // proves it belongs there. The server keeps only a hash of the key. The name is historical
  // (a previous version synced elsewhere); it is kept byte-for-byte so a browser that already
  // holds a space keeps writing to it instead of claiming a fresh, empty one.
  const CLOUD_KEY = 'attendance-github/cloud';
  const API_BASE = ''; // the database is on this origin, so a sub-path deployment still finds it

  class SyncError extends Error {
    constructor(kind, message, detail) {
      super(message);
      this.name = 'SyncError';
      this.kind = kind; // not-configured | auth | conflict | rate-limit | network | bad-response
      this.detail = detail || null;
    }
  }

  /* ---------- device state ---------- */
  let cloud = { space: '', key: '' };
  let provisioning = null;
  let baseRev = 0; // the rev we last read or wrote — required by the next PUT
  let imagesRev = 0;

  const state = { status: 'idle', error: null, pulled: false, lastSyncAt: null, pending: false, message: '' };
  const listeners = new Set();

  function readStore(key) {
    try {
      return global.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }
  function writeStore(key, value) {
    try {
      if (value == null) global.localStorage.removeItem(key);
      else global.localStorage.setItem(key, value);
    } catch (err) {
      /* private mode / quota: the app still works, the setting just is not remembered */
    }
  }

  function loadCloud() {
    try {
      const raw = readStore(CLOUD_KEY);
      if (raw) cloud = Object.assign({ space: '', key: '' }, JSON.parse(raw));
    } catch (err) {
      cloud = { space: '', key: '' };
    }
  }

  function persistCloud() {
    writeStore(CLOUD_KEY, cloud.space && cloud.key ? JSON.stringify(cloud) : null);
  }

  /** False only where there is no same-origin API to talk to (file://) — everywhere else just works. */
  const isConfigured = () => typeof global.location === 'undefined' || global.location.protocol !== 'file:';
  const describe = () => 'cloud database';

  /** Claims a space on the server — the first visit, or after the key was forgotten. */
  async function provisionSpace() {
    let res;
    try {
      res = await global.fetch(`${API_BASE}/api/spaces`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (err) {
      throw new SyncError('network', 'Could not reach the cloud database — check the connection.', err.message);
    }
    if (!res.ok) throw new SyncError('bad-response', `The database answered ${res.status} while claiming a space.`);
    const body = await res.json();
    cloud = { space: body.space, key: body.key };
    persistCloud();
    emit({});
    return cloud;
  }

  /** One claim at a time: two taps in the same tick must not ask for two different spaces. */
  async function ensureCloud() {
    if (cloud.space && cloud.key) return cloud;
    if (!provisioning) {
      provisioning = provisionSpace().finally(() => {
        provisioning = null;
      });
    }
    return provisioning;
  }

  /** `doc` is the document, `images` the bulky second kind. */
  function kindOf(kind) {
    return kind === 'images' ? 'images' : 'doc';
  }

  async function cloudCall(method, target, body) {
    const creds = await ensureCloud();
    const headers = { Accept: 'application/json', 'X-Sync-Key': creds.key };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await global.fetch(`${API_BASE}${target}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new SyncError('network', 'Could not reach the cloud database — check the connection.', err.message);
    }
    if (res.status === 404) return { status: 404, res: null };
    if (res.status === 409) return { status: 409, res: await res.json() };
    if (res.status === 200 || res.status === 201) return { status: res.status, res: await res.json() };

    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (err) {
      detail = res.statusText || '';
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth', 'The database refused this device\u2019s key — its saved space is no longer valid.', detail);
    }
    if (res.status === 429) throw new SyncError('rate-limit', 'The database is limiting this device for a moment — syncing resumes shortly.', detail);
    throw new SyncError('bad-response', `The database answered ${res.status}${detail ? ` — ${detail}` : ''}.`, detail);
  }

  /* ---------- transport ---------- */
  /** Reads one document kind. Returns null when nothing has been written yet (the first push creates it). */
  async function readDoc(kind) {
    if (!isConfigured()) throw new SyncError('not-configured', 'Open the hosted site to save attendance — file:// has no database to talk to.');
    const creds = await ensureCloud();
    const got = await cloudCall('GET', `/api/doc?space=${encodeURIComponent(creds.space)}&kind=${kindOf(kind)}`);
    if (got.status === 404 || !got.res || !got.res.data) return null;
    // The rev stands in for a file version: it is what the next write has to quote.
    return { data: got.res.data, rev: String(got.res.rev), updatedAt: got.res.updatedAt || new Date().toISOString() };
  }

  async function writeDoc(kind, data, rev) {
    const creds = await ensureCloud();
    const baseRev = Number(rev);
    const got = await cloudCall('PUT', '/api/doc', {
      space: creds.space,
      kind: kindOf(kind),
      data,
      baseRev: Number.isInteger(baseRev) && baseRev >= 0 ? baseRev : 0,
    });
    if (got.status === 409) throw new SyncError('conflict', 'The database was saved by another device while this one was editing.');
    return String(got.res && got.res.rev != null ? got.res.rev : '');
  }

  /* ---------- merge ---------- */
  /**
   * Union by id for the two collections that only ever grow (subjects, marks) with this device
   * winning on a genuine clash, and this device's document for everything else. Combined with a push
   * after every interaction, a second device can only disagree during the moment a write is in
   * flight, so "newest edit wins, nothing is dropped from the lists" is the honest rule.
   */
  function merge(remote, local) {
    if (!remote) return local;
    if (!local) return remote;
    // The remote side is a document we did not write: fold it in without letting a `__proto__` key
    // in it reach an Object.assign setter, and without carrying one into the items either.
    const plain = (o) => (global.AD && global.AD.Store && global.AD.Store.plainObject ? global.AD.Store.plainObject(o) : o);
    const byId = (a, b) => {
      const map = new Map();
      (a || []).forEach((item) => item && item.id && map.set(item.id, plain(item)));
      (b || []).forEach((item) => item && item.id && map.set(item.id, plain(item)));
      return Array.from(map.values());
    };
    return Object.assign({}, plain(remote), plain(local), {
      subjects: byId(remote.subjects, local.subjects),
      records: byId(remote.records, local.records),
    });
  }

  /* ---------- the pull / push cycle ---------- */
  async function pull() {
    const doc = await readDoc('doc');
    const images = await readDoc('images').catch(() => null);
    if (doc) baseRev = doc.rev;
    imagesRev = images ? images.rev : 0;
    return { doc, images };
  }

  /**
   * Pull, merge if the remote moved under us, push. The document this device holds is the working
   * copy. Every failure is recorded in the state before it is rethrown, so whoever called this — a
   * tap, a retry — the status chip tells the same story.
   */
  async function sync(data, opts) {
    try {
      return await runSync(data, opts);
    } catch (err) {
      emit({
        status: err.kind === 'rate-limit' ? 'blocked' : 'error',
        error: err,
        pending: true,
        message: err.message,
      });
      throw err;
    }
  }

  async function runSync(data, opts) {
    if (!isConfigured()) throw new SyncError('not-configured', 'Open the hosted site to save attendance — file:// has no database to talk to.');

    emit({ status: 'syncing', error: null, message: '' });
    let pulled = false;
    let next = data;

    const remote = await readDoc('doc');
    if (remote && remote.rev !== baseRev) {
      next = merge(remote.data, data);
      pulled = true;
    }

    let rev;
    try {
      rev = await writeDoc('doc', next, remote ? remote.rev : 0);
    } catch (err) {
      if (err.kind !== 'conflict') throw err;
      // Lost the race: read again, fold in whatever arrived, and write once more.
      const again = await readDoc('doc');
      next = merge(again ? again.data : null, data);
      rev = await writeDoc('doc', next, again ? again.rev : 0);
      pulled = true;
    }
    baseRev = rev;
    emit({ status: 'saved', error: null, pulled, lastSyncAt: new Date().toISOString(), pending: false, message: pulled ? 'Pulled a change from another device first.' : '' });
    return { data: next, pulled, rev };
  }

  /** The bulky screenshot references, pushed only when they changed. */
  async function syncImages(images, opts) {
    if (!isConfigured()) return { skipped: true };
    const list = (images || []).slice(0, 2);
    const fingerprint = JSON.stringify(list.map((i) => [i.id, (i.dataUrl || '').length]));
    if (fingerprint === lastImagesFingerprint) return { skipped: true };
    const remote = await readDoc('images');
    const rev = await writeDoc('images', list, remote ? remote.rev : 0);
    imagesRev = rev;
    lastImagesFingerprint = fingerprint;
    return { skipped: false, rev };
  }
  let lastImagesFingerprint = null;

  /**
   * One request at a time, in the order the interactions happened. Taps can outrun the network, and
   * two writes racing each other would collide on the document's rev (each would undo the other's
   * view of it), so the writes are chained: every interaction is pushed, sequentially. A queued step
   * that has not started yet is simply replaced by the newest state, because the newer document
   * already contains it.
   */
  let chain = Promise.resolve();
  let tail = null;

  function queueSync(data, opts) {
    emit({ status: 'pending', pending: true });
    if (tail && !tail.started) {
      tail.data = data;
      tail.opts = opts;
      return tail.promise;
    }
    const step = { data, opts, started: false, promise: null };
    tail = step;
    const run = async () => {
      step.started = true;
      try {
        return await sync(step.data, step.opts); // sync() records any failure in the state itself
      } finally {
        if (tail === step) tail = null;
      }
    };
    step.promise = chain.then(run);
    // A failed write must not stop the next one from being attempted.
    chain = step.promise.catch(() => undefined);
    return step.promise;
  }

  function onChange(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  }
  function emit(patch) {
    Object.assign(state, patch || {});
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.error('sync listener failed', err);
      }
    });
  }

  /** Forgets this device's space and starts over — used by the tests and by "Erase everything". */
  function disconnect() {
    cloud = { space: '', key: '' };
    persistCloud();
    baseRev = 0;
    imagesRev = 0;
    lastImagesFingerprint = null;
    emit({ status: 'idle', error: null, lastSyncAt: null, pending: false, message: '' });
  }

  loadCloud();

  global.AD = global.AD || {};
  global.AD.Sync = {
    SyncError,
    isConfigured,
    describe,
    pull,
    merge,
    sync,
    syncImages,
    queueSync,
    disconnect,
    onChange,
    state: () => Object.assign({}, state),
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* github.js — the only place that talks to the network.
 *
 * Attendance is not kept on this device. The document lives as one JSON file in a sync target and
 * every interaction pulls the file, applies the change and pushes it back, so that target is the
 * single source of truth (and its history is your undo). This module owns both targets:
 *
 *  - **This site's database (the default).** When the tracker is served over http(s) it provisions a
 *    "space" in the site's own Cloudflare D1 database on first use — no account, no token, nothing
 *    pasted. The document is a row there whose `rev` column plays the part a file's sha plays, and
 *    the space's key (kept in this browser, hashed on the server) is the credential. See worker/api.js.
 *  - **A GitHub repository.** The original transport: the Contents API, one commit per interaction,
 *    needing an owner, a repository and a fine-grained token in Settings. Still there for anyone who
 *    wants their attendance as a file they own, and the only option from file://.
 *
 * Both speak the same contract — read by sha, write with the sha the edit was based on, and on a
 * lost race (HTTP 409/422: the sha/rev moved) re-read, merge and retry once — which is why the rest
 * of the app never asks which one it is talking to.
 *
 * Two deliberate details:
 *  - `ocr.images` (base64 screenshot references, the only bulky field) travels in a second file and
 *    is pushed only when it actually changed. Paying for that on every tap would fill the history
 *    with megabytes for no reason.
 *  - a push that loses the race re-pulls, merges and retries once, instead of overwriting the other
 *    device's edit.
 */
(function (global) {
  'use strict';

  const API = 'https://api.github.com';
  const ACCEPT = 'application/vnd.github+json';
  const API_VERSION = '2022-11-28';
  // Non-secret settings only. The token is stored separately (and only when the user asks for it).
  const CONFIG_KEY = 'attendance-github/config';
  const TOKEN_KEY = 'attendance-github/token';

  const DEFAULTS = { owner: '', repo: '', branch: 'main', path: 'attendance.json', rememberToken: false, mode: '' };
  // Non-secret, per-browser: which space of this site's own database this device writes to, and the
  // key that proves it belongs there. The server keeps only a hash of the key.
  const CLOUD_KEY = 'attendance-github/cloud';
  const API_BASE = ''; // the database is on this origin, so a sub-path deployment still finds it

  class SyncError extends Error {
    constructor(kind, message, detail) {
      super(message);
      this.name = 'SyncError';
      this.kind = kind; // not-configured | auth | permission | missing | conflict | rate-limit | network | bad-response
      this.detail = detail || null;
    }
  }

  /* ---------- configuration ---------- */
  let cfg = Object.assign({}, DEFAULTS);
  let token = '';
  let baseSha = null; // the sha we last read or wrote — required by the next PUT
  let imagesSha = null;
  let rateLimitedUntil = 0;
  let rateLimitNote = '';
  let cloud = { space: '', key: '' };
  let provisioning = null;

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

  function loadConfig() {
    try {
      const raw = readStore(CONFIG_KEY);
      if (raw) cfg = Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (err) {
      cfg = Object.assign({}, DEFAULTS);
    }
    if (cfg.rememberToken) token = readStore(TOKEN_KEY) || '';
    loadCloud();
    emit({});
  }

  /**
   * Which target this device writes to. An explicit choice always wins; otherwise a configured
   * repository keeps GitHub, and a served page defaults to the built-in database. file:// has no
   * same-origin API to talk to, so it is always GitHub there.
   */
  function mode() {
    if (cfg.mode === 'github' || cfg.mode === 'cloud') return cfg.mode;
    if (cfg.owner && cfg.repo) return 'github';
    return typeof global.location !== 'undefined' && /^https?:$/.test(global.location.protocol) ? 'cloud' : 'github';
  }

  function configure(patch) {
    const next = Object.assign({}, cfg, patch || {});
    next.owner = String(next.owner || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    next.repo = String(next.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').split('/').pop().replace(/\.git$/, '');
    next.branch = String(next.branch || 'main').trim() || 'main';
    next.path = String(next.path || 'attendance.json').trim().replace(/^\/+/, '') || 'attendance.json';
    next.rememberToken = !!next.rememberToken;
    const previousMode = cfg.mode || '';
    next.mode = patch && (patch.mode === 'cloud' || patch.mode === 'github') ? patch.mode : previousMode;
    cfg = next;
    writeStore(CONFIG_KEY, JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: cfg.path, rememberToken: cfg.rememberToken }));
    if (!cfg.rememberToken) writeStore(TOKEN_KEY, null);
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'token')) setToken(patch.token, cfg.rememberToken, true);
    emit({});
    return cfg;
  }

  function persistConfig() {
    writeStore(CONFIG_KEY, JSON.stringify({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: cfg.path, rememberToken: cfg.rememberToken }));
  }

  /** The token is never written to the repo and never logged; it is kept in memory unless the user asked for it to be remembered. */
  function setToken(value, remember, quiet) {
    token = String(value == null ? '' : value).trim();
    cfg.rememberToken = !!remember;
    persistConfig();
    writeStore(TOKEN_KEY, cfg.rememberToken && token ? token : null);
    if (!quiet) emit({});
    return token;
  }

  /**
   * Ticks or unticks "remember the token on this device" without touching the token itself — the
   * value in memory is what gets written (or removed) from storage.
   */
  function setRemember(flag) {
    cfg.rememberToken = !!flag;
    persistConfig();
    writeStore(TOKEN_KEY, cfg.rememberToken && token ? token : null);
    emit({});
    return cfg.rememberToken;
  }

  const hasToken = () => !!token;
  const isConfigured = () => (mode() === 'cloud' ? true : !!(cfg.owner && cfg.repo && cfg.path && token));
  function imagesPath() {
    return cfg.path.replace(/(\.json)?$/i, '') + '-images.json';
  }
  function describe() {
    if (mode() === 'cloud') {
      return cloud.space ? `this site's database · space ${cloud.space}` : "this site's database (provisioning…)";
    }
    return cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo} · ${cfg.path} (${cfg.branch})` : 'not connected';
  }

  /* ---------- this site's database (the built-in target) ---------- */
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

  /** Points this device at a space it was given (space id + key, copied from another device). */
  function setCloud(space, key) {
    cloud = { space: String(space || '').trim().toLowerCase(), key: String(key || '').trim() };
    persistCloud();
    emit({});
    return cloud;
  }

  const cloudInfo = () => Object.assign({}, cloud);

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
      throw new SyncError('network', 'Could not reach this site\u2019s database \u2014 check the connection.', err.message);
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

  /** `attendance.json` is the document, `attendance-images.json` the bulky second file. */
  function kindOf(path) {
    return path && path.indexOf('-images.json') >= 0 ? 'images' : 'doc';
  }

  async function cloudCall(method, target, body) {
    const creds = await ensureCloud();
    const headers = { Accept: 'application/json', 'X-Sync-Key': creds.key };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await global.fetch(`${API_BASE}${target}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new SyncError('network', 'Could not reach this site\u2019s database \u2014 check the connection.', err.message);
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
      throw new SyncError('auth', 'The database refused this device\u2019s sync key. Paste the space id and key from Settings \u2192 Sync to rejoin that space.', detail);
    }
    if (res.status === 429) throw new SyncError('rate-limit', 'The database is limiting this device for a moment \u2014 syncing resumes shortly.', detail);
    throw new SyncError('bad-response', `The database answered ${res.status}${detail ? ` \u2014 ${detail}` : ''}.`, detail);
  }

  /* ---------- base64 (UTF-8 safe, chunked so large documents cannot blow the call stack) ---------- */
  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return global.btoa(binary);
  }
  function decode(base64) {
    const clean = String(base64).replace(/\s+/g, '');
    const binary = global.atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ---------- transport ---------- */
  function url(path, extra) {
    return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${extra || ''}`;
  }

  function headers(extra) {
    return Object.assign(
      {
        Accept: ACCEPT,
        'X-GitHub-Api-Version': API_VERSION,
        Authorization: `Bearer ${token}`,
      },
      extra || {},
    );
  }

  /**
   * One place where API failures become typed errors the UI can act on: a bad token, a missing repo,
   * a rate limit and a lost race all need different words in front of the user.
   */
  async function call(method, target, body) {
    let res;
    try {
      res = await global.fetch(target, {
        method,
        headers: headers(body ? { 'Content-Type': 'application/json' } : null),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new SyncError('network', 'Could not reach GitHub — check the connection.', err.message);
    }

    const remaining = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
    const reset = res.headers && res.headers.get ? res.headers.get('x-ratelimit-reset') : null;
    if (remaining === '0' && reset) {
      rateLimitedUntil = Number(reset) * 1000;
      const mins = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 60000));
      rateLimitNote = `GitHub's API limit is used up — syncing resumes in about ${mins} minute${mins === 1 ? '' : 's'}.`;
    }

    if (res.status === 404) return { status: 404, res: null };
    if (res.status === 200 || res.status === 201) return { status: res.status, res: await res.json() };

    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch (err) {
      detail = res.statusText || '';
    }
    if (res.status === 401) throw new SyncError('auth', 'GitHub rejected the token (401). Check it is not expired and has the "Contents: read and write" permission on this repository.', detail);
    if (res.status === 403) {
      if (rateLimitedUntil > Date.now()) throw new SyncError('rate-limit', rateLimitNote, detail);
      throw new SyncError('permission', `GitHub refused the write (403). The token needs "Contents: read and write" on ${cfg.owner}/${cfg.repo}.`, detail);
    }
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'The file changed on GitHub while saving.', detail);
    if (res.status === 404) throw new SyncError('missing', `GitHub could not find ${cfg.owner}/${cfg.repo} (or the branch "${cfg.branch}").`, detail);
    throw new SyncError('bad-response', `GitHub answered ${res.status}${detail ? ` — ${detail}` : ''}.`, detail);
  }

  /** Reads one JSON file. Returns null when the file does not exist yet (the first push creates it). */
  async function readFile(path) {
    if (!isConfigured()) throw new SyncError('not-configured', 'Choose a sync target in Settings \u2192 Sync first.');
    if (mode() === 'cloud') {
      const creds = await ensureCloud();
      const got = await cloudCall('GET', `/api/doc?space=${encodeURIComponent(creds.space)}&kind=${kindOf(path)}`);
      if (got.status === 404 || !got.res || !got.res.data) return null;
      // The rev stands in for the file's sha: it is what the next write has to quote.
      return { data: got.res.data, sha: String(got.res.rev), path, updatedAt: got.res.updatedAt || new Date().toISOString() };
    }
    const first = await call('GET', url(path, `?ref=${encodeURIComponent(cfg.branch)}`));
    if (first.status === 404) return null;
    const meta = first.res;
    if (!meta || meta.type !== 'file') return null;

    // The Contents API inlines base64 only up to 1 MB; larger files come back through the blob API.
    let content = meta.content;
    if (!content && meta.size > 0) {
      const blob = await call('GET', `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/blobs/${meta.sha}`);
      if (blob.status !== 200 || !blob.res || !blob.res.content) {
        throw new SyncError('bad-response', `Could not read ${meta.path} from GitHub.`);
      }
      content = blob.res.content;
    }
    let data = null;
    try {
      data = JSON.parse(decode(content || ''));
    } catch (err) {
      throw new SyncError('bad-response', `${path} on GitHub is not valid JSON — fix or delete it there, then sync again.`, err.message);
    }
    return { data, sha: meta.sha, path, updatedAt: new Date().toISOString() };
  }

  async function writeFile(path, data, sha, message) {
    if (mode() === 'cloud') {
      const creds = await ensureCloud();
      const baseRev = Number(sha);
      const got = await cloudCall('PUT', '/api/doc', {
        space: creds.space,
        kind: kindOf(path),
        data,
        baseRev: Number.isInteger(baseRev) && baseRev >= 0 ? baseRev : 0,
      });
      if (got.status === 409) throw new SyncError('conflict', 'The database was saved by another device while this one was editing.', message || '');
      return String(got.res && got.res.rev != null ? got.res.rev : '');
    }
    const body = { message: message || 'Update attendance data', content: encode(JSON.stringify(data, null, 2)), branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await call('PUT', url(path), body);
    return res.res && res.res.content ? res.res.content.sha : null;
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
    // The remote side is a file we did not write: fold it in without letting a `__proto__` key in it
    // reach an Object.assign setter, and without carrying one into the items either.
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
    const doc = await readFile(cfg.path);
    const images = await readFile(imagesPath()).catch(() => null);
    if (doc) baseSha = doc.sha;
    imagesSha = images ? images.sha : null;
    return { doc, images };
  }

  /**
   * Pull, merge if the remote moved under us, push. The document this device holds is the working
   * copy. Every failure is recorded in the state before it is rethrown, so whoever called this — a
   * tap, the pull button, a retry — the status chip tells the same story.
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
    const options = opts || {};
    if (!isConfigured()) throw new SyncError('not-configured', 'Choose a sync target in Settings \u2192 Sync first.');
    if (Date.now() < rateLimitedUntil) {
      emit({ status: 'blocked', message: rateLimitNote });
      throw new SyncError('rate-limit', rateLimitNote);
    }

    emit({ status: 'syncing', error: null, message: '' });
    let pulled = false;
    let next = data;

    const remote = await readFile(cfg.path);
    if (remote && remote.sha !== baseSha) {
      next = merge(remote.data, data);
      pulled = true;
    }

    const message = options.message || 'Update attendance data';
    let sha;
    try {
      sha = await writeFile(cfg.path, next, remote ? remote.sha : null, message);
    } catch (err) {
      if (err.kind !== 'conflict') throw err;
      // Lost the race: read again, fold in whatever arrived, and write once more.
      const again = await readFile(cfg.path);
      next = merge(again ? again.data : null, data);
      sha = await writeFile(cfg.path, next, again ? again.sha : null, message);
      pulled = true;
    }
    baseSha = sha;
    emit({ status: 'saved', error: null, pulled, lastSyncAt: new Date().toISOString(), pending: false, message: pulled ? 'Pulled a change from another device first.' : '' });
    return { data: next, pulled, sha };
  }

  /** The bulky screenshot references, pushed only when they changed. */
  async function syncImages(images, opts) {
    if (!isConfigured()) return { skipped: true };
    const list = (images || []).slice(0, 2);
    const fingerprint = JSON.stringify(list.map((i) => [i.id, (i.dataUrl || '').length]));
    if (fingerprint === lastImagesFingerprint) return { skipped: true };
    const remote = await readFile(imagesPath());
    const sha = await writeFile(imagesPath(), list, remote ? remote.sha : null, (opts && opts.message) || 'Update timetable images');
    imagesSha = sha;
    lastImagesFingerprint = fingerprint;
    return { skipped: false, sha };
  }
  let lastImagesFingerprint = null;

  /**
   * One request at a time, in the order the interactions happened. Taps can outrun the network, and
   * two writes racing each other would collide on the file's sha (each would undo the other's view of
   * it), so the writes are chained: every interaction is pushed, sequentially. A queued step that has
   * not started yet is simply replaced by the newest state, because the newer document already
   * contains it.
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

  /** Cheap liveness check for the "Test connection" button. */
  async function test() {
    if (mode() === 'cloud') {
      const doc = await readFile(cfg.path);
      return { exists: !!doc, sha: doc ? doc.sha : null, records: doc && doc.data && doc.data.records ? doc.data.records.length : 0 };
    }
    if (!cfg.owner || !cfg.repo) throw new SyncError('not-configured', 'Fill in the repository first.');
    if (!token) throw new SyncError('auth', 'Paste a token first.');
    const doc = await readFile(cfg.path);
    return { exists: !!doc, sha: doc ? doc.sha : null, records: doc && doc.data && doc.data.records ? doc.data.records.length : 0 };
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
  function disconnect() {
    if (mode() === 'cloud') {
      // The space and its key stay on this device, so switching the mode back to cloud resumes
      // exactly where this left off. What stops here is the syncing, not the data.
      cfg.mode = 'github';
      persistConfig();
      emit({ status: 'idle', error: null, lastSyncAt: null, pending: false, message: '' });
      return;
    }
    setToken('', false, true);
    baseSha = null;
    imagesSha = null;
    // A deliberate disconnect also forgets a rate-limit window: reconnecting should try again rather
    // than inherit a countdown from an earlier session.
    rateLimitedUntil = 0;
    rateLimitNote = '';
    emit({ status: 'idle', error: null, lastSyncAt: null, pending: false, message: '' });
  }

  loadConfig();

  global.AD = global.AD || {};
  global.AD.Github = {
    SyncError,
    CONFIG_KEY,
    TOKEN_KEY,
    CLOUD_KEY,
    mode,
    cloudInfo,
    setCloud,
    configure,
    config: () => Object.assign({}, cfg, { token: token ? '***' : '' }),
    setToken: (value, remember) => setToken(value, remember),
    setRemember,
    hasToken,
    isConfigured,
    imagesPath,
    describe,
    pull,
    readFile,
    writeFile,
    merge,
    sync,
    syncImages,
    queueSync,
    test,
    disconnect,
    onChange,
    state: () => Object.assign({}, state),
    rateLimitedUntil: () => rateLimitedUntil,
    encode,
    decode,
  };
})(typeof window !== 'undefined' ? window : globalThis);

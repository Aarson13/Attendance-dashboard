/* github.js — the only place that talks to the network.
 *
 * Attendance is not kept on this device. The document lives as a JSON file in a GitHub repository and
 * every interaction pulls the file, applies the change and pushes it back, so the repository is the
 * single source of truth (and its history is your undo). This module owns the GitHub Contents API:
 * reading the file with its sha, writing it back with that sha, and doing the pull-merge-push cycle
 * that makes an edit from one device visible on the next.
 *
 * Two deliberate details:
 *  - `ocr.images` (base64 screenshot references, the only bulky field) travels in a second file and
 *    is pushed only when it actually changed. Paying for that on every tap would fill the repository
 *    history with megabytes for no reason.
 *  - a push that loses the race (HTTP 409/422: the file's sha moved) re-pulls, merges and retries
 *    once, instead of overwriting the other device's edit.
 */
(function (global) {
  'use strict';

  const API = 'https://api.github.com';
  const ACCEPT = 'application/vnd.github+json';
  const API_VERSION = '2022-11-28';
  // Non-secret settings only. The token is stored separately (and only when the user asks for it).
  const CONFIG_KEY = 'attendance-github/config';
  const TOKEN_KEY = 'attendance-github/token';

  const DEFAULTS = { owner: '', repo: '', branch: 'main', path: 'attendance.json', rememberToken: false };

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
    emit({});
  }

  function configure(patch) {
    const next = Object.assign({}, cfg, patch || {});
    next.owner = String(next.owner || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');
    next.repo = String(next.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').split('/').pop().replace(/\.git$/, '');
    next.branch = String(next.branch || 'main').trim() || 'main';
    next.path = String(next.path || 'attendance.json').trim().replace(/^\/+/, '') || 'attendance.json';
    next.rememberToken = !!next.rememberToken;
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
  const isConfigured = () => !!(cfg.owner && cfg.repo && cfg.path && token);
  function imagesPath() {
    return cfg.path.replace(/(\.json)?$/i, '') + '-images.json';
  }
  function describe() {
    return cfg.owner && cfg.repo ? `${cfg.owner}/${cfg.repo} · ${cfg.path} (${cfg.branch})` : 'not connected';
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
    if (!isConfigured()) throw new SyncError('not-configured', 'Connect a GitHub repository first (Settings → Sync).');
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
    if (!isConfigured()) throw new SyncError('not-configured', 'Connect a GitHub repository first (Settings → Sync).');
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

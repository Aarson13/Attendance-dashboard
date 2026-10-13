/* app.js — bootstrap and event wiring for the whole page.
 * Views render as full HTML strings (see ui.js/panels.js); this file only decides *when* to render
 * and routes clicks/changes/drops to AD.Ui.actions.
 */
(function (global) {
  'use strict';
  const A = global.AD;
  const Store = A.Store;
  const Ui = A.Ui;
  const S = Ui.S;

  const App = {
    lastView: null,

    init() {
      S.data = Store.defaults();
      S.date = Ui.todayISO();
      S.month = S.date.slice(0, 7);
      A.Github.onChange(renderSyncStatus);
      App.applyTheme();
      wire();
      App.render(true);
      registerServiceWorker();
      bootstrap();
    },

    applyTheme() {
      document.documentElement.dataset.theme = S.data.settings.theme === 'light' ? 'light' : 'dark';
    },

    render(force) {
      const root = document.getElementById('view');
      if (!root) return;
      const viewChanged = App.lastView !== S.view;
      const y = global.scrollY;
      const viewFn = Ui.views[S.view] || Ui.views.today;
      root.innerHTML = viewFn();
      S.hooks.splice(0).forEach((fn) => {
        try {
          fn(root);
        } catch (err) {
          console.error('view hook failed', err);
        }
      });
      updateTabs();
      updateBrand();
      attachSpotlights(root);
      animateNumbers(root);
      App.lastView = S.view;
      if (viewChanged && !force) global.scrollTo({ top: 0, behavior: 'auto' });
      else global.scrollTo({ top: y, behavior: 'auto' });
      updateScrollProgress();
    },
  };

  /* ---------- chrome ---------- */
  function updateTabs() {
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === S.view ? 'true' : 'false'));
    const active = document.querySelector('#tabs button[aria-selected="true"]');
    const pill = document.querySelector('.tabs-pill');
    if (active && pill) {
      pill.style.width = `${active.offsetWidth}px`;
      pill.style.transform = `translateX(${active.offsetLeft}px)`;
      if (typeof active.scrollIntoView === 'function') active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }

  function updateBrand() {
    const sub = document.getElementById('brandSub');
    if (!sub) return;
    const sem = S.data.settings.semester;
    sub.textContent = sem.start && sem.end ? `${sem.name || 'Semester'} · ${sem.start} → ${sem.end}` : 'set your semester dates';
  }

  let scrollQueued = false;
  function updateScrollProgress() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const bar = document.getElementById('scrollProgress');
      if (!bar) return;
      const h = document.documentElement.scrollHeight - global.innerHeight;
      bar.style.transform = `scaleX(${h > 0 ? Math.min(1, global.scrollY / h) : 0})`;
    });
  }

  function attachSpotlights(root) {
    if (!S.data.settings.spotlights) return;
    if (global.matchMedia && !global.matchMedia('(pointer: fine)').matches) return;
    root.querySelectorAll('.card.spot').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    });
  }

  /* Rare UI's "Animated counter" idea, reimplemented with rAF (no dependency). */
  function animateNumbers(root) {
    const reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.querySelectorAll('[data-countup]').forEach((el) => {
      const target = parseFloat(el.dataset.countup);
      if (!isFinite(target) || reduce) return;
      const decimals = Number(el.dataset.decimals || 0);
      const suffix = el.dataset.suffix || '';
      const dur = 520;
      const start = global.performance ? performance.now() : Date.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (target * eased).toFixed(decimals) + suffix;
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- events ---------- */
  function wire() {
    const tabs = document.getElementById('tabs');
    if (tabs) {
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-tab]');
        if (!btn) return;
        S.view = btn.dataset.tab;
        App.render();
      });
      tabs.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const list = Array.from(tabs.querySelectorAll('button[data-tab]'));
        const i = list.indexOf(document.activeElement);
        if (i < 0) return;
        const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
        next.focus();
      });
    }

    const theme = document.getElementById('themeToggle');
    if (theme) {
      theme.addEventListener('click', () => {
        S.data.settings.theme = S.data.settings.theme === 'light' ? 'dark' : 'light';
        Ui.save('Switch theme');
        App.applyTheme();
        App.render();
      });
    }

    global.addEventListener('scroll', updateScrollProgress, { passive: true });
    global.addEventListener('resize', updateTabs);

    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const name = el.dataset.act;
      const fn = Ui.actions[name];
      if (!fn) return;
      // Form controls are change-driven, never click-driven: running their action on click would
      // preventDefault the file pickers into never opening and re-render the control under the
      // user's cursor (native date pickers, sliders and selects all break that way).
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return;
      e.preventDefault();
      try {
        fn(el, e);
      } catch (err) {
        console.error(`action ${name} failed`, err);
        Ui.toast(`Something went wrong: ${Ui.esc(err.message)}`, 'bad', 8000);
      }
    });

    // Typing is its own channel: an input handler updates the DOM in place instead of re-rendering
    // the view, because re-rendering under the cursor would replace the field the user is typing in.
    document.addEventListener('input', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const fn = Ui.inputs[el.dataset.act];
      if (!fn) return;
      try {
        fn(el, e);
      } catch (err) {
        console.error(`input ${el.dataset.act} failed`, err);
      }
    });

    document.addEventListener('change', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (Ui.onFieldChange && Ui.onFieldChange(el)) return;
      if (Ui.onPanelFieldChange && Ui.onPanelFieldChange(el)) return;
      const fn = Ui.actions[el.dataset.act];
      if (!fn) return;
      try {
        fn(el, e);
      } catch (err) {
        console.error(`change ${el.dataset.act} failed`, err);
        Ui.toast(`Something went wrong: ${Ui.esc(err.message)}`, 'bad', 8000);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') Ui.closeModal();
    });

    document.addEventListener('dragover', (e) => {
      const zone = e.target.closest('.dropzone');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('hover');
    });
    document.addEventListener('dragleave', (e) => {
      const zone = e.target.closest('.dropzone');
      if (zone) zone.classList.remove('hover');
    });
    document.addEventListener('drop', (e) => {
      const zone = e.target.closest('.dropzone');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('hover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      Ui.handleImageFile(file, zone.id === 'calOcrDrop' ? 'calendar' : 'timetable');
    });

    // Coming back to the tab re-pulls, so a change made elsewhere is on screen before you touch
    // anything. The floor keeps a quick tab-away from spending a request for nothing.
    document.addEventListener('visibilitychange', () => {
      if (global.document.hidden) return;
      if (Date.now() - lastPullAt < 15000) return;
      App.refresh();
    });
  }

  /* ---------- the repository is the source of truth ---------- */
  let lastPullAt = 0;

  /**
   * Startup order: pull first, then let anything be edited. Nothing is read from this device — the
   * one exception is a snapshot an older version left in localStorage, which is folded into the
   * repository once and then deleted here.
   */
  async function bootstrap() {
    const Github = A.Github;
    const legacy = Store.localSnapshot();
    // The landing page's "View demo" button. Both forms are accepted because static hosts differ:
    // `?demo=1` survives on GitHub Pages, while a clean-URL server (the project's own `npm run serve`)
    // answers /app.html?demo=1 with a 301 to /app and drops the query — the fragment is kept.
    const wantsDemo = new URLSearchParams(global.location.search).get('demo') === '1' || global.location.hash.replace('#', '') === 'demo';

    if (!Github.isConfigured()) {
      // Nothing to pull. The sample (if it was asked for) runs in memory and says so on every save.
      S.readOnly = true;
      if (legacy && (legacy.subjects.length || legacy.records.length)) S.data = legacy;
      if (wantsDemo) S.data = A.Sample.build(Ui.todayISO());
      App.applyTheme();
      App.render(true);
      if (legacy && (legacy.subjects.length || legacy.records.length)) {
        Ui.toast('This browser still holds attendance from an older version. Connect GitHub in <b>Settings → Sync</b> and it is pushed there once, then deleted here.', 'info', 15000);
      }
      return;
    }

    try {
      const pulled = await Github.pull();
      lastPullAt = Date.now();
      S.readOnly = false;
      if (pulled.doc) S.data = Store.normalize(pulled.doc.data);
      if (pulled.images && pulled.images.data) S.data.ocr.images = pulled.images.data.slice(0, 2);
    } catch (err) {
      S.readOnly = true;
      Ui.toast(`<b>Could not load your data.</b> ${Ui.esc(err.message)}`, 'bad', 15000);
    }

    if (legacy && (legacy.subjects.length || legacy.records.length)) {
      // Fold the old device copy into the repository document (union by id, the repo's values win),
      // push it, and only then drop it from this browser.
      S.data = Github.merge(legacy, S.data);
      const count = legacy.records.length;
      Github.queueSync(S.data, { message: `Import ${count} earlier mark${count === 1 ? '' : 's'} from this browser` })
        .then(() => {
          Store.clearLocal();
          Ui.toast('Data from the previous version is now in GitHub, and has been removed from this browser.', 'ok', 10000);
        })
        .catch(() => Ui.toast('Moved the old local data into memory, but pushing it to GitHub failed — it is still on this device until that succeeds.', 'bad', 15000));
    }

    App.applyTheme();
    App.render(true);

    if (wantsDemo && !S.readOnly) {
      setTimeout(() => Ui.actions['load-sample'](), 350);
    } else if (!S.data.subjects.length && !S.data.records.length && !S.readOnly) {
      setTimeout(() => Ui.toast(`Sync is live — ${Github.describe()}. Start with <b>Subjects</b>, or load the sample semester from <b>Settings</b>.`, 'info', 9000), 700);
    }
  }

  /** Pull (never push) — used when the tab regains focus. */
  App.refresh = async function refresh() {
    const Github = A.Github;
    if (!Github.isConfigured()) return;
    try {
      const pulled = await Github.pull();
      lastPullAt = Date.now();
      if (pulled.doc) {
        S.data = Store.normalize(pulled.doc.data);
        App.applyTheme();
        App.render();
      }
    } catch (err) {
      /* the status chip carries the error; a failed refresh must not disturb the screen */
    }
  };

  /** The topbar chip: what just happened to the last change, in four words or fewer. */
  function renderSyncStatus(state) {
    const chip = document.getElementById('syncChip');
    if (!chip) return;
    const Github = A.Github;
    const configured = Github.isConfigured();
    const when = state.lastSyncAt ? timeAgo(state.lastSyncAt) : '';
    let kind = '';
    let label = '';
    if (!configured) {
      kind = 'off';
      label = Github.mode() === 'github' ? 'GitHub not connected' : 'Sync not connected';
    } else if (state.status === 'syncing' || state.status === 'pending') {
      kind = 'busy';
      label = 'saving…';
    } else if (state.status === 'saved') {
      kind = 'ok';
      label = when ? `saved ${when}` : 'saved';
    } else if (state.status === 'blocked') {
      kind = 'warn';
      label = 'sync paused';
    } else if (state.status === 'error') {
      kind = 'bad';
      label = 'not saved';
    } else {
      kind = '';
      label = when ? `saved ${when}` : 'ready';
    }
    chip.className = `sync-chip ${kind}`;
    chip.textContent = label;
    chip.title = [Github.describe(), state.error ? state.error.message : '', state.message].filter(Boolean).join(' — ');
  }

  function timeAgo(iso) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(global.location.protocol)) return; // file:// has no service workers
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline caching is a bonus, never a requirement */
    });
  }

  A.App = App;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.init());
  else App.init();
})(typeof window !== 'undefined' ? window : globalThis);

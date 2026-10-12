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
      S.data = Store.load();
      S.date = Ui.todayISO();
      S.month = S.date.slice(0, 7);
      App.applyTheme();
      wire();
      App.render(true);
      registerServiceWorker();
      if (!S.data.subjects.length && !S.data.records.length) {
        setTimeout(
          () => Ui.toast('New here? Open <b>Settings</b> → “Load sample semester” for a full demo, or start by adding subjects.', 'info', 10000),
          700,
        );
      }
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
        Store.save(S.data);
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

    global.addEventListener('storage', (e) => {
      if (e.key !== Store.KEY) return;
      S.data = Store.load();
      App.render();
      Ui.toast('Reloaded — another tab changed your attendance data.', 'info');
    });
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

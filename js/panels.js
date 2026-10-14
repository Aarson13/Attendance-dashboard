/* panels.js — Timetable, Calendar and Settings views + the two OCR flows (with Review & Fix).
 * Loaded after ui.js; registers itself into AD.Ui.views / AD.Ui.actions.
 */
(function (global) {
  'use strict';
  const A = global.AD;
  const Calc = A.Calc;
  const Store = A.Store;
  const Ocr = A.Ocr;

  function U() {
    return A.Ui;
  }
  const esc = (v) => U().esc(v);
  const attr = (v) => U().attr(v);
  const p = () => U().S.data.settings.threshold;
  const pctText = (v) => U().pctText(v);

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /**
   * A calendar source URL as HTML: a real link when it is http(s), otherwise the text with a note,
   * because the value comes from the synced document or an imported snapshot file. Escaping alone
   * cannot make a URL safe — `javascript:alert(1)` is valid HTML — so the scheme is checked instead.
   */
  function sourceUrlHtml(url) {
    const raw = String(url == null ? '' : url);
    const safe = A.Store.safeUrl(raw);
    if (safe) return `<a href="${attr(safe)}" target="_blank" rel="noopener noreferrer">${esc(safe)}</a>`;
    if (!raw) return '<span class="muted">no link</span>';
    return `<span title="Not an http(s) link — shown as text">${esc(raw)} <em>(not a link)</em></span>`;
  }

  function overlayMessage(entries) {
    // Show exactly which dates two calendar entries fight over before saving anything.
    const covering = {};
    for (const e of entries) {
      const s = e.start < e.end ? e.start : e.end;
      const t = e.start < e.end ? e.end : e.start;
      for (const d of Calc.eachDay(s, t)) {
        if (!covering[d]) covering[d] = [];
        covering[d].push(e);
      }
    }
    const clashes = Object.entries(covering).filter(([, list]) => list.length > 1);
    return clashes.slice(0, 5).map(([date, list]) => `${date} (${list.map((e) => e.title || e.type).join(' vs ')})`);
  }

  /* ================= Quick add (natural language) =================
   * One box that reads plain English into timetable cells, in the shape of the quick entry the
   * expense tracker uses: it parses as you type, shows exactly what it understood (and what it had to
   * guess), and only the Add button writes anything. Parsing itself is js/magic.js, which is pure —
   * this part is the live preview and the commit.
   */
  let focusMagic = false;

  function magicDraft() {
    const m = U().S.magic;
    return m && typeof m.draft === 'string' ? m.draft : '';
  }

  /** Parse the box into S.magic and hand it back: { draft, rows, warnings, error }. */
  function magicRun(text) {
    const S = U().S;
    const parsed = A.Magic.parse(text, S.data);
    S.magic = { draft: text, rows: parsed.rows, warnings: parsed.warnings, error: parsed.error };
    return S.magic;
  }

  function subjectOptions(selected) {
    const S = U().S;
    return (
      `<option value="" ${selected ? '' : 'selected'}>— pick a subject —</option>` +
      S.data.subjects.map((s) => `<option value="${attr(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`).join('') +
      `<option value="__create__">＋ create a new subject from this text…</option>`
    );
  }

  /** The grammar lighting up as it is recognised, the way the expense tracker's chips do. */
  function magicDetectChips() {
    const m = U().S.magic;
    const rows = m && m.rows ? m.rows : [];
    const parts = [
      ['Day', rows.length > 0 && rows.every((r) => r.day)],
      ['Time', rows.length > 0 && rows.every((r) => r.periodId)],
      ['Subject', rows.length > 0 && rows.every((r) => r.subjectId)],
      ['Lab', rows.some((r) => r.lab)],
    ];
    return parts.map(([name, on]) => `<span class="chip ${on ? 'ok' : ''}">${on ? '✓' : '·'} ${name}</span>`).join('');
  }

  function magicPreview() {
    const m = U().S.magic;
    if (!m || !m.draft.trim()) {
      return '<p class="magic-hint">Start typing — every slot it worked out appears here first. Days, times, periods and labs.</p>';
    }
    const counts = { matched: 0, low: 0, unmatched: 0 };
    m.rows.forEach((r) => (counts[r.state] = (counts[r.state] || 0) + 1));
    const rows = m.rows
      .map((r, i) => {
        const per = U().periodById(r.periodId);
        const when = `${esc(per ? per.label : '?')} · ${esc(per ? per.start : '')}${per && per.end ? `–${esc(per.end)}` : ''}`;
        const how = {
          assumed: 'time assumed',
          same: 'same time as the line before',
          inside: `your “${r.specText}” falls inside it`,
          near: `your “${r.specText}” is the closest to it`,
          end: `your “${r.specText}” ends with it`,
        }[r.how];
        return `<tr data-row="${i}">
          <td class="nowrap">${esc(Calc.DAY_NAMES[r.day - 1])}<br /><small class="muted">${when}</small>${how ? `<br /><small class="muted">${esc(how)}</small>` : ''}</td>
          <td>${esc(r.text || '(named above)')}${r.reason ? `<br /><small class="muted">${esc(r.reason)}</small>` : ''}</td>
          <td class="state-${attr(r.state)}"><select data-act="magic-row-subject" data-row="${i}" aria-label="Subject for ${attr(r.text || 'this slot')}">${subjectOptions(r.subjectId)}</select></td>
          <td><input type="checkbox" data-act="magic-row-lab" data-row="${i}" ${r.lab ? 'checked' : ''} aria-label="Lab" /></td>
          <td><button class="small ghost" data-act="magic-row-del" data-row="${i}" type="button" title="Drop this slot">×</button></td>
        </tr>`;
      })
      .join('');
    return `
      ${m.error ? `<p class="magic-error">${esc(m.error)}</p>` : ''}
      ${
        m.rows.length
          ? `<div class="chips" style="margin:8px 0">
              <span class="chip ok">${counts.matched || 0} matched</span>
              ${counts.low ? `<span class="chip warn">${counts.low} unsure</span>` : ''}
              ${counts.unmatched ? `<span class="chip bad">${counts.unmatched} need a subject</span>` : ''}
              <span class="chip">${m.rows.length} slot${m.rows.length === 1 ? '' : 's'}</span>
            </div>
            <div class="table-scroll">
              <table class="review-table">
                <thead><tr><th>When</th><th>Read as</th><th>Subject</th><th>Lab</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`
          : m.error
            ? ''
            : '<p class="magic-hint">No slot in that yet — name a day (“Mon”, “Mon-Fri”) and a time or period.</p>'
      }
      ${
        m.warnings.length
          ? `<div class="banner warn" style="margin-top:10px"><strong>What it had to guess</strong>${m.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>`
          : ''
      }`;
  }

  /** Repaint just the preview, so typing is never interrupted by a re-render of the whole view. */
  function refreshMagic() {
    const preview = document.getElementById('magicPreview');
    if (preview) preview.innerHTML = magicPreview();
    const chips = document.getElementById('magicDetect');
    if (chips) chips.innerHTML = magicDetectChips();
    const m = U().S.magic;
    const add = document.querySelector('[data-act="magic-add"]');
    if (add) add.disabled = !(m && m.draft.trim() && m.rows.length && !m.rows.some((r) => !r.subjectId));
    const clear = document.querySelector('[data-act="magic-clear"]');
    if (clear) clear.disabled = !(m && m.draft.trim());
  }

  function magicCard() {
    const draft = magicDraft();
    return `<div class="card">
      <div class="section-head">
        <h2>Quick add</h2>
        <span class="spacer"></span>
        <span class="muted">type it like you'd say it — nothing is saved until you press Add</span>
      </div>
      <textarea id="magicInput" class="magic-input" data-act="magic-draft" rows="2" placeholder="Try: CS2001 Mon 9-10, Wed 11-12" aria-label="Natural-language timetable entry" spellcheck="false">${esc(draft)}</textarea>
      <div class="chips" id="magicDetect" aria-hidden="true" style="margin-top:8px">${magicDetectChips()}</div>
      <div id="magicPreview">${magicPreview()}</div>
      <div class="row magic-examples">
        ${A.Magic.EXAMPLES.map((ex) => `<button class="small ghost" data-act="magic-example" data-text="${attr(ex.text)}" type="button" title="${attr(ex.hint)}">${esc(ex.text)}</button>`).join('')}
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" data-act="magic-add" type="button">Add to timetable</button>
        <button data-act="magic-clear" type="button">Clear</button>
        <span class="muted">⌘/Ctrl + Enter adds. Red rows need a subject first.</span>
      </div>
      <details style="margin-top:10px">
        <summary class="muted">What it understands</summary>
        <ul class="muted" style="margin:8px 0 0 18px; line-height:1.6">
          <li><b>Days</b> — <code>Mon</code>, <code>Monday</code>, <code>Tue &amp; Thu</code>, <code>Mon-Fri</code>.</li>
          <li><b>Times</b> — <code>9-10</code>, <code>2-4</code> (afternoon), <code>3:30</code>, <code>9am</code>; or a period: <code>P2</code>, <code>period 3</code>, or a lone <code>3</code>.</li>
          <li><b>Labs</b> — the word lab / practical / tutorial, or a subject that already says it is one.</li>
          <li><b>Subjects</b> — a code (<code>CS2001</code>), a full name or part of one. Anything unsure comes back marked, never guessed silently.</li>
          <li><b>A whole day at once</b> — <code>Mon: CS2001, MA2002, CS2005</code> fills P1, P2, P3 in order and says that it did.</li>
          <li><b>Several lines or commas</b> — <code>CS2001 Mon 9-10, Wed 11-12</code>; a line that leaves out the time keeps the one before it.</li>
        </ul>
      </details>
    </div>`;
  }

  /* ================= Timetable ================= */
  function renderTimetable() {
    const S = U().S;
    const periods = S.data.settings.periods.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const days = S.data.settings.schoolDays.slice().sort((a, b) => a - b);
    const covered = {};
    const rows = periods.map((per, i) => {
      const cells = days.map((day) => {
        if (covered[day] === per.id) return '';
        const cell = (S.data.timetable[String(day)] || {})[per.id];
        const subject = cell && cell.subjectId ? U().subjById(cell.subjectId) : null;
        const canSpan = !!(cell && cell.lab && i + 1 < periods.length);
        if (canSpan) covered[day] = periods[i + 1].id;
        const content = subject
          ? `<span class="cell-code">${esc(subject.code || subject.name)}</span><span class="cell-sub">${esc(subject.code ? subject.name : '')}</span>${cell.lab ? '<span class="cell-lab-tag">lab · 1 class</span>' : ''}`
          : '<span class="cell-sub">— free —</span>';
        return `<td${canSpan ? ' rowspan="2"' : ''}><button class="cell-btn ${subject ? 'filled' : ''} ${cell && cell.lab ? 'lab' : ''}" data-act="cell-edit" data-day="${day}" data-period="${attr(per.id)}" type="button">${content}</button></td>`;
      }).join('');
      return `<tr><td class="time-cell">${esc(per.label)}<br />${esc(per.start)}<br />${per.end ? esc(per.end) : ''}</td>${cells}</tr>`;
    }).join('');

    const periodRows = periods
      .map(
        (per) => `<tr data-id="${attr(per.id)}">
        <td><input data-act="period-field" data-field="label" value="${attr(per.label)}" size="4" aria-label="Period label" /></td>
        <td><input data-act="period-field" data-field="start" value="${attr(per.start)}" size="7" placeholder="09:00" aria-label="Start time" /></td>
        <td><input data-act="period-field" data-field="end" value="${attr(per.end)}" size="7" placeholder="10:00" aria-label="End time" /></td>
        <td><button class="small danger" data-act="period-del" data-id="${attr(per.id)}" type="button">Remove</button></td>
      </tr>`,
      )
      .join('');

    // Focus is handed back to the box after an example chip or an Add, so several slots can be typed
    // one after another without reaching for the mouse.
    U().after((root) => {
      refreshMagic(); // the buttons exist now, and their state depends on the parse
      const el = root.querySelector('#magicInput');
      if (!el) return;
      if (focusMagic) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        focusMagic = false;
      }
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          U().actions['magic-add']();
        }
      });
    });

    return `
      ${magicCard()}
      <div class="card">
        <div class="section-head">
          <h2>Weekly timetable</h2>
          <span class="spacer"></span>
          <span class="muted">A lab spans two periods but counts as <b>one</b> class.</span>
        </div>
        <div class="table-scroll">
          <table class="grid-table">
            <thead><tr><th></th>${days.map((d) => `<th>${Calc.DAY_NAMES[d - 1]}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <details style="margin-top:12px">
          <summary class="muted">Edit periods (${periods.length})</summary>
          <div class="table-scroll" style="margin-top:10px">
            <table class="list" style="min-width:520px">
              <thead><tr><th>Label</th><th>Start</th><th>End</th><th></th></tr></thead>
              <tbody>${periodRows}</tbody>
            </table>
          </div>
          <button class="small" data-act="period-add" type="button" style="margin-top:8px">Add a period</button>
        </details>
      </div>`;
  }

  /* ================= Calendar ================= */
  function renderCalendar() {
    const S = U().S;
    const sem = S.data.settings.semester;
    const c = U().ctx();
    const entries = S.data.calendar.entries.slice().sort((a, b) => a.start.localeCompare(b.start));
    const bySource = new Map(S.data.calendar.sources.map((s) => [s.id, s]));
    const teachingPreview =
      sem.start && sem.end && S.data.subjects.length
        ? `<table class="list" style="margin-top:8px"><thead><tr><th>Subject</th><th>Scheduled this semester (T)</th><th>Labs count as</th></tr></thead><tbody>
            ${Calc.allStats(c)
              .map((s) => `<tr><td>${esc(s.subject.code || s.subject.name)}</td><td>${s.T} <small class="muted">(${esc(s.TSource)})</small></td><td>1 class</td></tr>`)
              .join('')}
          </tbody></table>`
        : '';
    const bundled = global.MANIPAL_CALENDAR;
    const bundledCard = bundled
      ? `<div class="card">
          <div class="section-head">
            <h3>Bundled: ${esc(bundled.title)}</h3>
            <span class="spacer"></span>
            <button class="primary" data-act="cal-bundled-import" type="button">Import this calendar</button>
          </div>
          <p class="muted">Scraped ${esc(bundled.source.fetchedAt)} from ${sourceUrlHtml(bundled.source.url)} by <code>scripts/sync-calendar.mjs</code>. Re-run that script when the college publishes a new PDF, then import again here.</p>
          ${bundled.semesters && bundled.semesters.length > 1 ? `<label class="field">Semester to use<select id="bundledSemester">${bundled.semesters.map((s, i) => `<option value="${i}">${esc(s.name)} (${esc(s.start)} → ${esc(s.end)})</option>`).join('')}</select></label>` : ''}
          <p class="muted">${bundled.entries.length} entries: ${bundled.entries.filter((e) => e.type === 'holiday').length} holidays, ${bundled.entries.filter((e) => e.type === 'exam').length} exam windows, ${bundled.entries.filter((e) => e.type === 'working-swap').length} swapped-timetable days.</p>
          ${bundled.notes && bundled.notes.length ? `<details><summary class="muted">Scraper notes</summary><ul class="muted">${bundled.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
        </div>`
      : '';

    return `
      <div class="card">
        <h2>Semester</h2>
        <div class="field-row">
          <label class="field">Name<input data-act="sem-field" data-field="name" value="${attr(sem.name)}" placeholder="Odd semester 2026" /></label>
          <label class="field">Start<input type="date" data-act="sem-field" data-field="start" value="${attr(sem.start)}" /></label>
          <label class="field">End<input type="date" data-act="sem-field" data-field="end" value="${attr(sem.end)}" /></label>
        </div>
        ${sem.start && sem.end && sem.end < sem.start ? '<div class="banner bad"><strong>The end date is before the start date</strong>Fix one of them — nothing can be scheduled until you do.</div>' : ''}
        ${
          sem.start && sem.end
            ? `<p class="muted" style="margin-top:8px">${Calc.countTeachingDays(c)} teaching days · ${
                entries.filter((e) => {
                  const s = e.start < e.end ? e.start : e.end;
                  const t = e.start < e.end ? e.end : e.start;
                  return e.type !== 'working-swap' && s <= sem.end && t >= sem.start;
                }).length
              } off/exam entries fall inside this window.</p>`
            : '<p class="muted">Fill both dates so the app can count scheduled classes and project your finish.</p>'
        }
        ${teachingPreview}
      </div>
      ${bundledCard}
      <div class="card">
        <div class="section-head">
          <h2>Off days, exams and swapped days</h2>
          <span class="spacer"></span>
          <span class="muted">${entries.length} entries</span>
        </div>
        <div class="table-scroll">
          <table class="list" style="min-width:760px">
            <thead><tr><th>Type</th><th>From</th><th>To</th><th>Title</th><th>Swapped day</th><th>Source</th><th></th></tr></thead>
            <tbody>
              ${
                entries.length
                  ? entries
                      .map(
                        (e) => `<tr>
                  <td><span class="type-badge type-${attr(e.type)}">${esc(e.type.replace('-', ' '))}</span></td>
                  <td>${esc(e.start)}</td>
                  <td>${esc(e.end)}</td>
                  <td>${esc(e.title)}${e.type === 'working-swap' && e.swapDay ? ` <small class="muted">(${Calc.DAY_NAMES[e.swapDay - 1]} timetable)</small>` : ''}</td>
                  <td>${e.swapDay ? Calc.DAY_NAMES[e.swapDay - 1] : ''}</td>
                  <td class="muted"><small>${esc((bySource.get(e.sourceId) || {}).title || 'manual')}</small></td>
                  <td><button class="small danger" data-act="cal-del" data-id="${attr(e.id)}" type="button">Delete</button></td>
                </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="7" class="empty">No entries yet. Import the bundled Manipal calendar above, or add one below.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        <hr />
        <h3>Add an entry</h3>
        <div class="field-row">
          <label class="field">Type
            <select id="calType">
              <option value="holiday">Holiday / off day</option>
              <option value="exam">Exam period (no classes)</option>
              <option value="suspended">Classes suspended</option>
              <option value="working-swap">Extra working day / swapped timetable</option>
            </select>
          </label>
          <label class="field">From<input type="date" id="calStart" /></label>
          <label class="field">To (optional)<input type="date" id="calEnd" /></label>
          <label class="field">Title<input id="calTitle" placeholder="Dussehra" /></label>
          <label class="field">Follows which day?
            <select id="calSwapDay">
              <option value="">— pick —</option>
              ${[1, 2, 3, 4, 5, 6].map((d) => `<option value="${d}">${Calc.DAY_NAMES[d - 1]} timetable</option>`).join('')}
            </select>
          </label>
          <button class="primary" data-act="cal-add" type="button">Add</button>
        </div>
      </div>
      <div class="card">
        <h3>Import / export calendar</h3>
        <div class="row">
          <label class="btn" style="cursor:pointer">Upload CSV<input type="file" accept=".csv,text/csv" data-act="cal-csv" hidden /></label>
          <label class="btn" style="cursor:pointer">Upload .ics<input type="file" accept=".ics,text/calendar" data-act="cal-ics" hidden /></label>
          <button data-act="cal-sample" type="button">Download sample CSV</button>
          <button data-act="cal-export" type="button">Export calendar as CSV</button>
        </div>
        ${S.calWarnings && S.calWarnings.length ? `<div class="banner warn"><strong>Import notes</strong>${S.calWarnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
      </div>
      ${S.calOcr && S.calOcr.phase === 'review' ? calendarOcrReview() : calendarOcrCard()}
      ${
        S.data.calendar.sources.length
          ? `<div class="card"><h3>Sources</h3><ul class="muted">${S.data.calendar.sources
              .map((s) => `<li>${esc(s.title)} — ${sourceUrlHtml(s.url)} (fetched ${esc(s.fetchedAt || 'n/a')})</li>`)
              .join('')}</ul></div>`
          : ''
      }`;
  }

  function calendarOcrCard() {
    const S = U().S;
    const o = S.calOcr || {};
    const busy = o.phase === 'running';
    return `<div class="card">
      <h3>Read a calendar notice from an image (OCR)</h3>
      <p class="muted">The primary source is the scraped PDF above; this is for circulars, notice-board photos and WhatsApp screenshots of holiday lists. Runs in your browser.</p>
      <div class="dropzone" id="calOcrDrop">
        <strong>Drop the notice image here</strong>
        <div class="row" style="justify-content:center;margin-top:8px">
          <label class="btn" style="cursor:pointer">Choose a file<input type="file" accept="image/*" data-act="cal-ocr-file" hidden /></label>
          <label class="btn" style="cursor:pointer">Take a photo<input type="file" accept="image/*" capture="environment" data-act="cal-ocr-file" hidden /></label>
        </div>
        <p>Dates are parsed into rows you can fix before anything is saved.</p>
      </div>
      ${
        busy
          ? `<div class="progress-track"><div class="progress-fill" id="calOcrProgress" style="width:${Math.round((o.progress || 0) * 100)}%"></div></div><p class="muted" id="calOcrStatus">${esc(o.statusText || 'starting…')}</p>`
          : ''
      }
      ${
        o.error
          ? `<div class="banner bad"><strong>No usable dates were found</strong>${esc(o.error)} You can still add entries by hand above${o.image ? ' while looking at the image below' : ''}.</div>
             ${o.image ? `<div class="review-image" style="margin-top:10px"><img src="${attr(o.image)}" alt="Calendar notice reference" /></div>` : ''}`
          : ''
      }
      ${
        o.image && !busy
          ? `<div class="row" style="margin-top:10px">
              <button class="primary" data-act="cal-ocr-run" type="button">Read the dates on this image</button>
              <button class="ghost" data-act="cal-ocr-cancel" type="button">Remove image</button>
            </div>
            <div class="review-image" style="margin-top:10px"><img src="${attr(o.processed || o.image)}" alt="Calendar notice" /></div>`
          : ''
      }
    </div>`;
  }

  function calendarOcrReview() {
    const o = U().S.calOcr;
    return `<div class="card">
      <div class="section-head">
        <h2>Review the dates before saving</h2>
        <span class="spacer"></span>
        <button class="primary" data-act="cal-ocr-confirm" type="button">Confirm and add</button>
        <button data-act="cal-ocr-cancel" type="button">Cancel</button>
      </div>
      <p class="muted">${o.rows.length} dates found. Nothing is added until you confirm — untick anything you don't want.</p>
      <div class="review-layout">
        <div class="review-image"><img src="${attr(o.image)}" alt="Calendar notice" /></div>
        <div class="table-scroll">
          <table class="review-table">
            <thead><tr><th>Use</th><th>Type</th><th>From</th><th>To</th><th>Title</th></tr></thead>
            <tbody>
              ${o.rows
                .map(
                  (r, i) => `<tr>
                <td><input type="checkbox" data-act="cal-ocr-include" data-row="${i}" ${r.include ? 'checked' : ''} aria-label="Include row" /></td>
                <td><select data-act="cal-ocr-type" data-row="${i}">
                  ${['holiday', 'exam', 'suspended', 'working-swap'].map((t) => `<option value="${t}" ${r.type === t ? 'selected' : ''}>${t.replace('-', ' ')}</option>`).join('')}
                </select></td>
                <td><input type="date" data-act="cal-ocr-start" data-row="${i}" value="${attr(r.start)}" /></td>
                <td><input type="date" data-act="cal-ocr-end" data-row="${i}" value="${attr(r.end)}" /></td>
                <td><input data-act="cal-ocr-title" data-row="${i}" value="${attr(r.title)}" /><span class="ocr-text">${esc(r.source)}</span></td>
              </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  /* ================= Settings / Data ================= */
  function renderData() {
    const S = U().S;
    const settings = S.data.settings;
    const bytes = Store.storageBytes(S.data);
    const sync = A.Sync.state();
    const lastSync = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'never';
    return `
      <div class="grid cols-2">
        <div class="card">
          <h2>Rules</h2>
          <label class="field">Minimum attendance (p)
            <input data-act="threshold-set" id="thresholdInput" type="number" min="0.5" max="1" step="0.01" value="${settings.threshold}" style="width:110px" />
          </label>
          <input type="range" min="50" max="100" step="1" value="${Math.round(settings.threshold * 100)}" data-act="threshold-range" style="width:100%;margin-top:6px" aria-label="Threshold slider" />
          <p class="muted">Every formula uses this: safe misses = floor(a/p − t), recovery = ceil((p·t − a)/(1 − p)).</p>
          <hr />
          <h3>Medical / duty leave</h3>
          <label class="row" style="gap:6px"><input type="radio" name="leaveMode" value="absent" data-act="leave-set" ${settings.leaveMode === 'absent' ? 'checked' : ''} /> count it as an absence (default)</label>
          <label class="row" style="gap:6px"><input type="radio" name="leaveMode" value="exclude" data-act="leave-set" ${settings.leaveMode === 'exclude' ? 'checked' : ''} /> exclude it from the count (like a cancelled class)</label>
          <hr />
          <h3>Working days</h3>
          <div class="row">
            ${[1, 2, 3, 4, 5, 6]
              .map((d) => `<label class="row" style="gap:5px"><input type="checkbox" data-act="school-day" data-day="${d}" ${settings.schoolDays.indexOf(d) >= 0 ? 'checked' : ''} /> ${Calc.DAY_NAMES[d - 1]}</label>`)
              .join('')}
          </div>
          <hr />
          <label class="field">Default subject sort
            <select data-act="sort-set">
              <option value="risk" ${settings.sort === 'risk' ? 'selected' : ''}>most at risk first</option>
              <option value="credits" ${settings.sort === 'credits' ? 'selected' : ''}>by credits</option>
            </select>
          </label>
          <hr />
          <h3>Previous attendance</h3>
          <p class="muted">Joining mid-semester? Enter per-subject attended / held from your portal — it joins every calculation.</p>
          <button data-act="tab" data-tab="subjects" type="button">Open Subjects → Existing attendance</button>
        </div>
        <div class="card">
          <h2>Appearance & data</h2>
          <label class="field">Theme
            <select data-act="theme-set">
              <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>dark</option>
              <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>light</option>
            </select>
          </label>
          <label class="row" style="gap:6px;margin-top:8px"><input type="checkbox" data-act="spotlights-set" ${settings.spotlights ? 'checked' : ''} /> subtle pointer glow on cards</label>
          <hr />
          <div class="row">
            <button data-act="export-json" type="button">Export everything (JSON)</button>
            <label class="btn" style="cursor:pointer">Import backup / calendar JSON<input type="file" accept=".json,application/json" data-act="import-json" hidden /></label>
          </div>
          <hr />
          <div class="row">
            <button data-act="load-sample" type="button">Load sample semester</button>
            <button class="danger" data-act="reset-all" type="button">Erase everything</button>
          </div>
          <p class="muted">Every tap is saved automatically to this site's cloud database — status:
          <b>${esc(sync.status)}</b> · last save: ${esc(lastSync)}.</p>
          ${sync.error ? `<p class="chip bad">${esc(sync.error.message)}</p>` : ''}
          <p class="muted">Document size: ${(bytes / 1024).toFixed(1)} KB, saved to the cloud database.
          Screenshots add about ${(Math.max(0, bytes - JSON.stringify(Object.assign({}, S.data, { ocr: { images: [] } })).length) / 1024).toFixed(0)} KB on top.</p>
        </div>
        <div class="card">
          <h2>How to use it</h2>
          <ol class="muted" style="padding-left:18px">
            <li><b>Subjects</b> — add each subject with credits, and if you are joining mid-semester enter the attendance you already have (attended / held) under <b>Existing attendance</b>.</li>
            <li><b>Timetable</b> — click cells to fill the week, or import CSV / run OCR on a screenshot. Mark a lab; it spans two periods but counts once.</li>
            <li><b>Calendar</b> — import the scraped Manipal calendar (or CSV/ICS/OCR) so holidays, exams and swapped days are skipped automatically. Set your semester dates.</li>
            <li><b>Today</b> — tap Present / Absent / Leave / Cancelled per class. Cancelled and off days vanish from every count.</li>
            <li><b>Dashboard</b> — watch the safety buffer, the 75% marker and the heatmap; use <b>Tools</b> for what-ifs and "can I skip tomorrow?".</li>
            <li><b>Export</b> a JSON backup now and then — handy for moving semesters or for a manual restore.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Keeping the calendar fresh</h2>
          <p class="muted">The calendar is scraped, not typed. In a terminal at the project root:</p>
          <pre style="overflow:auto;background:var(--panel-2);padding:10px;border-radius:8px"><code>npm install
npm run sync:calendar -- --url "&lt;calendar-pdf-url&gt;" --label muj-2026-27 --emit-js js/manipal-calendar.js</code></pre>
          <p class="muted">Then reload this page and press “Import this calendar” in the Calendar tab. MIT Manipal's latest public PDF is 2025-26 (<a href="https://www.manipal.edu/mit/mit-experience/academic-calendar.html" target="_blank" rel="noopener noreferrer">calendar page</a>); the bundled snapshot is MUJ's official 2026-27.</p>
        </div>
      </div>`;
  }

  /* ================= OCR flows ================= */
  async function handleImageFile(file, which) {
    const S = U().S;
    if (which !== 'calendar') return;
    try {
      const dataUrl = await Ocr.readAsDataURL(file);
      const base = { grayscale: true, contrast: true, upscale: true, invert: false, rotate: 0, crop: [0, 0, 1, 1], psm: '3', lang: 'eng' };
      S.calOcr = { image: dataUrl, phase: 'idle', progress: 0, statusText: '', error: '', rows: [] };
      const pre = await Ocr.preprocess(dataUrl, Object.assign({}, base, { psm: '6' }));
      S.calOcr.processed = pre.dataUrl;
      A.App.render();
    } catch (err) {
      U().toast(err.message || 'Could not read that image.', 'bad');
    }
  }

  async function runCalendarOcr() {
    const S = U().S;
    const o = S.calOcr;
    if (!o || !o.image) return;
    o.phase = 'running';
    o.error = '';
    o.progress = 0;
    o.statusText = 'starting OCR engine…';
    A.App.render();
    const tick = () => {
      const fill = document.getElementById('calOcrProgress');
      const label = document.getElementById('calOcrStatus');
      if (fill) fill.style.width = `${Math.round((o.progress || 0) * 100)}%`;
      if (label) label.textContent = o.statusText || '';
    };
    try {
      const pre = await Ocr.preprocess(o.image, Object.assign({}, o.settings || {}, { invert: !!(o.settings && o.settings.invert), psm: '6' }));
      o.processed = pre.dataUrl;
      const res = await Ocr.recognise(pre.dataUrl, {
        lang: 'eng',
        psm: '6',
        onProgress: (m) => {
          o.progress = m.progress;
          o.statusText = `${m.status}${m.progress ? ` — ${Math.round(m.progress * 100)}%` : ''}`;
          tick();
        },
      });
      const year = Number((S.data.settings.semester.start || U().todayISO()).slice(0, 4));
      const firstMonth = Number((S.data.settings.semester.start || U().todayISO()).slice(5, 7)) || 7;
      const rows = Ocr.parseDates(res.lines, { year, firstMonth });
      if (!rows.length) {
        o.phase = 'idle';
        o.error = 'No dates were recognised on that image.';
        A.App.render();
        return;
      }
      o.rows = rows.map((r) => Object.assign({ include: true, source: r.source || '' }, r));
      o.phase = 'review';
      A.App.render();
      U().toast(`${rows.length} date${rows.length === 1 ? '' : 's'} found. Check the types and titles, then confirm.`, 'ok');
    } catch (err) {
      o.phase = 'idle';
      o.error = err.message || 'OCR failed.';
      A.App.render();
    }
  }

  function confirmCalendarOcr() {
    const S = U().S;
    const o = S.calOcr;
    const rows = o.rows.filter((r) => r.include && r.start);
    const existing = S.data.calendar.entries;
    let added = 0;
    for (const r of rows) {
      const end = r.end && r.end >= r.start ? r.end : r.start;
      // Only skip a row when the *same* entry is already there — re-importing the same notice
      // twice should be a no-op, but a different title on the same dates is a new entry.
      if (existing.some((e) => e.type === r.type && e.start === r.start && e.end === end && (e.title || '') === (r.title || ''))) continue;
      existing.push({ id: Store.uid('cal'), type: r.type, start: r.start, end, title: r.title || 'From calendar OCR', swapDay: r.swapDay || null, sourceId: null });
      added++;
    }
    U().save();
    const clashes = overlayMessage(existing);
    S.calOcr = null;
    A.App.render();
    U().toast(`${added} calendar entr${added === 1 ? 'y' : 'ies'} added.`, 'ok');
    if (clashes.length) U().toast(`Overlapping entries: ${clashes.map(esc).join('; ')}. The stricter one wins (off day beats a swapped day).`, 'warn', 9000);
  }

  /* ================= actions ================= */
  /** Shared by one-click load (empty semester) and the confirm dialog (existing data). */
  function applySample() {
    const S = U().S;
    S.data = A.Sample.build(U().todayISO());
    U().save('Load the sample semester');
    S.view = 'today';
    S.date = U().todayISO();
    U().closeModal();
    A.App.render();
    U().toast('Sample semester loaded — start on the Today tab.', 'ok', 6000);
  }

  const actions = {
    /* timetable */
    'cell-edit': (el) => {
      const S = U().S;
      const day = el.dataset.day;
      const periodId = el.dataset.period;
      const per = U().periodById(periodId);
      const cell = (S.data.timetable[day] || {})[periodId] || null;
      const ordered = S.data.settings.periods.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const next = ordered[ordered.indexOf(per) + 1];
      U().openModal(
        `${Calc.DAY_NAMES[day - 1]} · ${per.label} ${per.start}${per.end ? `–${per.end}` : ''}`,
        `<div class="field-row">
          <label class="field">Subject
            <select id="cellSubject">
              <option value="">— free period —</option>
              ${S.data.subjects.map((s) => `<option value="${attr(s.id)}" ${cell && cell.subjectId === s.id ? 'selected' : ''}>${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`).join('')}
            </select>
          </label>
          <label class="row" style="gap:6px"><input type="checkbox" id="cellLab" ${cell && cell.lab ? 'checked' : ''} /> Lab (spans this period and the next; counts as 1 class)</label>
        </div>
        ${S.data.subjects.length ? '' : '<p class="banner warn">Add a subject first.</p>'}
        <div class="row">
          <button class="primary" data-act="cell-save" data-day="${day}" data-period="${attr(periodId)}" type="button">Save</button>
          <button data-act="cell-clear" data-day="${day}" data-period="${attr(periodId)}" type="button">Clear cell</button>
        </div>
        ${cell && cell.lab && next ? `<p class="muted">Note: the lab currently occupies ${per.label} and ${next.label} (${next.start}${next.end ? `–${next.end}` : ''}).</p>` : ''}`,
      );
    },
    'cell-save': (el) => {
      const S = U().S;
      const day = el.dataset.day;
      const periodId = el.dataset.period;
      const subject = document.getElementById('cellSubject').value;
      const lab = document.getElementById('cellLab').checked;
      if (!S.data.timetable[day]) S.data.timetable[day] = {};
      if (!subject) {
        delete S.data.timetable[day][periodId];
      } else {
        S.data.timetable[day][periodId] = { subjectId: subject, lab };
      }
      let note = '';
      if (lab) {
        const ordered = S.data.settings.periods.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
        const next = ordered[ordered.indexOf(U().periodById(periodId)) + 1];
        if (next && S.data.timetable[day][next.id]) {
          delete S.data.timetable[day][next.id];
          note = ` ${next.label} was cleared — a lab occupies two periods.`;
        }
      }
      U().save();
      U().closeModal();
      A.App.render();
      U().toast(`Timetable updated.${note}`, note ? 'warn' : 'ok');
    },
    'cell-clear': (el) => {
      const S = U().S;
      const day = el.dataset.day;
      if (S.data.timetable[day]) delete S.data.timetable[day][el.dataset.period];
      U().save();
      U().closeModal();
      A.App.render();
    },
    'period-add': () => {
      const S = U().S;
      const periods = S.data.settings.periods;
      const last = periods.slice().sort((a, b) => String(a.start).localeCompare(String(b.start))).pop();
      periods.push({ id: Store.uid('p'), label: `P${periods.length + 1}`, start: last ? last.end || last.start : '09:00', end: '' });
      U().save();
      A.App.render();
    },
    'period-del': (el) => {
      const S = U().S;
      const id = el.dataset.id;
      S.data.settings.periods = S.data.settings.periods.filter((p2) => p2.id !== id);
      for (const day of Object.keys(S.data.timetable)) delete S.data.timetable[day][id];
      U().save();
      A.App.render();
    },
    'period-field': (el) => {
      const S = U().S;
      const id = el.closest('tr').dataset.id;
      const per = U().periodById(id);
      if (!per) return;
      per[el.dataset.field] = el.value.trim();
      U().save();
    },
    'cal-sample': () => download('calendar-sample.csv', Store.SAMPLE_CALENDAR_CSV, 'text/csv'),
    'cal-export': () => download('calendar.csv', Store.calendarToCSV(U().S.data), 'text/csv'),

    /* quick add (natural language) */
    'magic-example': (el) => {
      magicRun(el.dataset.text || '');
      focusMagic = true;
      A.App.render();
    },
    'magic-clear': () => {
      U().S.magic = null;
      A.App.render();
    },
    'magic-row-subject': (el) => {
      const S = U().S;
      const row = S.magic && S.magic.rows[Number(el.dataset.row)];
      if (!row) return;
      if (el.value === '__create__') {
        // Same deal as the OCR review: the text that was typed becomes the subject, with a default
        // credit count, and the toast says how to correct it.
        const name = (row.text || '').trim() || 'New subject';
        const created = { id: Store.uid('sub'), name, code: '', credits: 3, faculty: '', color: '', classesPerWeek: null, expectedClasses: null, carried: { a: 0, t: 0 } };
        S.data.subjects.push(created);
        row.subjectId = created.id;
        row.state = 'matched';
        row.reason = 'created from this line';
        U().save('Add subject from quick add');
        U().toast(`Created subject “${esc(name)}” with 3 credits — edit it in Subjects.`, 'ok', 7000);
      } else {
        row.subjectId = el.value || null;
        row.state = el.value ? 'matched' : 'unmatched';
        row.reason = el.value ? 'picked here' : '';
      }
      refreshMagic();
    },
    'magic-row-lab': (el) => {
      const S = U().S;
      const row = S.magic && S.magic.rows[Number(el.dataset.row)];
      if (!row) return;
      row.lab = el.checked;
      refreshMagic();
    },
    'magic-row-del': (el) => {
      const S = U().S;
      if (!S.magic) return;
      S.magic.rows.splice(Number(el.dataset.row), 1);
      refreshMagic();
    },
    'magic-add': () => {
      const S = U().S;
      const m = S.magic;
      if (!m || !m.draft.trim()) {
        U().toast('Type a slot first, for example <b>CS2001 Mon 9-10</b>.', 'info', 6000);
        return;
      }
      if (!m.rows.length) {
        U().toast(esc(m.error || 'Nothing to add yet — the preview has to show at least one slot.'), 'warn', 7000);
        return;
      }
      const missing = m.rows.filter((r) => !r.subjectId).length;
      if (missing) {
        U().toast(`Pick a subject for the ${missing} marked row${missing === 1 ? '' : 's'} first — nothing was added.`, 'warn', 8000);
        return;
      }
      const labs = m.rows.filter((r) => r.lab).length;
      const res = A.Magic.apply(m.rows, S.data);
      U().save('Add timetable slots');
      S.magic = null;
      focusMagic = true;
      A.App.render();
      U().toast(`Added <b>${res.applied}</b> slot${res.applied === 1 ? '' : 's'} to the timetable${labs ? ` (${labs} lab${labs === 1 ? '' : 's'})` : ''}.`, 'ok', 6000);
    },

    /* calendar */
    'sem-field': (el) => {
      U().S.data.settings.semester[el.dataset.field] = el.value.trim();
      U().save();
      A.App.render();
    },
    'cal-bundled-import': () => {
      const S = U().S;
      const bundled = global.MANIPAL_CALENDAR;
      if (!bundled) return;
      const sel = document.getElementById('bundledSemester');
      const conv = Store.snapshotToCalendar(bundled);
      const chosen = bundled.semesters && bundled.semesters.length > 1 && sel ? bundled.semesters[Number(sel.value) || 0] : conv.semester;
      // avoid duplicates: same type + dates + title already present
      const existingIds = new Set(S.data.calendar.entries.map((e) => `${e.type}|${e.start}|${e.end}|${e.title}`));
      let added = 0;
      for (const entry of conv.entries) {
        if (existingIds.has(`${entry.type}|${entry.start}|${entry.end}|${entry.title}`)) continue;
        S.data.calendar.entries.push(entry);
        added++;
      }
      if (!S.data.calendar.sources.some((s) => s.url === conv.source.url)) S.data.calendar.sources.push(conv.source);
      if (chosen && (!S.data.settings.semester.start || !S.data.settings.semester.end)) {
        S.data.settings.semester = { name: chosen.name, start: chosen.start, end: chosen.end };
      } else if (chosen) {
        S.data.settings.semester = { name: S.data.settings.semester.name || chosen.name, start: S.data.settings.semester.start, end: S.data.settings.semester.end };
      }
      U().save();
      A.App.render();
      U().toast(`Imported ${added} calendar entries from the scraped Manipal calendar.`, 'ok', 7000);
    },
    'cal-add': () => {
      const S = U().S;
      const type = document.getElementById('calType').value;
      const start = document.getElementById('calStart').value;
      const end = document.getElementById('calEnd').value || start;
      const title = document.getElementById('calTitle').value.trim();
      const swapDay = Number(document.getElementById('calSwapDay').value) || null;
      if (!start) {
        U().toast('Pick a start date for the entry.', 'warn');
        return;
      }
      if (end < start) {
        U().toast('The end date is before the start — the entry was not added.', 'bad');
        return;
      }
      if (type === 'working-swap' && !swapDay) {
        U().toast('A swapped day needs to know which weekday it follows.', 'warn');
        return;
      }
      S.data.calendar.entries.push({ id: Store.uid('cal'), type, start, end, title: title || type, swapDay: type === 'working-swap' ? swapDay : null, sourceId: null });
      U().save();
      const clashes = overlayMessage(S.data.calendar.entries);
      A.App.render();
      U().toast(clashes.length ? `Entry added. Heads-up, it overlaps: ${clashes.map(esc).join('; ')}` : 'Calendar entry added.', clashes.length ? 'warn' : 'ok', clashes.length ? 9000 : 4000);
    },
    'cal-del': (el) => {
      const S = U().S;
      S.data.calendar.entries = S.data.calendar.entries.filter((e) => e.id !== el.dataset.id);
      U().save();
      A.App.render();
    },
    'cal-csv': (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const S = U().S;
        const year = Number((S.data.settings.semester.start || U().todayISO()).slice(0, 4));
        const res = Store.calendarFromCSV(String(reader.result), year);
        S.data.calendar.entries.push(...res.entries);
        S.calWarnings = res.warnings;
        U().save();
        A.App.render();
        U().toast(`Imported ${res.entries.length} calendar entries${res.warnings.length ? `, ${res.warnings.length} row(s) skipped` : ''}.`, res.warnings.length ? 'warn' : 'ok', 7000);
      };
      reader.readAsText(file);
      el.value = '';
    },
    'cal-ics': (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const S = U().S;
        const year = Number((S.data.settings.semester.start || U().todayISO()).slice(0, 4));
        const res = Store.calendarFromICS(String(reader.result), year);
        S.data.calendar.entries.push(...res.entries);
        S.calWarnings = res.warnings;
        U().save();
        A.App.render();
        U().toast(`Imported ${res.entries.length} events from the .ics file.`, 'ok');
      };
      reader.readAsText(file);
      el.value = '';
    },
    'cal-ocr-file': (el) => {
      const file = el.files && el.files[0];
      if (file) handleImageFile(file, 'calendar');
      el.value = '';
    },
    'cal-ocr-run': () => runCalendarOcr(),
    'cal-ocr-cancel': () => {
      U().S.calOcr = null;
      A.App.render();
    },
    'cal-ocr-confirm': () => confirmCalendarOcr(),
    'cal-ocr-include': (el) => {
      const r = U().S.calOcr.rows[Number(el.dataset.row)];
      if (r) r.include = el.checked;
    },
    'cal-ocr-type': (el) => {
      const r = U().S.calOcr.rows[Number(el.dataset.row)];
      if (r) r.type = el.value;
    },
    'cal-ocr-start': (el) => {
      const r = U().S.calOcr.rows[Number(el.dataset.row)];
      if (r) r.start = el.value;
    },
    'cal-ocr-end': (el) => {
      const r = U().S.calOcr.rows[Number(el.dataset.row)];
      if (r) r.end = el.value;
    },
    'cal-ocr-title': (el) => {
      const r = U().S.calOcr.rows[Number(el.dataset.row)];
      if (r) r.title = el.value;
    },

    /* settings */
    'theme-set': (el) => {
      U().S.data.settings.theme = el.value === 'light' ? 'light' : 'dark';
      U().save();
      A.App.applyTheme();
      A.App.render();
    },
    'threshold-set': (el) => {
      const v = Number(el.value);
      U().S.data.settings.threshold = v > 0 && v <= 1 ? v : 0.75;
      U().save();
      A.App.render();
    },
    'threshold-range': (el) => {
      U().S.data.settings.threshold = Number(el.value) / 100;
      U().save();
      A.App.render();
    },
    'leave-set': (el) => {
      U().S.data.settings.leaveMode = el.value === 'exclude' ? 'exclude' : 'absent';
      U().save();
      A.App.render();
    },
    'school-day': (el) => {
      const S = U().S;
      const day = Number(el.dataset.day);
      const list = new Set(S.data.settings.schoolDays);
      if (el.checked) list.add(day);
      else list.delete(day);
      S.data.settings.schoolDays = [...list].sort((a, b) => a - b);
      if (!S.data.settings.schoolDays.length) S.data.settings.schoolDays = [1, 2, 3, 4, 5, 6];
      U().save();
      A.App.render();
    },
    'spotlights-set': (el) => {
      U().S.data.settings.spotlights = el.checked;
      U().save();
      A.App.render(); // the glow is attached per render, so re-render to apply it right away
    },
    'export-json': () => {
      download(`attendance-backup-${U().todayISO()}.json`, Store.exportJSON(U().S.data), 'application/json');
      U().toast('Backup downloaded.', 'ok');
    },
    'import-json': (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const S = U().S;
        try {
          const res = Store.importJSON(String(reader.result));
          if (res.kind === 'backup') {
            U().openModal(
              'Replace everything with this backup?',
              `<p>${esc(res.summary || '')}</p><p class="muted">Your current data will be overwritten. Export a backup first if you're unsure.</p>
               <div class="row"><button class="danger" data-act="import-json-confirm" type="button">Replace my data</button><button data-act="modal-close" type="button">Cancel</button></div>`,
            );
            S.pendingImport = res.data;
          } else {
            const conv = res.snapshot;
            const existingIds = new Set(S.data.calendar.entries.map((e) => `${e.type}|${e.start}|${e.end}|${e.title}`));
            let added = 0;
            for (const entry of conv.entries) {
              if (existingIds.has(`${entry.type}|${entry.start}|${entry.end}|${entry.title}`)) continue;
              S.data.calendar.entries.push(entry);
              added++;
            }
            S.data.calendar.sources.push(conv.source);
            if (conv.semester && (!S.data.settings.semester.start || !S.data.settings.semester.end)) S.data.settings.semester = { name: conv.semester.name, start: conv.semester.start, end: conv.semester.end };
            U().save();
            A.App.render();
            U().toast(`Calendar snapshot imported: ${added} entries.`, 'ok');
          }
        } catch (err) {
          U().toast(`Could not read that file: ${esc(err.message)}`, 'bad', 8000);
        }
      };
      reader.readAsText(file);
      el.value = '';
    },
    'import-json-confirm': () => {
      const S = U().S;
      if (S.pendingImport) {
        S.data = S.pendingImport;
        S.pendingImport = null;
        U().save();
        U().closeModal();
        A.App.render();
        U().toast('Backup restored.', 'ok');
      }
    },
    'load-sample': () => {
      const S = U().S;
      // Empty semester: there is nothing to lose, so load straight away with no popup.
      // With existing data the confirm dialog stays — one tap must never silently wipe a semester.
      if (!S.data.subjects.length && !S.data.records.length) {
        applySample();
        return;
      }
      U().openModal(
        'Load the sample semester?',
        `<p>This replaces your current data with a demo of 7 subjects, a Mon–Sat timetable, two labs, the scraper's Manipal calendar (holidays, MTE/ETE windows, two swapped "Friday timetable" days) and about two and a half months of marked attendance.</p>
         <div class="row"><button class="primary" data-act="load-sample-confirm" type="button">Load the sample</button><button data-act="modal-close" type="button">Cancel</button></div>`,
      );
    },
    'load-sample-confirm': () => {
      applySample();
    },
    'reset-all': () => {
      U().openModal(
        'Erase everything?',
        `<p>This empties the document in the cloud database: every subject, timetable cell, calendar entry and attendance mark goes. Export a backup first if you might want it back.</p>
         <div class="row"><button class="danger" data-act="reset-all-confirm" type="button">Yes, erase it all</button><button data-act="modal-close" type="button">Cancel</button></div>`,
      );
    },
    'reset-all-confirm': () => {
      const S = U().S;
      S.data = Store.defaults();
      U().save('Erase everything');
      S.calOcr = null;
      U().closeModal();
      A.App.render();
      U().toast('Everything erased. Fresh start.', 'info');
    },
  };

  function onFieldChange(el) {
    if (el.dataset.act === 'period-field') {
      actions['period-field'](el);
      return true;
    }
    return false;
  }

  Object.assign(A.Ui.views, { timetable: renderTimetable, calendar: renderCalendar, data: renderData });
  Object.assign(A.Ui.actions, actions);
  // Live typing: parse and repaint the preview in place, leaving the field and its caret alone.
  Object.assign(A.Ui.inputs, {
    'magic-draft': (el) => {
      magicRun(el.value);
      refreshMagic();
    },
  });
  A.Ui.onPanelFieldChange = onFieldChange;
  A.Ui.handleImageFile = handleImageFile;
})(typeof window !== 'undefined' ? window : globalThis);

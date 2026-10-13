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

    const ocrCard = S.ocr && S.ocr.phase === 'review' ? '' : ocrUploadCard();
    const review = S.ocr && S.ocr.phase === 'review' ? ocrReviewScreen() : '';

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
      </div>
      <div class="card">
        <h3>Bring in a timetable</h3>
        <div class="row">
          <label class="btn" style="cursor:pointer">
            Upload CSV / JSON
            <input type="file" accept=".csv,.json,text/csv,application/json" data-act="csv-import" hidden />
          </label>
          <button data-act="csv-sample" type="button">Download sample CSV</button>
          <button data-act="csv-export" type="button">Export this timetable as CSV</button>
        </div>
        <p class="muted" style="margin-top:8px">CSV columns: <code>day,period,subject_code,subject_name,kind</code>. Unknown subjects are created (3 credits) and every guess is reported back to you.</p>
        ${S.csv && S.csv.warnings && S.csv.warnings.length ? `<div class="banner warn"><strong>Import notes</strong>${S.csv.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
      </div>
      ${review}
      ${ocrCard}`;
  }

  function ocrUploadCard() {
    const S = U().S;
    const o = S.ocr || {};
    const busy = o.phase === 'running' || o.phase === 'prepping';
    const settings = o.settings || {};
    return `<div class="card">
      <h3>Screenshot or photo of your timetable (OCR)</h3>
      <p class="muted">Processed in your browser with Tesseract.js — no image ever leaves your device. First run downloads the OCR engine (~15 MB) once.</p>
      <div class="dropzone" id="ocrDrop">
        <strong>Drop an image here</strong> or
        <div class="row" style="justify-content:center;margin-top:8px">
          <label class="btn" style="cursor:pointer">Choose a file<input type="file" accept="image/*" data-act="ocr-file" hidden /></label>
          <label class="btn" style="cursor:pointer">Take a photo<input type="file" accept="image/*" capture="environment" data-act="ocr-file" hidden /></label>
        </div>
        <p>PNG or JPG. A straight, well-lit screenshot works best; crop it to just the table if the result is noisy.</p>
      </div>
      ${
        o.throughput
          ? `<p class="muted">${esc(o.throughput)}</p>`
          : ''
      }
      <div class="field-row" style="margin-top:10px">
        <label class="field">Contrast
          <select data-act="ocr-setting" data-key="contrast">
            <option value="1" ${settings.contrast ? 'selected' : ''}>boost (default)</option>
            <option value="0" ${!settings.contrast ? 'selected' : ''}>off</option>
          </select>
        </label>
        <label class="field">Colours
          <select data-act="ocr-setting" data-key="invert">
            <option value="0" ${!settings.invert ? 'selected' : ''}>dark text on light</option>
            <option value="1" ${settings.invert ? 'selected' : ''}>light text on dark (photo of a screen)</option>
          </select>
        </label>
        <label class="field">Rotate
          <select data-act="ocr-setting" data-key="rotate">
            <option value="0" ${settings.rotate === 0 ? 'selected' : ''}>0°</option>
            <option value="90" ${settings.rotate === 90 ? 'selected' : ''}>90°</option>
            <option value="180" ${settings.rotate === 180 ? 'selected' : ''}>180°</option>
            <option value="270" ${settings.rotate === 270 ? 'selected' : ''}>270°</option>
          </select>
        </label>
        <label class="field">Page mode
          <select data-act="ocr-setting" data-key="psm">
            <option value="3" ${settings.psm === '3' ? 'selected' : ''}>auto</option>
            <option value="6" ${settings.psm === '6' ? 'selected' : ''}>one block of text</option>
            <option value="11" ${settings.psm === '11' ? 'selected' : ''}>sparse text</option>
          </select>
        </label>
        <label class="field">Language
          <input data-act="ocr-setting" data-key="lang" value="${attr(settings.lang || 'eng')}" size="8" title="eng, or eng+hin etc." />
        </label>
      </div>
      <div class="field-row" style="margin-top:8px">
        <label class="field">Crop left<input data-act="ocr-crop" data-key="0" type="range" min="0" max="40" value="${Math.round((settings.crop ? settings.crop[0] : 0) * 100)}" /></label>
        <label class="field">Crop top<input data-act="ocr-crop" data-key="1" type="range" min="0" max="40" value="${Math.round((settings.crop ? settings.crop[1] : 0) * 100)}" /></label>
        <label class="field">Crop right<input data-act="ocr-crop" data-key="2" type="range" min="0" max="40" value="${Math.round((settings.crop ? settings.crop[2] : 1) * 100)}" /></label>
        <label class="field">Crop bottom<input data-act="ocr-crop" data-key="3" type="range" min="0" max="40" value="${Math.round((settings.crop ? settings.crop[3] : 1) * 100)}" /></label>
      </div>
      ${
        o.original
          ? `<div class="row" style="margin-top:10px">
              <img src="${attr(o.processed || o.original)}" alt="Timetable being processed" style="max-width:220px;border:1px solid var(--line);border-radius:8px" />
              <div class="stack-tight">
                <button class="primary" data-act="ocr-run" type="button" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Run OCR'}</button>
                <button data-act="ocr-repreview" type="button" ${busy ? 'disabled' : ''}>Apply preprocessing only</button>
                <button class="ghost" data-act="ocr-clear" type="button">Remove image</button>
              </div>
            </div>`
          : ''
      }
      ${
        busy
          ? `<div class="progress-track"><div class="progress-fill" id="ocrProgress" style="width:${Math.round((o.progress || 0) * 100)}%"></div></div>
             <p class="muted" id="ocrStatus">${esc(o.statusText || 'starting…')}</p>`
          : ''
      }
      ${
        o.error
          ? `<div class="banner bad"><strong>OCR did not work on that image</strong>${esc(o.error)} You can still fill the timetable in by hand above — the image stays on this screen as a reference.</div>`
          : ''
      }
      ${
        o.original && o.error
          ? `<div class="review-layout" style="margin-top:10px"><div class="review-image"><img src="${attr(o.original)}" alt="Reference timetable" /></div><div class="empty">Type the slots into the grid above while looking at this image, or try again with cropping / higher contrast.</div></div>`
          : ''
      }
      ${
        (S.data.ocr.images || []).length
          ? `<hr /><h4>Saved timetable images (kept in this browser)</h4><div class="thumb-strip">
              ${S.data.ocr.images
                .map(
                  (img) => `<figure style="margin:0">
                    <img class="thumb" src="${attr(img.dataUrl)}" alt="${attr(img.name)}" data-act="ocr-view" data-id="${attr(img.id)}" />
                    <figcaption class="muted" style="font-size:.72rem">${esc(img.name)}<br /><button class="small ghost" data-act="ocr-del" data-id="${attr(img.id)}" type="button">delete</button></figcaption>
                  </figure>`,
                )
                .join('')}
            </div>`
          : ''
      }
    </div>`;
  }

  function ocrReviewScreen() {
    const S = U().S;
    const o = S.ocr;
    const counts = { matched: 0, low: 0, unmatched: 0 };
    o.rows.forEach((r) => (counts[r.state] = (counts[r.state] || 0) + 1));
    const options = (selected) =>
      `<option value="">— skip this cell —</option>` +
      S.data.subjects.map((s) => `<option value="${attr(s.id)}" ${s.id === selected ? 'selected' : ''}>${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`).join('') +
      `<option value="__create__" ${selected === '__create__' ? 'selected' : ''}>＋ create a new subject from this text…</option>`;
    return `<div class="card">
      <div class="section-head">
        <h2>Review &amp; fix before saving</h2>
        <span class="spacer"></span>
        <span class="chips">
          <span class="chip ok">${counts.matched || 0} matched</span>
          <span class="chip warn">${counts.low || 0} unsure</span>
          <span class="chip bad">${counts.unmatched || 0} unmatched</span>
        </span>
      </div>
      <p class="muted">Nothing is saved until you press Confirm. Yellow rows were a rough match, red rows were not recognised — pick a subject for them, or skip the cell.</p>
      <div class="review-layout">
        <div class="review-image">
          <img src="${attr(o.processed || o.original)}" alt="Timetable image used for OCR" />
          <p class="muted" style="margin:6px 0 0">${esc(o.meta || '')}</p>
        </div>
        <div>
          <div class="table-scroll">
            <table class="review-table">
              <thead><tr><th>Slot</th><th>Text found</th><th>Subject</th><th>Lab</th></tr></thead>
              <tbody>
                ${o.rows
                  .map(
                    (r, i) => `<tr data-row="${i}">
                    <td class="nowrap">${esc(Calc.DAY_NAMES[r.day - 1])}<br /><small class="muted">${esc(r.time)}</small></td>
                    <td class="state-${attr(r.state)}"><span class="ocr-text">${esc(r.text || '(nothing)')}</span><small class="muted">${Math.round(r.confidence || 0)}% img-confidence${r.match && r.match.reason ? ` · ${esc(r.match.reason)}` : ''}</small></td>
                    <td><select data-act="ocr-row-subject" data-row="${i}">${options(r.subjectId || (r.match && r.match.matched ? r.match.subjectId : ''))}</select></td>
                    <td><input type="checkbox" data-act="ocr-row-lab" data-row="${i}" ${r.lab ? 'checked' : ''} aria-label="Lab" /></td>
                  </tr>`,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="primary" data-act="ocr-confirm" type="button">Confirm and save timetable</button>
            <button data-act="ocr-cancel" type="button">Cancel</button>
            <button data-act="ocr-repreview" type="button">Re-run with different settings</button>
          </div>
        </div>
      </div>
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
  /** The built-in target: no account, no token — a space and the key that proves this device belongs to it. */
  function cloudSettings(cloud) {
    return `
      <p class="muted">No account and no token: the first save claims a <b>space</b> in this site's own
      database and keeps its key in this browser. To carry the same semester to a phone or laptop,
      show the space id and key here and paste them there — or paste a pair you were given to join it.</p>
      <div class="row">
        <label class="field" style="flex:1 1 130px">Space <input data-act="sync-space" value="${attr(cloud.space)}" placeholder="claimed on first save" autocomplete="off" spellcheck="false" /></label>
        <label class="field" style="flex:1 1 150px">Key <input type="password" data-act="sync-key" value="" placeholder="${cloud.key ? '••••••• (saved)' : 'paste one to join a space'}" autocomplete="off" spellcheck="false" /></label>
      </div>
      ${cloud.space ? `<button class="small" data-act="sync-copy-key" type="button">Show space id &amp; key</button>` : ''}`;
  }

  function githubSettings(Github, cfg) {
    return `
      <p class="muted">Attendance is a JSON file in a GitHub repository you own, committed one change
      at a time.</p>
      <div class="row">
        <label class="field" style="flex:1 1 130px">Owner <input data-act="sync-owner" value="${attr(cfg.owner)}" placeholder="your-username" autocomplete="off" spellcheck="false" /></label>
        <label class="field" style="flex:1 1 150px">Repository <input data-act="sync-repo" value="${attr(cfg.repo)}" placeholder="Attendance-dashboard" autocomplete="off" spellcheck="false" /></label>
      </div>
      <div class="row">
        <label class="field">Branch <input data-act="sync-branch" value="${attr(cfg.branch)}" autocomplete="off" spellcheck="false" style="width:120px" /></label>
        <label class="field" style="flex:1 1 160px">File path <input data-act="sync-path" value="${attr(cfg.path)}" autocomplete="off" spellcheck="false" /></label>
      </div>
      <label class="field">Personal access token
        <input type="password" data-act="sync-token" value="" placeholder="${Github.hasToken() ? '••••••• (saved)' : 'github_pat_…'}" autocomplete="new-password" spellcheck="false" />
      </label>
      <label class="row" style="gap:6px"><input type="checkbox" data-act="sync-remember" ${cfg.rememberToken ? 'checked' : ''} /> remember the token on this device (unticked, it lasts for this tab only)</label>
      <p class="muted">The token is never committed anywhere. It needs <b>Contents: read and write</b> on this one
      repository: GitHub → Settings → Developer settings → Personal access tokens → <i>Fine-grained tokens</i>.</p>`;
  }

  function renderData() {
    const S = U().S;
    const settings = S.data.settings;
    const bytes = Store.storageBytes(S.data);
    const Github = A.Github;
    const cfg = Github.config();
    const sync = Github.state();
    const lastSync = sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'never';
    const cloudMode = Github.mode() === 'cloud';
    const cloud = Github.cloudInfo();
    return `
      <div class="grid cols-2">
        <div class="card">
          <h2>Where your data lives</h2>
          <p class="muted">Attendance is never kept in this browser. Every tap pulls the document, applies
          the change and writes it back, so another device sees your marks straight away and the history
          is your undo. Two targets: this site's own database (no setup) or a JSON file in a GitHub
          repository you own.</p>
          <div class="row" style="margin:8px 0;gap:18px">
            <label class="row" style="gap:6px"><input type="radio" name="syncMode" value="cloud" data-act="sync-mode" ${cloudMode ? 'checked' : ''} /> this site's database</label>
            <label class="row" style="gap:6px"><input type="radio" name="syncMode" value="github" data-act="sync-mode" ${cloudMode ? '' : 'checked'} /> a GitHub repository</label>
          </div>
          <hr />
          ${cloudMode ? cloudSettings(cloud) : githubSettings(Github, cfg)}
          <div class="row" style="margin-top:8px">
            <button class="primary" data-act="sync-save" type="button">Save &amp; test</button>
            <button data-act="sync-pull" type="button">Pull now</button>
            <button data-act="sync-push" type="button">Push now</button>
            <button data-act="sync-disconnect" type="button">Disconnect</button>
          </div>
          <p class="muted">Status: <b>${esc(sync.status)}</b> · last save: ${esc(lastSync)} · ${esc(Github.describe())}</p>
          ${sync.error ? `<p class="chip bad">${esc(sync.error.message)}</p>` : ''}
          ${cloudMode
            ? `<p class="muted">Every read and write carries the key, so a space is readable and writable only by
               devices that hold it — the server keeps a hash of the key, never the key itself.</p>`
            : `<p class="muted">Uploaded timetable screenshots are the only bulky field, so they ride in
               <code>${esc(Github.imagesPath())}</code> and are only written when they actually change.</p>
               <div class="banner warn" style="margin-top:10px"><b>Public repository?</b> Then your attendance file is
               public too, and anyone can read it — commit history included. Keep the data in a private
               repository (it can be a different one from the code) if that matters.</div>`}
        </div>
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
          <p class="muted">Document size: ${(bytes / 1024).toFixed(1)} KB — ${cloudMode
            ? 'saved to this site\u2019s database'
            : `committed to <code>${esc(cfg.path)}</code>${cfg.owner && cfg.repo ? ` in ${esc(cfg.owner)}/${esc(cfg.repo)}` : ''}`}.
          Screenshots add about ${(Math.max(0, bytes - JSON.stringify(Object.assign({}, S.data, { ocr: { images: [] } })).length) / 1024).toFixed(0)} KB on top.</p>
          ${S.data.ocr.images.length ? `<button class="small" data-act="clear-images" type="button" style="margin-top:8px">Delete ${S.data.ocr.images.length} stored OCR image(s)</button>` : ''}
        </div>
        <div class="card">
          <h2>How to use it</h2>
          <ol class="muted" style="padding-left:18px">
            <li><b>Subjects</b> — add each subject with credits, and if you are joining mid-semester enter the attendance you already have (attended / held) under <b>Existing attendance</b>.</li>
            <li><b>Timetable</b> — click cells to fill the week, or import CSV / run OCR on a screenshot. Mark a lab; it spans two periods but counts once.</li>
            <li><b>Calendar</b> — import the scraped Manipal calendar (or CSV/ICS/OCR) so holidays, exams and swapped days are skipped automatically. Set your semester dates.</li>
            <li><b>Today</b> — tap Present / Absent / Leave / Cancelled per class. Cancelled and off days vanish from every count.</li>
            <li><b>Dashboard</b> — watch the safety buffer, the 75% marker and the heatmap; use <b>Tools</b> for what-ifs and "can I skip tomorrow?".</li>
            <li><b>Export</b> a JSON backup now and then — it is the same file that lives in your repository, handy for moving to a different repo or for a manual restore.</li>
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
    try {
      const dataUrl = await Ocr.readAsDataURL(file);
      const base = { grayscale: true, contrast: true, upscale: true, invert: false, rotate: 0, crop: [0, 0, 1, 1], psm: '3', lang: 'eng' };
      if (which === 'timetable') {
        S.ocr = { original: dataUrl, processed: dataUrl, settings: base, phase: 'idle', progress: 0, statusText: '', error: '', rows: [], meta: file.name || 'image' };
        const pre = await Ocr.preprocess(dataUrl, base);
        S.ocr.processed = pre.dataUrl;
        const small = await Ocr.compressForStorage(dataUrl, 900, 0.7);
        S.data.ocr.images.unshift({ id: Store.uid('img'), name: file.name || 'timetable.jpg', dataUrl: small, addedAt: new Date().toISOString() });
        S.data.ocr.images = S.data.ocr.images.slice(0, 2);
        U().save();
        U().toast('Image ready. Check the preview, then run OCR.', 'ok');
      } else {
        S.calOcr = { image: dataUrl, phase: 'idle', progress: 0, statusText: '', error: '', rows: [] };
        const pre = await Ocr.preprocess(dataUrl, Object.assign({}, base, { psm: '6' }));
        S.calOcr.processed = pre.dataUrl;
      }
      A.App.render();
    } catch (err) {
      U().toast(err.message || 'Could not read that image.', 'bad');
    }
  }

  async function runTimetableOcr() {
    const S = U().S;
    const o = S.ocr;
    if (!o || !o.original) return;
    o.phase = 'prepping';
    o.error = '';
    o.progress = 0;
    o.statusText = 'preparing image…';
    A.App.render();
    const tick = () => {
      const fill = document.getElementById('ocrProgress');
      const label = document.getElementById('ocrStatus');
      if (fill) fill.style.width = `${Math.round((o.progress || 0) * 100)}%`;
      if (label) label.textContent = o.statusText || '';
    };
    try {
      const pre = await Ocr.preprocess(o.original, o.settings);
      o.processed = pre.dataUrl;
      o.phase = 'running';
      o.statusText = 'starting OCR engine…';
      A.App.render();
      tick();
      const started = Date.now();
      const res = await Ocr.recognise(pre.dataUrl, {
        lang: o.settings.lang || 'eng',
        psm: o.settings.psm || '3',
        onProgress: (m) => {
          o.progress = m.progress;
          o.statusText = `${m.status}${m.progress ? ` — ${Math.round(m.progress * 100)}%` : ''}`;
          tick();
        },
      });
      const parsed = Ocr.parseTimetable(res.words, S.data.subjects);
      o.meta = `${res.words.length} words recognised in ${((Date.now() - started) / 1000).toFixed(1)}s · orientation: ${parsed.orientation || 'unknown'}`;
      if (!parsed.ok) {
        o.phase = 'idle';
        o.error = parsed.reason;
        U().save();
        A.App.render();
        U().toast('OCR could not find a table in that image — the image stays on screen so you can fill the grid by hand.', 'warn', 8000);
        return;
      }
      o.rows = parsed.rows;
      o.phase = 'review';
      o.progress = 1;
      A.App.render();
      U().toast(`OCR finished: ${o.rows.length} cells found. Review them before saving.`, 'ok');
    } catch (err) {
      o.phase = 'idle';
      o.error = err.message || 'OCR failed.';
      A.App.render();
      U().toast('OCR failed — see the message in the Timetable tab; nothing was saved.', 'bad', 8000);
    }
  }

  async function rePreview() {
    const S = U().S;
    const o = S.ocr;
    if (!o || !o.original) return;
    try {
      const pre = await Ocr.preprocess(o.original, o.settings);
      o.processed = pre.dataUrl;
      o.phase = o.rows && o.rows.length ? o.phase : 'idle';
      A.App.render();
      U().toast('Preprocessing applied. Run OCR again when it looks clean.', 'info');
    } catch (err) {
      U().toast(err.message, 'bad');
    }
  }

  function confirmTimetableOcr() {
    const S = U().S;
    const o = S.ocr;
    const periods = S.data.settings.periods;
    const created = [];
    const warnings = [];
    let applied = 0;
    o.rows.forEach((row) => {
      if (!row.subjectId) return;
      const start = (row.time || '').slice(0, 5);
      let period = periods.find((p2) => p2.start === start);
      if (!period) {
        const m = String(row.time || '').match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
        period = { id: Store.uid('p'), label: `P${periods.length + 1}`, start: start, end: m ? `${m[3]}:${m[4]}` : '' };
        periods.push(period);
        created.push(`${period.label} ${period.start}${period.end ? `–${period.end}` : ''}`);
      }
      const day = String(row.day);
      if (!S.data.timetable[day]) S.data.timetable[day] = {};
      S.data.timetable[day][period.id] = { subjectId: row.subjectId, lab: !!row.lab };
      applied++;
      if (row.lab) {
        const ordered = periods.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)));
        const next = ordered[ordered.indexOf(period) + 1];
        if (next && S.data.timetable[day][next.id]) {
          delete S.data.timetable[day][next.id];
          warnings.push(`${Calc.DAY_NAMES[row.day - 1]} ${period.label}: the period after the lab was cleared because a lab occupies two periods.`);
        }
      }
    });
    if (created.length) warnings.push(`New periods created: ${created.join(', ')}. Rename them in "Edit periods" if needed.`);
    U().save();
    S.ocr = null;
    A.App.render();
    U().toast(`Timetable saved from OCR: ${applied} slot${applied === 1 ? '' : 's'} applied.`, 'ok', 6000);
    if (warnings.length) U().toast(warnings.map((w) => `<div>${esc(w)}</div>`).join(''), 'warn', 9000);
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
    'csv-import': (el) => {
      const file = el.files && el.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const S = U().S;
        try {
          const text = String(reader.result);
          if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) {
            const payload = JSON.parse(text);
            const cells = payload.cells || payload.timetable || [];
            let applied = 0;
            for (const c of cells) {
              const day = Store.dayNumber(c.day);
              const per = c.period ? S.data.settings.periods.find((p2) => p2.label === c.period || p2.id === c.period) : S.data.settings.periods.find((p2) => p2.start === c.start);
              if (!day || !per || !c.subjectId) continue;
              if (!S.data.timetable[String(day)]) S.data.timetable[String(day)] = {};
              S.data.timetable[String(day)][per.id] = { subjectId: c.subjectId, lab: !!c.lab };
              applied++;
            }
            U().save();
            A.App.render();
            U().toast(`Imported ${applied} slots from JSON.`, 'ok');
            return;
          }
          const res = Store.timetableFromCSV(text, S.data);
          for (const cell of res.cells) {
            if (!S.data.timetable[String(cell.day)]) S.data.timetable[String(cell.day)] = {};
            S.data.timetable[String(cell.day)][cell.periodId] = { subjectId: cell.subjectId, lab: cell.lab };
          }
          S.csv = { warnings: res.warnings };
          U().save();
          A.App.render();
          U().toast(`Timetable imported: ${res.cells.length} slots${res.warnings.length ? `, ${res.warnings.length} note(s) to check` : ''}.`, res.warnings.length ? 'warn' : 'ok', 7000);
        } catch (err) {
          U().toast(`Import failed: ${esc(err.message)}`, 'bad', 8000);
        }
      };
      reader.readAsText(file);
      el.value = '';
    },
    'csv-sample': () => download('timetable-sample.csv', Store.SAMPLE_TIMETABLE_CSV, 'text/csv'),
    'csv-export': () => download('timetable.csv', Store.timetableToCSV(U().S.data), 'text/csv'),
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

    /* OCR */
    'ocr-file': (el) => {
      const file = el.files && el.files[0];
      if (file) handleImageFile(file, 'timetable');
      el.value = '';
    },
    'ocr-setting': (el) => {
      const S = U().S;
      if (!S.ocr) return;
      const key = el.dataset.key;
      S.ocr.settings = S.ocr.settings || {};
      S.ocr.settings[key] = el.value === '1' ? true : el.value === '0' ? false : isNaN(Number(el.value)) ? el.value : Number(el.value);
      S.ocr.error = '';
    },
    'ocr-crop': (el) => {
      const S = U().S;
      if (!S.ocr) return;
      const key = Number(el.dataset.key);
      S.ocr.settings = S.ocr.settings || {};
      const crop = (S.ocr.settings.crop || [0, 0, 1, 1]).slice();
      const v = Number(el.value) / 100;
      if (key === 0) crop[0] = v;
      if (key === 1) crop[1] = v;
      if (key === 2) crop[2] = v;
      if (key === 3) crop[3] = v;
      if (crop[0] >= crop[2] - 0.05) crop[2] = Math.min(1, crop[0] + 0.05);
      if (crop[1] >= crop[3] - 0.05) crop[3] = Math.min(1, crop[1] + 0.05);
      S.ocr.settings.crop = crop;
    },
    'ocr-run': () => runTimetableOcr(),
    'ocr-repreview': () => rePreview(),
    'ocr-clear': () => {
      U().S.ocr = null;
      A.App.render();
    },
    'ocr-cancel': () => {
      U().S.ocr = null;
      A.App.render();
      U().toast('OCR result discarded — the timetable was not changed.', 'info');
    },
    'ocr-confirm': () => confirmTimetableOcr(),
    'ocr-row-subject': (el) => {
      const S = U().S;
      const row = S.ocr.rows[Number(el.dataset.row)];
      if (!row) return;
      if (el.value === '__create__') {
        const name = row.text || 'Imported subject';
        const created = { id: Store.uid('sub'), name: name, code: '', credits: 3, faculty: '', color: '', classesPerWeek: null, expectedClasses: null, carried: { a: 0, t: 0 } };
        S.data.subjects.push(created);
        row.subjectId = created.id;
        U().save();
        A.App.render();
        U().toast(`Created subject “${esc(name)}” with 3 credits — edit it in Subjects.`, 'ok', 7000);
        return;
      }
      row.subjectId = el.value || null;
      row.state = el.value ? 'matched' : 'unmatched';
    },
    'ocr-row-lab': (el) => {
      const S = U().S;
      const row = S.ocr.rows[Number(el.dataset.row)];
      if (row) row.lab = el.checked;
    },
    'ocr-view': (el) => {
      const S = U().S;
      const img = S.data.ocr.images.find((i2) => i2.id === el.dataset.id);
      if (img) U().openModal(img.name || 'Timetable image', `<img src="${attr(img.dataUrl)}" alt="${attr(img.name)}" style="width:100%" />`);
    },
    'ocr-del': (el) => {
      const S = U().S;
      S.data.ocr.images = S.data.ocr.images.filter((i2) => i2.id !== el.dataset.id);
      U().save();
      A.App.render();
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
      U().openModal(
        'Load the sample semester?',
        `<p>This replaces your current data with a demo of 7 subjects, a Mon–Sat timetable, two labs, the scraper's Manipal calendar (holidays, MTE/ETE windows, two swapped "Friday timetable" days) and about two and a half months of marked attendance.</p>
         <div class="row"><button class="primary" data-act="load-sample-confirm" type="button">Load the sample</button><button data-act="modal-close" type="button">Cancel</button></div>`,
      );
    },
    'load-sample-confirm': () => {
      const S = U().S;
      S.data = A.Sample.build(U().todayISO());
      U().save('Load the sample semester');
      S.view = 'today';
      S.date = U().todayISO();
      U().closeModal();
      A.App.render();
      U().toast('Sample semester loaded — start on the Today tab.', 'ok', 6000);
    },
    'reset-all': () => {
      U().openModal(
        'Erase everything?',
        `<p>This empties the document in your repository: every subject, timetable cell, calendar entry and attendance mark goes. The commits before it still hold the old version, so it is recoverable from GitHub's history — but export a backup first if you would rather not go digging there.</p>
         <div class="row"><button class="danger" data-act="reset-all-confirm" type="button">Yes, erase it all</button><button data-act="modal-close" type="button">Cancel</button></div>`,
      );
    },
    'reset-all-confirm': () => {
      const S = U().S;
      S.data = Store.defaults();
      U().save('Erase everything');
      S.ocr = null;
      S.calOcr = null;
      U().closeModal();
      A.App.render();
      U().toast('Everything erased. Fresh start.', 'info');
    },
    'clear-images': () => {
      U().S.data.ocr.images = [];
      U().save('Delete stored timetable images');
      A.App.render();
      U().toast('Stored OCR images deleted.', 'info');
    },
  };

  /* ---------- Settings → Sync ---------- */
  /** Reads the whole sync form at once, so a half-filled form never overwrites a good setting. */
  function syncForm() {
    const val = (act) => {
      const el = document.querySelector(`[data-act="${act}"]`);
      return el ? el.value : '';
    };
    const tokenField = document.querySelector('[data-act="sync-token"]');
    const remember = document.querySelector('[data-act="sync-remember"]');
    return {
      owner: val('sync-owner'),
      repo: val('sync-repo'),
      branch: val('sync-branch'),
      path: val('sync-path'),
      cloudSpace: val('sync-space'),
      cloudKey: val('sync-key'),
      rememberToken: !!(remember && remember.checked),
      // An empty box means "keep the token I already have", not "forget it".
      token: tokenField && tokenField.value ? tokenField.value.trim() : A.Github.hasToken() ? undefined : '',
    };
  }

  Object.assign(actions, {
    'sync-save': async () => {
      const Github = A.Github;
      const form = syncForm();
      const cloudMode = Github.mode() === 'cloud';
      if (cloudMode) {
        // Joining a space needs both halves of the credential; an untouched key box keeps the key
        // this device already holds rather than throwing it away.
        if (form.cloudKey) Github.setCloud(form.cloudSpace || Github.cloudInfo().space, form.cloudKey);
        else if (form.cloudSpace && form.cloudSpace !== Github.cloudInfo().space) {
          U().toast('A new space id needs the key that goes with it — copy both from the other device.', 'bad', 9000);
          return;
        }
      } else {
        const patch = { owner: form.owner, repo: form.repo, branch: form.branch, path: form.path, rememberToken: form.rememberToken };
        if (form.token !== undefined) patch.token = form.token;
        Github.configure(patch);
      }
      if (!Github.isConfigured()) {
        U().toast('Owner, repository and a token are all needed before anything can be saved.', 'bad', 9000);
        return;
      }
      try {
        const probe = await Github.test();
        const S = U().S;
        if (probe.exists) {
          // The target already has a document: pull it, fold in whatever is on screen, commit.
          const pulled = await Github.pull();
          const before = S.data.records.length;
          S.data = Github.merge(pulled.doc ? Store.normalize(pulled.doc.data) : null, S.data);
          await Github.queueSync(S.data, { message: 'Connect this device' });
          U().toast(`Connected. ${probe.records} mark(s) were already in ${Github.describe()}, ${Math.max(0, before)} in this tab — merged.`, 'ok', 9000);
        } else {
          await Github.queueSync(S.data, { message: 'Initial commit from the attendance dashboard' });
          U().toast(`Connected. Saved the first document to ${Github.describe()}.`, 'ok', 9000);
        }
        Store.clearLocal();
        S.readOnly = false;
        A.App.render();
      } catch (err) {
        U().toast(`<b>Could not connect.</b> ${U().esc(err.message)}`, 'bad', 15000);
      }
    },
    'sync-mode': (el) => {
      const mode = el.value === 'github' ? 'github' : 'cloud';
      A.Github.configure({ mode });
      A.App.render();
      U().toast(mode === 'cloud' ? 'Sync target: this site\u2019s database.' : 'Sync target: a GitHub repository.', 'info');
    },
    'sync-copy-key': () => {
      const info = A.Github.cloudInfo();
      if (!info.space) {
        U().toast('Nothing to show yet — the space is claimed on the first save.', 'info', 8000);
        return;
      }
      U().openModal(
        'This device\u2019s space & key',
        `<p class="muted">Enter these under <b>Settings → Sync</b> on the other device (space in the first
         box, key in the second, then <b>Save &amp; test</b>) to carry this semester over. Anyone holding
         both can read and write this attendance — treat the key like a password.</p>
         <textarea readonly rows="3" style="width:100%;font-family:monospace;background:var(--panel-2);color:inherit;border:1px solid var(--line);border-radius:8px;padding:10px">${esc(`space: ${info.space}\nkey:   ${info.key}`)}</textarea>`,
      );
    },
    'sync-pull': async () => {
      const Github = A.Github;
      try {
        const pulled = await Github.pull();
        if (!pulled.doc) {
          U().toast('There is no data file in that repository yet — push once to create it.', 'info', 8000);
          return;
        }
        U().S.data = Store.normalize(pulled.doc.data);
        U().S.readOnly = false;
        A.App.render();
        U().toast(`Pulled ${U().S.data.records.length} mark(s) from ${A.Github.describe()}.`, 'ok');
      } catch (err) {
        U().toast(`<b>Could not pull.</b> ${U().esc(err.message)}`, 'bad', 12000);
      }
    },
    'sync-push': () => {
      const Github = A.Github;
      Github.queueSync(U().S.data, { message: 'Manual push from the attendance dashboard' })
        .then(() => {
          U().S.readOnly = false;
          A.App.render();
          U().toast('Pushed.', 'ok');
        })
        .catch((err) => U().toast(`<b>Could not push.</b> ${U().esc(err.message)}`, 'bad', 12000));
    },
    'sync-disconnect': () => {        U().openModal(
          'Stop syncing?',
          A.Github.mode() === 'cloud'
            ? `<p>This device switches back to the GitHub form and stops saving anything. Your space and
               its key stay here, and the document stays in the database — switch the mode back to
               <b>this site's database</b> any time to pick up where you left off.</p>
               <div class="row"><button class="danger" data-act="sync-disconnect-confirm" type="button">Disconnect</button><button data-act="modal-close" type="button">Cancel</button></div>`
            : `<p>This device will forget the token and stop saving anything. The document stays in your
               repository — nothing is deleted there, and you can reconnect any time.</p>
               <div class="row"><button class="danger" data-act="sync-disconnect-confirm" type="button">Disconnect</button><button data-act="modal-close" type="button">Cancel</button></div>`,
        );
    },
    'sync-disconnect-confirm': () => {
      A.Github.disconnect();
      U().S.readOnly = true;
      U().closeModal();
      A.App.render();
      U().toast('Disconnected. Nothing is saved while unconnected.', 'info', 8000);
    },
    'sync-remember': (el) => {
      // Only the credential flag changes here — the token value itself is left alone.
      A.Github.setRemember(el.checked);
      U().toast(el.checked ? 'The token will be remembered on this device.' : 'The token is kept for this tab only.', 'info');
    },
  });

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

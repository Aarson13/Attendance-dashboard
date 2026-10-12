/* ui.js — state, helpers and the Today / Dashboard / Subjects / Tools views.
 *
 * Rendering model: an action mutates S.data, saves, then re-renders the current view. Views are
 * plain functions of the data, so every number shown comes from AD.Calc — there is exactly one
 * place where attendance is computed. Timetable, Calendar and Settings live in panels.js.
 */
(function (global) {
  'use strict';
  const A = global.AD;
  const Calc = A.Calc;
  const Store = A.Store;
  const Charts = A.Charts;

  const S = {
    data: null,
    view: 'today',
    date: null,
    month: null,
    sim: null,
    plan: null,
    ocr: null,
    calOcr: null,
    hooks: [],
  };

  const todayISO = () => new Date().toLocaleDateString('en-CA');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (v) => esc(v);
  const pctText = (v, d) => (v == null || !isFinite(v) ? 'N/A' : `${(v * 100).toFixed(d == null ? 1 : d)}%`);

  /**
   * The "what happens over the rest of the term" sentence. With nothing left to project the two
   * projections collapse to the same number, which reads like a bug, so say why instead.
   */
  const projectionNote = (st) => {
    if (st.remaining > 0) return `If you miss all ${st.remaining} classes left this semester: ${pctText(st.projectedWorst)}. If you attend them all: ${pctText(st.projectedBest)}.`;
    if (st.TAdjusted) return `Nothing left to project: the semester plan (${st.TPlanned} classes) is already smaller than the ${st.t} classes held so far. Extend the semester dates or set Total T to forecast the rest of the term.`;
    return `Nothing left to project — every one of the ${st.t} planned classes is counted, so the rest of the term just holds your current ${pctText(st.pct)}.`;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function ctx() {
    const sem = S.data.settings.semester;
    return { data: S.data, index: Calc.calendarIndex(S.data.calendar.entries, sem.start, sem.end) };
  }
  const subjById = (id) => S.data.subjects.find((s) => s.id === id) || null;
  const periodById = (id) => S.data.settings.periods.find((p) => p.id === id) || null;
  function periodTime(id) {
    const p = periodById(id);
    if (!p) return '';
    return p.end ? `${p.start}–${p.end}` : p.start;
  }
  const p = () => S.data.settings.threshold;
  function statusClass(stats) {
    if (!stats || stats.t === 0) return 'none';
    if (stats.pct < p() || stats.buffer === 0) return 'bad';
    return stats.buffer <= 3 ? 'warn' : 'ok';
  }
  const subjectTag = (s) => (s ? (s.code ? `${s.code} · ${s.name}` : s.name) : 'deleted subject');

  function after(fn) {
    S.hooks.push(fn);
  }

  function save() {
    const res = Store.save(S.data);
    if (res.warning) toast(res.warning, 'warn', 7000);
    if (!res.ok) toast(`Could not save to this browser: ${res.error}`, 'bad', 9000);
  }

  function toast(msg, kind, ms) {
    const host = $('#toastStack');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.innerHTML = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, ms || 4200);
  }

  function openModal(title, bodyHtml, onMount) {
    const host = $('#modalHost');
    host.hidden = false;
    host.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${attr(title)}">
        <div class="section-head"><h3>${esc(title)}</h3><span class="spacer"></span><button class="ghost" data-act="modal-close" type="button">Close</button></div>
        <div class="modal-body">${bodyHtml}</div>
      </div>`;
    host.onclick = (e) => {
      if (e.target === host) closeModal();
    };
    if (onMount) onMount(host.querySelector('.modal-body'));
  }
  function closeModal() {
    const host = $('#modalHost');
    host.hidden = true;
    host.innerHTML = '';
  }

  /* ---------- shared fragments ---------- */
  function welcomeBanner() {
    if (S.data.subjects.length || S.data.records.length) return '';
    return `<div class="banner info"><strong>Nothing set up yet</strong>
      Add your subjects in the <b>Subjects</b> tab, then fill the week in <b>Timetable</b> (click any cell) or import a CSV / screenshot.
      Want to look around first? Settings → “Load sample semester” loads a complete demo you can wipe later.</div>`;
  }

  function warningsBanner() {
    const list = Calc.warnings(ctx());
    if (!list.length) return '';
    const worst = list.some((w) => w.severity === 'red') ? 'bad' : 'warn';
    return `<div class="banner ${worst}">
      <strong>${list.length} attendance warning${list.length === 1 ? '' : 's'}</strong>
      ${list.map((w) => `<div>${esc(w.text)}</div>`).join('')}
    </div>`;
  }

  function reminderBanner() {
    const c = ctx();
    const day = Calc.unmarkedDay(c, todayISO(), 7);
    if (!day) return '';
    return `<div class="banner warn">
      <strong>You haven't marked ${Calc.fmtDayName(day.date)} ${Calc.fmtDate(day.date)}</strong>
      <button class="small" data-act="day-goto" data-date="${attr(day.date)}" type="button">Open that day</button>
    </div>`;
  }

  function subjectCard(stats) {
    const s = stats.subject;
    const cls = statusClass(stats);
    const statusText = stats.t === 0 ? 'not marked yet' : stats.pct < p() ? 'below threshold' : stats.buffer === 0 ? 'at the line' : stats.buffer <= 3 ? 'borderline' : 'safe';
    const sources = { timetable: 'from timetable', manual: 'manual T', estimated: 'estimated from credits' };
    return `<article class="card spot subject-card s-${cls}">
      <div class="subject-head">
        <h3>${esc(s.name)}</h3>
        ${s.code ? `<span class="chip">${esc(s.code)}</span>` : ''}
        <span class="pct ${cls}">${pctText(stats.pct)}</span>
      </div>
      <p class="muted" style="margin:0 0 8px">
        ${esc(s.faculty || 'no faculty set')} · ${s.credits} credit${s.credits === 1 ? '' : 's'}
        · <span class="chip ${cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : 'ok'}">${statusText}</span>
      </p>
      <div class="bar"><span class="bar-fill ${cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : 'ok'}" style="width:${stats.pct == null ? 0 : clamp(stats.pct, 0, 1) * 100}%"></span><span class="bar-mark" style="left:${p() * 100}%"></span></div>
      <div class="chips" style="margin-top:9px">
        ${stats.t === 0 ? '<span class="chip">nothing marked yet</span>' : stats.buffer > 0 ? `<span class="chip ok">can miss ${stats.buffer} more</span>` : `<span class="chip bad">no safe misses left</span>`}
        ${stats.mustAttend == null ? `<span class="chip bad">can't return to ${(p() * 100).toFixed(0)}%</span>` : stats.mustAttend > 0 ? `<span class="chip bad">attend ${stats.mustAttend} in a row</span>` : ''}
        <span class="chip">held ${stats.t} · attended ${stats.a}</span>
        <span class="chip${stats.TAdjusted ? ' warn' : ''}">plan T ${stats.T} <span class="muted">(${stats.TAdjusted ? `raised from ${stats.TPlanned}` : esc(sources[stats.TSource] || stats.TSource)})</span></span>
        ${stats.cancelled ? `<span class="chip">${stats.cancelled} cancelled</span>` : ''}
        ${stats.carried.t ? `<span class="chip">existing ${stats.carried.a}/${stats.carried.t} before tracking</span>` : ''}
      </div>
      <dl class="stat-list">
        <div><dt>Misses used / allowed</dt><b>${stats.usedMisses} / ${stats.maxMissTotal}</b></div>
        <div><dt>Left this semester</dt><b>${stats.remaining}</b></div>
        ${stats.remaining > 0 ? `<div><dt>Best case (attend all left)</dt><b>${pctText(stats.projectedBest)}</b></div>
        <div><dt>Worst case (miss all left)</dt><b>${pctText(stats.projectedWorst)}</b></div>` : `<div><dt>Forecast</dt><b><small>nothing left to project</small></b></div>`}
      </dl>
      <div class="row" style="margin-top:10px">
        <button class="small" data-act="whatif-subject" data-id="${attr(s.id)}" type="button">What-if…</button>
        <button class="small" data-act="tab" data-tab="subjects" type="button">Edit subject</button>
      </div>
    </article>`;
  }

  /* ---------- Today ---------- */
  function renderToday() {
    if (!S.date) S.date = todayISO();
    const c = ctx();
    const date = S.date;
    const plan = Calc.dayPlan(date, c);
    const classes = Calc.dayClasses(c, date);
    const stats = Calc.allStats(c);
    const byId = new Map(stats.map((s) => [s.subject.id, s]));
    const isToday = date === todayISO();
    const sem = S.data.settings.semester;
    const outsideSemester = sem.start && sem.end && (date < sem.start || date > sem.end);

    let statusBanner = '';
    if (plan.off) {
      statusBanner = `<div class="banner info"><strong>No classes</strong>${esc(plan.titles.join(', ') || 'Off day')} — holidays, exam days and suspended days are skipped in every calculation.</div>`;
    } else if (plan.swap) {
      statusBanner = `<div class="banner info"><strong>${Calc.DAY_NAMES[plan.swap - 1]} timetable on a ${Calc.DAY_NAMES[plan.actualWeekday - 1]}</strong>${esc(plan.titles.join(', ') || 'Swapped day from your calendar')}</div>`;
    }
    if (outsideSemester) {
      statusBanner += `<div class="banner warn"><strong>Outside your semester window</strong>Semester is ${Calc.fmtDate(sem.start)} → ${Calc.fmtDate(sem.end)}. Change it in Calendar.</div>`;
    }

    const marked = classes.filter((cl) => cl.record).length;
    const rows = classes
      .map((cl) => {
        const s = subjById(cl.subjectId);
        const st = byId.get(cl.subjectId);
        const status = cl.record ? cl.record.status : null;
        const kindLabel = cl.kind === 'lab' ? 'Lab (2 periods, 1 class)' : cl.kind === 'extra' ? 'Extra class' : 'Lecture';
        return `<div class="class-row ${status ? `marked-${status}` : ''}">
        <div class="class-main">
          <strong>${esc(s ? s.name : 'Unknown subject')}</strong>
          <small>${esc(s && s.code ? s.code : '')} · ${esc(kindLabel)}${cl.record && cl.record.note ? ` · ${esc(cl.record.note)}` : ''}</small>
        </div>
        <span class="class-time">${esc(cl.periodId ? periodTime(cl.periodId) : 'unscheduled')}</span>
        <span class="chip ${st ? (statusClass(st) === 'bad' ? 'bad' : statusClass(st) === 'warn' ? 'warn' : 'ok') : ''}">${st ? pctText(st.pct) : 'no data'}</span>
        <span class="push"></span>
        <div class="seg" role="group" aria-label="Mark ${attr(s ? s.name : '')}">
          ${['present', 'absent', 'leave', 'cancelled']
            .map(
              (status2) =>
                `<button type="button" data-status="${status2}" aria-pressed="${status === status2}" data-act="mark" data-subject="${attr(cl.subjectId)}" data-slot="${attr(cl.slotKey || '')}" data-kind="${attr(cl.kind)}" data-date="${attr(date)}" data-mark="${status2}" title="${status2 === 'cancelled' ? 'Cancelled — not counted at all' : status2 === 'leave' ? (S.data.settings.leaveMode === 'exclude' ? 'Medical leave — excluded from the count' : 'Medical leave — counted as absent') : status2}">${status2 === 'cancelled' ? 'Cancelled' : status2 === 'leave' ? 'Leave' : status2[0].toUpperCase() + status2.slice(1)}</button>`,
            )
            .join('')}
        </div>
        ${cl.record ? `<button class="small ghost" data-act="unmark" data-id="${attr(cl.record.id)}" type="button" title="Clear this marking">✕</button>` : ''}
      </div>`;
      })
      .join('');

    const emptyState =
      !classes.length && !plan.off
        ? `<div class="empty">Nothing scheduled for this day. If classes were held anyway, add them as extra classes below.${
            S.data.subjects.length ? '' : ' Or start by adding subjects and a timetable.'
          }</div>`
        : '';

    const subjectOptions = S.data.subjects
      .map((s) => `<option value="${attr(s.id)}">${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`)
      .join('');

    return `
      ${welcomeBanner()}
      ${reminderBanner()}
      ${warningsBanner()}
      ${statusBanner}
      <div class="card">
        <div class="date-nav">
          <button data-act="day-prev" type="button" title="Previous day">◀</button>
          <input type="date" id="dateInput" value="${attr(date)}" data-act="day-set" aria-label="Pick a date" />
          <button data-act="day-next" type="button" title="Next day">▶</button>
          <button data-act="day-today" type="button" class="${isToday ? 'primary' : ''}">Today</button>
          <div class="spacer" style="margin-left:auto"></div>
          <span class="class-time">${esc(Calc.fmtDayName(date))} · ${esc(Calc.fmtDate(date))}</span>
        </div>
        <div class="section-head">
          <h2>${isToday ? "Today's classes" : 'Classes'}</h2>
          <span class="spacer"></span>
          <span class="muted">${classes.length ? `${marked} of ${classes.length} marked` : plan.off ? 'off day' : 'no classes'}</span>
        </div>
        ${rows}
        ${emptyState}
      </div>
      <div class="card">
        <h3>Add an extra class (not in the timetable)</h3>
        <p class="muted">Counts as 1 class held; counts as attended if you mark it present. Useful for make-up classes and extra tutorials.</p>
        <div class="field-row">
          <label class="field">Subject
            <select id="extraSubject">${subjectOptions || '<option value="">add a subject first</option>'}</select>
          </label>
          <label class="field">Kind
            <select id="extraKind"><option value="lecture">Lecture</option><option value="lab">Lab / practical</option></select>
          </label>
          <label class="field">Note (optional)
            <input id="extraNote" type="text" placeholder="makeup class" />
          </label>
          <button data-act="extra-add" data-status="present" type="button">Present</button>
          <button data-act="extra-add" data-status="absent" type="button">Absent</button>
        </div>
      </div>`;
  }

  /* ---------- Dashboard ---------- */
  function renderDashboard() {
    const c = ctx();
    const stats = Calc.allStats(c);
    const sortMode = S.data.settings.sort === 'credits' ? 'credits' : 'risk';
    const sorted = stats.slice().sort((a, b) => {
      if (sortMode === 'credits') return (b.subject.credits || 0) - (a.subject.credits || 0) || a.subject.name.localeCompare(b.subject.name);
      const rank = (s) => (s.t === 0 ? 9 : s.pct < p() ? 0 : s.buffer === 0 ? 1 : s.buffer <= 3 ? 2 : 3);
      return rank(a) - rank(b) || (a.pct == null ? 1 : a.pct) - (b.pct == null ? 1 : b.pct);
    });
    const overall = Calc.overallStats(c, stats);
    const today = todayISO();
    const bunk = Calc.bunkable(c, today, stats);
    const sem = S.data.settings.semester;

    after((root) => {
      Charts.bars($('#chartBars', root), stats.filter((s) => s.t > 0).map((s) => ({ label: s.subject.code || s.subject.name, value: s.pct })), { threshold: p() });
      Charts.line($('#chartLine', root), Calc.trend(c, today), { threshold: p() });
      renderHeatmap(root);
    });

    return `
      ${warningsBanner()}
      <div class="grid cols-3">
        <div class="card spot tile">
          <div class="tile-label">Overall attendance</div>
          <div class="tile-value" data-countup="${overall.pct == null ? '' : (overall.pct * 100).toFixed(1)}" data-decimals="1" data-suffix="%">${pctText(overall.pct)}</div>
          <div class="tile-note">${overall.a} attended of ${overall.t} held${overall.pct == null ? ' · mark a class to start' : ''}</div>
        </div>
        <div class="card spot tile">
          <div class="tile-label">Credit-weighted</div>
          <div class="tile-value" data-countup="${overall.creditPct == null ? '' : (overall.creditPct * 100).toFixed(1)}" data-decimals="1" data-suffix="%">${pctText(overall.creditPct)}</div>
          <div class="tile-note">heavier subjects count more</div>
        </div>
        <div class="card spot tile">
          <div class="tile-label">Subjects at risk</div>
          <div class="tile-value ${overall.atRisk ? 'pct bad' : 'pct ok'}" data-countup="${overall.atRisk}" data-decimals="0">${overall.atRisk}</div>
          <div class="tile-note">${overall.below} already below ${(p() * 100).toFixed(0)}%</div>
        </div>
        <div class="card spot tile">
          <div class="tile-label">You can bunk today</div>
          <div class="tile-value" data-countup="${bunk.safeCount}" data-decimals="0">${bunk.safeCount}</div>
          <div class="tile-note">${
            bunk.total ? `of ${bunk.total} classes left to mark` : 'nothing to mark today'
          }</div>
        </div>
      </div>
      ${
        sem.start && sem.end
          ? `<p class="muted">Semester: ${esc(sem.name || 'unnamed')} · ${Calc.fmtDate(sem.start)} → ${Calc.fmtDate(sem.end)} · ${Calc.countTeachingDays(c)} teaching days</p>`
          : `<div class="banner warn"><strong>Set your semester dates</strong>Open Calendar and fill in the semester start and end so T and projections mean something.</div>`
      }
      <div class="card">
        <div class="section-head">
          <h2>Subjects</h2>
          <span class="spacer"></span>
          <label class="field" style="min-width:auto">Sort
            <select data-act="sort-set">
              <option value="risk" ${sortMode === 'risk' ? 'selected' : ''}>most at risk first</option>
              <option value="credits" ${sortMode === 'credits' ? 'selected' : ''}>by credits</option>
            </select>
          </label>
        </div>
        ${sorted.length ? sorted.map(subjectCard).join('') : '<div class="empty">No subjects yet — add them in the Subjects tab, or load the sample data in Settings.</div>'}
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Attendance per subject</h3><div id="chartBars"></div></div>
        <div class="card"><h3>Trend over the semester</h3><div id="chartLine"></div></div>
      </div>
      <div class="card">
        <div class="section-head">
          <h3>Monthly heatmap</h3>
          <span class="spacer"></span>
          <button class="small" data-act="month-prev" type="button">◀</button>
          <span class="muted" id="monthLabel">${esc(S.month)}</span>
          <button class="small" data-act="month-next" type="button">▶</button>
        </div>
        <div id="heatmap"></div>
      </div>`;
  }

  function renderHeatmap(root) {
    const month = S.month || todayISO().slice(0, 7);
    S.month = month;
    const label = $('#monthLabel', root);
    if (label) label.textContent = month;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const c = ctx();
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const summary = Calc.daySummary(c, date, todayISO());
      const label2 =
        summary.kind === 'off'
          ? `off: ${summary.plan.titles.join(', ') || 'holiday'}`
          : summary.kind === 'present'
            ? `${summary.present} present`
            : summary.kind === 'absent'
              ? `${summary.absent} absent${summary.present ? `, ${summary.present} present` : ''}`
              : summary.kind === 'cancelled'
                ? 'all cancelled'
                : summary.kind === 'unmarked'
                  ? `${summary.scheduled} classes, not marked`
                  : summary.recs.length
                    ? `${summary.recs.length} marked`
                    : 'no classes';
      days.push({ date, kind: summary.kind, title: label2 });
    }
    Charts.heatmap($('#heatmap', root), {
      month,
      days,
      today: todayISO(),
      onPick: (date) => {
        S.date = date;
        go('today');
      },
    });
  }

  /* ---------- Subjects ---------- */
  function renderSubjects() {
    const c = ctx();
    const stats = Calc.allStats(c);
    const byId = new Map(stats.map((s) => [s.subject.id, s]));
    const carriedRows = S.data.subjects
      .map((s) => {
        const raw = s.carried || { a: 0, t: 0 };
        const c2 = Calc.carriedOf(s);
        const impossible = Number(raw.a) > Number(raw.t);
        const st = byId.get(s.id);
        const cls = st ? statusClass(st) : 'none';
        return `<tr data-id="${attr(s.id)}">
          <td>${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</td>
          <td><input data-act="carried-field" data-field="a" type="number" min="0" step="1" value="${attr(raw.a == null ? 0 : raw.a)}" style="width:84px" aria-label="Classes attended before tracking" /></td>
          <td><input data-act="carried-field" data-field="t" type="number" min="0" step="1" value="${attr(raw.t == null ? 0 : raw.t)}" style="width:84px" aria-label="Classes held before tracking" /></td>
          <td class="nowrap"><span class="chip ${cls === 'bad' ? 'bad' : cls === 'warn' ? 'warn' : cls === 'ok' ? 'ok' : ''}">${pctText(st ? st.pct : null)}</span> ${impossible ? '<small class="muted">attended can&rsquo;t exceed held</small>' : ''}</td>
          <td>${c2.t || c2.a ? `<button class="small ghost" data-act="carried-clear" data-id="${attr(s.id)}" type="button">Clear</button>` : ''}</td>
        </tr>`;
      })
      .join('');
    const rows = S.data.subjects
      .map((s) => {
        const st = byId.get(s.id);
        const usage = Store.subjectUsage(S.data, s.id);
        return `<tr data-id="${attr(s.id)}">
        <td><input data-act="subj-field" data-field="name" value="${attr(s.name)}" aria-label="Subject name" /></td>
        <td><input data-act="subj-field" data-field="code" value="${attr(s.code)}" size="8" aria-label="Subject code" /></td>
        <td><input data-act="subj-field" data-field="credits" value="${attr(s.credits)}" type="number" min="0" step="0.5" style="width:76px" aria-label="Credits" /></td>
        <td><input data-act="subj-field" data-field="faculty" value="${attr(s.faculty)}" aria-label="Faculty" /></td>
        <td><input data-act="subj-field" data-field="classesPerWeek" value="${attr(s.classesPerWeek == null ? '' : s.classesPerWeek)}" type="number" min="0" step="1" placeholder="=${attr(s.credits)}" style="width:74px" aria-label="Classes per week" /></td>
        <td><input data-act="subj-field" data-field="expectedClasses" value="${attr(s.expectedClasses == null ? '' : s.expectedClasses)}" type="number" min="0" step="1" placeholder="auto" style="width:82px" aria-label="Total classes expected this semester" /></td>
        <td class="nowrap">${st ? `<span class="chip ${statusClass(st) === 'bad' ? 'bad' : statusClass(st) === 'warn' ? 'warn' : 'ok'}">${pctText(st.pct)}</span> <small>${st.a}/${st.t}</small>` : '<small class="muted">no data</small>'}</td>
        <td class="nowrap"><small class="muted">${usage.cells} slots · ${usage.records} marks</small></td>
        <td><button class="small danger" data-act="subj-delete" data-id="${attr(s.id)}" type="button">Delete</button></td>
      </tr>`;
      })
      .join('');

    return `
      <div class="card">
        <div class="section-head">
          <h2>Subjects</h2>
          <span class="spacer"></span>
          <span class="muted">${S.data.subjects.length} subject${S.data.subjects.length === 1 ? '' : 's'}</span>
        </div>
        <p class="muted">Classes per week defaults to the credit count (3 credits = 3 classes a week) until you build a timetable. "Expected classes" (T) overrides the auto-calculated semester total for that subject.</p>
        <div class="table-scroll">
          <table class="list" style="min-width:900px">
            <thead><tr>
              <th>Name</th><th>Code</th><th>Credits</th><th>Faculty</th><th>Per week</th><th>Total T</th><th>Now</th><th>Usage</th><th></th>
            </tr></thead>
            <tbody>${rows || ''}</tbody>
          </table>
        </div>
        ${S.data.subjects.length ? '' : '<div class="empty">No subjects yet. Add the first one below, or load the sample semester from Settings.</div>'}
        <hr />
        <h3>Add a subject</h3>
        <div class="field-row">
          <label class="field">Name<input id="newSubjName" placeholder="Operating Systems" /></label>
          <label class="field">Code<input id="newSubjCode" placeholder="CS3002" size="8" /></label>
          <label class="field">Credits<input id="newSubjCredits" type="number" min="0" step="0.5" value="3" style="width:80px" /></label>
          <label class="field">Faculty (optional)<input id="newSubjFaculty" placeholder="Dr. Iyer" /></label>
          <button class="primary" data-act="subj-add" type="button">Add subject</button>
        </div>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Existing attendance</h2>
          <span class="spacer"></span>
          <span class="muted">classes held before you started marking</span>
        </div>
        <p class="muted">Your college portal already knows how many classes have been held and how many you attended for each subject. Type those two numbers here and they join <b>every</b> calculation — the percentage, safe misses, recovery, projections, overall and credit-weighted. Leave them at 0 if you are starting fresh.
        Only count classes you have <b>not</b> already marked in the Today tab: marked days are added on top. Keep the semester dates as the real ones so the semester plan (T) covers the whole term.</p>
        ${S.data.subjects.length ? `<div class="table-scroll">
          <table class="list" style="min-width:560px">
            <thead><tr><th>Subject</th><th>Attended</th><th>Held</th><th>% now</th><th></th></tr></thead>
            <tbody>${carriedRows}</tbody>
          </table>
        </div>
        <p class="muted">Overall: ${pctText(Calc.overallStats(c, stats).pct)} across ${S.data.subjects.length} subjects, including everything marked since.</p>` : '<div class="empty">Add a subject first, then you can enter the attendance you already have.</div>'}
      </div>`;
  }

  /* ---------- Tools: what-if + skip planner ---------- */
  function renderTools() {
    const c = ctx();
    const stats = Calc.allStats(c);
    const subjects = S.data.subjects;
    const simSubject = S.sim && S.sim.subjectId ? S.sim.subjectId : subjects.length ? subjects[0].id : '';
    const pick = simSubject ? stats.find((s) => s.subject.id === simSubject) : null;
    // Reached from a subject card's "What-if…" button, S.sim carries a subject but no miss count yet.
    const misses = S.sim && isFinite(S.sim.misses) && S.sim.misses >= 0 ? S.sim.misses : 3;
    let simOut = '<div class="empty">Pick a subject and a number of classes you plan to miss.</div>';
    if (pick) {
      const eff = Calc.missEffect(pick, misses, p());
      const breakpointNow = pick.buffer == null ? 0 : pick.buffer; // same formula as the dashboard's buffer
      simOut = `<dl class="stat-list">
          <div><dt>Now</dt><b>${pctText(pick.pct)} (${pick.a}/${pick.t})</b></div>
          <div><dt>After missing ${misses} more</dt><b class="${eff.safe ? 'pct ok' : 'pct bad'}">${pctText(eff.pct)} (${pick.a}/${pick.t + misses})</b></div>
          <div><dt>Still ≥ ${(p() * 100).toFixed(0)}%?</dt><b>${eff.safe ? `yes — ${eff.buffer} more could go` : 'no, this drops you below'}</b></div>
          <div><dt>Break-even right now</dt><b>${breakpointNow} more miss${breakpointNow === 1 ? '' : 'es'} allowed</b></div>
        </dl>
        <p class="muted">${projectionNote(pick)}</p>`;
    }

    const planDate = (S.plan && S.plan.date) || Calc.addDays(todayISO(), 1);
    const planClasses = Calc.dayClasses(c, planDate);
    const planStats = new Map(stats.map((s) => [s.subject.id, s]));
    let planOut = '';
    if (S.plan) {
      if (!planClasses.length) {
        const planInfo = Calc.dayPlan(planDate, c);
        planOut = `<div class="empty">No classes on ${Calc.fmtDayName(planDate)} ${Calc.fmtDate(planDate)}${planInfo.off ? ` — ${esc(planInfo.titles.join(', ') || 'off day')}` : ''}.</div>`;
      } else {
        planOut = `<table class="list"><thead><tr><th>Class</th><th>Your %</th><th>After skipping</th><th>Verdict</th></tr></thead><tbody>
          ${planClasses
            .map((cl) => {
              const s = subjById(cl.subjectId);
              const st = planStats.get(cl.subjectId);
              if (!st) return '';
              const eff = Calc.missEffect(st, 1, p());
              return `<tr>
              <td>${esc(s ? s.name : '')}<br /><small class="muted">${esc(cl.kind === 'lab' ? 'Lab' : cl.kind === 'extra' ? 'Extra' : 'Lecture')} · ${esc(cl.periodId ? periodTime(cl.periodId) : '')}</small></td>
              <td>${pctText(st.pct)} <small class="muted">(${st.a}/${st.t})</small></td>
              <td>${pctText(eff.pct)}</td>
              <td>${eff.safe ? '<span class="chip ok">safe to skip</span>' : st.buffer === 0 ? '<span class="chip bad">would drop below</span>' : '<span class="chip warn">risky</span>'}</td>
            </tr>`;
            })
            .join('')}
        </tbody></table>
        <p class="muted">Based on skipping one class of each subject that day; cancelled classes never count either way.</p>`;
      }
    }

    return `
      <div class="card">
        <h2>What-if simulator</h2>
        <p class="muted">See exactly what missing more classes does to your percentage for one subject.</p>
        <div class="field-row">
          <label class="field">Subject
            <select data-act="sim-subject" data-id="sim-subject">
              ${subjects.map((s) => `<option value="${attr(s.id)}" ${s.id === simSubject ? 'selected' : ''}>${esc(s.code ? `${s.code} — ${s.name}` : s.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field">Miss this many more<input id="simMisses" type="number" min="0" step="1" value="${attr(misses)}" style="width:92px" /></label>
          <button data-act="sim-run" type="button">Simulate</button>
        </div>
        ${simOut}
      </div>
      <div class="card">
        <h2>Can I skip tomorrow?</h2>
        <p class="muted">Pick a date and see what skipping that day's classes would do to each subject.</p>
        <div class="field-row">
          <label class="field">Date<input type="date" id="planDate" value="${attr(planDate)}" /></label>
          <button data-act="plan-run" type="button">Plan it</button>
        </div>
        ${planOut}
      </div>`;
  }

  /* ---------- actions ---------- */
  function go(view, opts) {
    S.view = view;
    if (opts && opts.date) S.date = opts.date;
    global.AD.App.render(true);
  }

  const actions = {
    tab: (el) => go(el.dataset.tab),
    'day-prev': () => {
      S.date = Calc.addDays(S.date || todayISO(), -1);
      global.AD.App.render();
    },
    'day-next': () => {
      S.date = Calc.addDays(S.date || todayISO(), 1);
      global.AD.App.render();
    },
    'day-today': () => {
      S.date = todayISO();
      global.AD.App.render();
    },
    'day-goto': (el) => {
      S.date = el.dataset.date;
      go('today');
    },
    'day-set': (el) => {
      if (!el.value || !/^\d{4}-\d{2}-\d{2}$/.test(el.value)) {
        toast('That date does not look right — use the date picker.', 'warn');
        return;
      }
      S.date = el.value;
      global.AD.App.render();
    },
    mark: (el) => {
      const { date, subject, slot, kind, mark } = el.dataset;
      const current = S.data.records.find((r) => r.date === date && (slot ? r.slotKey === slot : !r.slotKey && r.subjectId === subject && r.kind === kind));
      if (current && current.status === mark) {
        Store.setStatus(S.data, { date, subjectId: subject, slotKey: slot || null, kind, status: 'clear' });
      } else {
        Store.setStatus(S.data, { date, subjectId: subject, slotKey: slot || null, kind, status: mark });
      }
      save();
      const c = ctx();
      const st = Calc.subjectStats(subjById(subject), c);
      const word = { present: 'Present', absent: 'Absent', leave: 'Leave', cancelled: 'Cancelled' }[mark];
      toast(
        current && current.status === mark
          ? `Cleared marking for ${esc(subjectTag(subjById(subject)))}.`
          : `<b>${word}</b> — ${esc(subjectTag(subjById(subject)))}: ${pctText(st.pct)} (${st.a}/${st.t})${st.t && st.buffer != null ? st.buffer > 0 ? ` · ${st.buffer} safe miss${st.buffer === 1 ? '' : 'es'} left` : ' · no safe misses left' : ''}`,
        mark === 'present' ? 'ok' : mark === 'absent' ? 'bad' : 'info',
      );
      global.AD.App.render();
    },
    unmark: (el) => {
      const id = el.dataset.id;
      const idx = S.data.records.findIndex((r) => r.id === id);
      if (idx >= 0) {
        const rec = S.data.records[idx];
        S.data.records.splice(idx, 1);
        save();
        const st = Calc.subjectStats(subjById(rec.subjectId), ctx());
        toast(`Cleared. ${esc(subjectTag(subjById(rec.subjectId)))}: ${pctText(st.pct)}`, 'info');
        global.AD.App.render();
      }
    },
    'extra-add': (el) => {
      const subject = $('#extraSubject');
      const kind = $('#extraKind');
      const note = $('#extraNote');
      if (!subject || !subject.value) {
        toast('Add a subject first, then extra classes can be recorded.', 'warn');
        return;
      }
      Store.addExtra(S.data, { date: S.date || todayISO(), subjectId: subject.value, status: el.dataset.status, kind: 'extra', note: note ? note.value.trim() : '' });
      save();
      const st = Calc.subjectStats(subjById(subject.value), ctx());
      toast(`Extra class added — ${esc(subjectTag(subjById(subject.value)))}: ${pctText(st.pct)} (${st.a}/${st.t})`, 'ok');
      global.AD.App.render();
    },
    'sort-set': (el) => {
      S.data.settings.sort = el.value === 'credits' ? 'credits' : 'risk';
      save();
      global.AD.App.render();
    },
    'month-prev': () => {
      const [y, m] = (S.month || todayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 2, 1));
      S.month = d.toISOString().slice(0, 7);
      global.AD.App.render();
    },
    'month-next': () => {
      const [y, m] = (S.month || todayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(Date.UTC(y, m, 1));
      S.month = d.toISOString().slice(0, 7);
      global.AD.App.render();
    },
    'subj-add': () => {
      const name = $('#newSubjName');
      if (!name || !name.value.trim()) {
        toast('Give the subject a name first.', 'warn');
        return;
      }
      const credits = Number($('#newSubjCredits').value);
      S.data.subjects.push({
        id: Store.uid('sub'),
        name: name.value.trim(),
        code: ($('#newSubjCode').value || '').trim(),
        credits: isFinite(credits) ? credits : 3,
        faculty: ($('#newSubjFaculty').value || '').trim(),
        color: '',
        classesPerWeek: null,
        expectedClasses: null,
        carried: { a: 0, t: 0 },
      });
      save();
      toast('Subject added. Next: put it on the timetable.', 'ok');
      global.AD.App.render();
    },
    'subj-delete': (el) => {
      const id = el.dataset.id;
      const s = subjById(id);
      if (!s) return;
      const usage = Store.subjectUsage(S.data, id);
      const carried = Calc.carriedOf(s);
      const carriedNote = carried.t ? ` The ${carried.a}/${carried.t} attendance you entered as existing goes with it.` : '';
      const message = usage.records || usage.cells ? `“${esc(s.name)}” is used by ${usage.cells} timetable slot(s) and ${usage.records} attendance record(s). Deleting removes those records everywhere.${carriedNote}` : `Delete “${esc(s.name)}”?${carriedNote}`;
      openModal('Delete subject', `<p>${message}</p><div class="row"><button class="danger" data-act="subj-delete-confirm" data-id="${attr(id)}" type="button">Delete it</button><button data-act="modal-close" type="button">Keep it</button></div>`);
    },
    'subj-delete-confirm': (el) => {
      const id = el.dataset.id;
      S.data.subjects = S.data.subjects.filter((s) => s.id !== id);
      S.data.records = S.data.records.filter((r) => r.subjectId !== id);
      for (const day of Object.keys(S.data.timetable)) {
        const cells = S.data.timetable[day];
        for (const pid of Object.keys(cells)) if (cells[pid] && cells[pid].subjectId === id) delete cells[pid];
      }
      save();
      closeModal();
      toast('Subject deleted.', 'info');
      global.AD.App.render();
    },
    /** Commit the attended/held pair the user brought in from their college portal. */
    'carried-field': (el) => {
      const row = el.closest('tr');
      const subject = row && subjById(row.dataset.id);
      if (!subject) return;
      const read = (field) => {
        const input = row.querySelector(`input[data-field="${field}"]`);
        const n = Number(input && input.value);
        return isFinite(n) && n > 0 ? Math.round(n) : 0;
      };
      const a = read('a');
      const t = read('t');
      if (a > t) toast(`${esc(subjectTag(subject))}: attended can&rsquo;t be more than held — counting ${t} attended.`, 'warn', 7000);
      subject.carried = { a, t };
      save();
      global.AD.App.render();
    },
    'carried-clear': (el) => {
      const subject = subjById(el.dataset.id);
      if (!subject) return;
      subject.carried = { a: 0, t: 0 };
      save();
      global.AD.App.render();
      toast(`Cleared the existing attendance for ${esc(subjectTag(subject))}.`, 'info');
    },
    'whatif-subject': (el) => {
      S.sim = Object.assign({}, S.sim, { subjectId: el.dataset.id });
      go('tools');
    },
    'sim-subject': (el) => {
      S.sim = Object.assign({}, S.sim, { subjectId: el.value });
      global.AD.App.render();
    },
    'sim-run': () => {
      const sel = $('[data-act="sim-subject"]');
      const misses = Number($('#simMisses').value);
      S.sim = { subjectId: sel ? sel.value : S.sim && S.sim.subjectId, misses: isFinite(misses) && misses >= 0 ? misses : 0 };
      global.AD.App.render();
    },
    'plan-run': () => {
      const input = $('#planDate');
      S.plan = { date: input && input.value ? input.value : Calc.addDays(todayISO(), 1) };
      global.AD.App.render();
    },
    'modal-close': () => closeModal(),
  };

  /** Commit a text/number edit in the subjects table. */
  function onFieldChange(el) {
    if (el.dataset.act !== 'subj-field') return false;
    const row = el.closest('tr');
    const subject = subjById(row.dataset.id);
    if (!subject) return false;
    const field = el.dataset.field;
    let value = el.value;
    if (field === 'credits') value = isFinite(Number(value)) ? Number(value) : 3;
    if (field === 'classesPerWeek' || field === 'expectedClasses') value = value === '' ? null : isFinite(Number(value)) ? Number(value) : null;
    subject[field] = value;
    save();
    global.AD.App.render();
    return true;
  }

  A.Ui = {
    S,
    ctx,
    save,
    toast,
    openModal,
    closeModal,
    esc,
    attr,
    pctText,
    subjById,
    periodById,
    todayISO,
    actions,
    onFieldChange,
    views: { today: renderToday, dashboard: renderDashboard, subjects: renderSubjects, tools: renderTools },
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* calc.js — pure attendance/scheduling engine.
 * No DOM, no storage: everything here is a function of the data model, which keeps it unit-testable
 * (see tests/calc.test.mjs) and keeps the counting rules in exactly one place.
 *
 * Counting rules (the whole app depends on these):
 *   1 timetable cell = 1 class; a lab occupies two periods on the grid but counts once.
 *   t (classes held)  = present + absent (+ medical leave when leaveMode = "absent")
 *   a (classes attended) = present only
 *   cancelled / holiday classes are never counted anywhere.
 *   T (scheduled this semester) = timetable cells on teaching days in [start..end]
 *                                minus cancels, plus extras that were actually held.
 */
(function (global) {
  'use strict';
  /* ---------- dates ---------- */
  function toDate(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function ymdString(date) {
    return date.toISOString().slice(0, 10);
  }
  function addDays(ymd, n) {
    const d = toDate(ymd);
    d.setUTCDate(d.getUTCDate() + n);
    return ymdString(d);
  }
  function eachDay(start, end) {
    const out = [];
    if (!start || !end || end < start) return out;
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
    return out;
  }
  /** 1 = Monday … 7 = Sunday */
  function weekday(ymd) {
    const wd = toDate(ymd).getUTCDay();
    return wd === 0 ? 7 : wd;
  }
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function fmtDate(ymd, opts) {
    if (!ymd) return '';
    return toDate(ymd).toLocaleDateString(undefined, Object.assign({ day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }, opts || {}));
  }
  function fmtDayName(ymd) {
    return DAY_NAMES[weekday(ymd) - 1];
  }

  /* ---------- academic calendar ---------- */
  /**
   * Flatten calendar entries into a per-date lookup for the semester window.
   * Priority: an off-day (holiday / exam / suspended) always wins over a swapped-timetable day.
   */
  function calendarIndex(entries, start, end) {
    const map = new Map();
    if (!start || !end) return map;
    for (const e of entries || []) {
      if (!e || !e.start) continue;
      const s = e.start;
      const t = e.end || e.start;
      if (t < s) continue;
      for (const d of eachDay(s < start ? start : s, t > end ? end : t)) {
        const cur = map.get(d) || { off: false, swap: null, titles: [] };
        if (e.type === 'working-swap') {
          if (e.swapDay) cur.swap = e.swapDay;
        } else {
          cur.off = true;
        }
        if (e.title) cur.titles.push(e.title);
        map.set(d, cur);
      }
    }
    return map;
  }

  /** What actually happens on a date: off-day, swapped weekday, and whether classes are held. */
  function dayPlan(ymd, ctx) {
    const info = ctx.index.get(ymd);
    const off = !!(info && info.off);
    const schoolDays = (ctx.data.settings.schoolDays && ctx.data.settings.schoolDays.length) ? ctx.data.settings.schoolDays : [1, 2, 3, 4, 5, 6];
    const actualWeekday = weekday(ymd);
    const effectiveWeekday = info && info.swap ? info.swap : actualWeekday;
    const teaching = !off && schoolDays.indexOf(effectiveWeekday) !== -1;
    return {
      date: ymd,
      off,
      swap: info && info.swap ? info.swap : null,
      weekday: effectiveWeekday,
      actualWeekday,
      teaching,
      titles: info ? info.titles.slice() : [],
    };
  }

  /** Cells of the timetable for one effective weekday: [{ periodId, subjectId, lab }] */
  function cellsForDay(timetable, day) {
    const cells = (timetable && timetable[String(day)]) || {};
    return Object.keys(cells)
      .filter((pid) => cells[pid] && cells[pid].subjectId)
      .sort((a, b) => a.localeCompare(b))
      .map((pid) => ({ periodId: pid, subjectId: cells[pid].subjectId, lab: !!cells[pid].lab, key: `${day}:${pid}` }));
  }

  /** Every scheduled class of the semester for one subject (or all subjects when subjectId is null). */
  function scheduledSlots(ctx, subjectId) {
    const sem = ctx.data.settings.semester;
    if (!sem.start || !sem.end) return [];
    const out = [];
    for (const d of eachDay(sem.start, sem.end)) {
      const plan = dayPlan(d, ctx);
      if (!plan.teaching) continue;
      for (const cell of cellsForDay(ctx.data.timetable, plan.weekday)) {
        if (subjectId && cell.subjectId !== subjectId) continue;
        out.push({ date: d, periodId: cell.periodId, subjectId: cell.subjectId, lab: cell.lab, key: cell.key });
      }
    }
    return out;
  }

  function countTeachingDays(ctx) {
    const sem = ctx.data.settings.semester;
    let n = 0;
    for (const d of eachDay(sem.start, sem.end)) if (dayPlan(d, ctx).teaching) n++;
    return n;
  }

  /* ---------- attendance records ---------- */
  const isHeld = (status, leaveMode) => status === 'present' || status === 'absent' || (status === 'leave' && leaveMode !== 'exclude');
  const CONTRIBUTES = { present: { a: 1, t: 1 }, absent: { a: 0, t: 1 }, leave: { a: 0, t: 1 }, cancelled: { a: 0, t: 0 } };

  /** Records for a date, keyed by slot so the Today view can show "not marked yet" rows. */
  function recordsForDate(ctx, date) {
    return ctx.data.records.filter((r) => r.date === date);
  }
  function recordForSlot(ctx, date, key) {
    return ctx.data.records.find((r) => r.date === date && r.slotKey === key) || null;
  }

  /** The classes listed for a date: timetable cells plus any extra classes already added. */
  function dayClasses(ctx, date) {
    const plan = dayPlan(date, ctx);
    const out = [];
    if (plan.teaching) {
      for (const cell of cellsForDay(ctx.data.timetable, plan.weekday)) {
        out.push({ slotKey: cell.key, subjectId: cell.subjectId, kind: cell.lab ? 'lab' : 'lecture', periodId: cell.periodId, planned: true, record: recordForSlot(ctx, date, cell.key) });
      }
    }
    for (const r of recordsForDate(ctx, date)) {
      if (r.kind === 'extra' || !r.slotKey) out.push({ slotKey: r.slotKey, subjectId: r.subjectId, kind: r.kind, planned: false, record: r });
    }
    return out;
  }

  /** Guards ceil() against binary-floating-point noise (see mustAttend below). */
  const CEIL_EPSILON = 1e-9;

  /* ---------- per-subject stats ---------- */
  /**
   * Attendance the user brought with them ("held 40 / attended 36 before I started marking"), in
   * whole classes. Normalised on load by Store.normalize and clamped again here on the way into the
   * maths, so no hand-edited backup can reach the formulas as a fraction of a class, a negative or
   * a percentage above 100%.
   */
  function carriedOf(subject) {
    const c = (subject && subject.carried) || {};
    const count = (v) => {
      const n = Math.round(Number(v));
      return isFinite(n) ? Math.max(0, n) : 0;
    };
    const t = count(c.t);
    const a = Math.min(t, count(c.a));
    return { a, t };
  }

  function subjectStats(subject, ctx) {
    const p = ctx.data.settings.threshold;
    const leaveMode = ctx.data.settings.leaveMode;
    const carried = carriedOf(subject);
    const recs = ctx.data.records.filter((r) => r.subjectId === subject.id);
    const held = recs.filter((r) => isHeld(r.status, leaveMode));
    // Counted classes = the ones carried in from before + everything marked since.
    const t = carried.t + held.length;
    const a = carried.a + recs.filter((r) => r.status === 'present').length;
    const cancellations = recs.filter((r) => r.status === 'cancelled').length;
    const extrasHeld = held.filter((r) => r.kind === 'extra' || !r.slotKey).length;

    const sem = ctx.data.settings.semester;
    const slots = sem.start && sem.end ? scheduledSlots(ctx, subject.id) : [];
    const perWeek = subject.classesPerWeek != null && subject.classesPerWeek !== '' ? Number(subject.classesPerWeek) : Number(subject.credits) || 0;

    let T;
    let TSource;
    if (subject.expectedClasses != null && subject.expectedClasses !== '') {
      T = Number(subject.expectedClasses) - cancellations + extrasHeld;
      TSource = 'manual';
    } else if (slots.length) {
      T = slots.length - cancellations + extrasHeld;
      TSource = 'timetable';
    } else {
      // No timetable yet: fall back to credits (or an explicit override) as classes per week.
      T = Math.round((perWeek * countTeachingDays(ctx)) / 6) - cancellations + extrasHeld;
      TSource = 'estimated';
    }
    const TPlanned = T;
    const TAdjusted = T < t;
    if (TAdjusted) T = t; // the plan is stale (extras happened, or part of t is carried); never report more held than planned

    const remaining = Math.max(0, T - t);
    const pct = t ? a / t : null;
    const buffer = t ? Math.max(0, Math.floor(a / p - t)) : null; // safe misses from now
    // ceil((p·t − a) / (1 − p)) is undefined at p = 1: once you have missed a class at a 100%
    // requirement there is no number of classes that gets you back, so report null (not Infinity).
    // CEIL_EPSILON keeps exact answers exact: 0.9 × 40 − 35 divides out to 10.000000000000036, which
    // would otherwise tell the user to attend 11 classes when 10 is enough.
    const mustAttend = pct != null && pct < p ? (p >= 1 ? null : Math.ceil((p * t - a) / (1 - p) - CEIL_EPSILON)) : 0;
    const maxMissTotal = Math.floor((1 - p) * T);
    return {
      subject,
      a,
      t,
      T,
      TPlanned,
      TSource,
      TAdjusted,
      carried,
      pct,
      buffer,
      mustAttend,
      remaining,
      projectedBest: T ? (a + remaining) / T : null,
      projectedWorst: T ? a / T : null,
      maxMissTotal,
      usedMisses: Math.max(0, t - a),
      cancelled: cancellations,
      status: t === 0 ? 'none' : pct < p || buffer === 0 ? 'red' : buffer <= 3 ? 'yellow' : 'green',
    };
  }

  function allStats(ctx) {
    return ctx.data.subjects.map((s) => subjectStats(s, ctx));
  }

  function overallStats(ctx, stats) {
    stats = stats || allStats(ctx);
    const withData = stats.filter((s) => s.t > 0);
    const A = withData.reduce((n, s) => n + s.a, 0);
    const T = withData.reduce((n, s) => n + s.t, 0);
    const creditA = withData.reduce((n, s) => n + (Number(s.subject.credits) || 0) * s.a, 0);
    const creditT = withData.reduce((n, s) => n + (Number(s.subject.credits) || 0) * s.t, 0);
    return {
      pct: T ? A / T : null,
      creditPct: creditT ? creditA / creditT : null,
      a: A,
      t: T,
      subjects: stats.length,
      atRisk: stats.filter((s) => s.t > 0 && (s.pct < ctx.data.settings.threshold || s.buffer === 0)).length,
      below: stats.filter((s) => s.t > 0 && s.pct < ctx.data.settings.threshold).length,
    };
  }

  /* ---------- projections, warnings, planning ---------- */
  /** Effect of missing `extraMisses` more classes of a subject (what-if simulator). */
  function missEffect(stats, extraMisses, p) {
    p = p == null ? 0.75 : p;
    const t2 = stats.t + Math.max(0, Number(extraMisses) || 0);
    const pct2 = t2 ? stats.a / t2 : null;
    return { pct: pct2, buffer: Math.max(0, Math.floor(stats.a / p - t2)), safe: pct2 != null && pct2 >= p };
  }

  function warnings(ctx, stats) {
    stats = stats || allStats(ctx);
    const p = ctx.data.settings.threshold;
    const out = [];
    for (const s of stats) {
      const name = s.subject.name;
      if (s.t === 0) continue;
      if (s.pct < p) {
        const recover = s.mustAttend == null ? `you cannot get back to ${(p * 100).toFixed(0)}% from here` : `attend ${s.mustAttend} in a row to recover`;
        out.push({ severity: 'red', subjectId: s.subject.id, text: `${name} is below ${(p * 100).toFixed(0)}% (${(s.pct * 100).toFixed(1)}%) — ${recover}.` });
      } else if (s.buffer === 0) {
        out.push({ severity: 'yellow', subjectId: s.subject.id, text: `${name} is exactly at the line — one more absence drops it below ${(p * 100).toFixed(0)}%.` });
      } else if (s.buffer <= 1) {
        out.push({ severity: 'yellow', subjectId: s.subject.id, text: `${name} can only take ${s.buffer} more absence${s.buffer === 1 ? '' : 's'}.` });
      }
      if (s.TAdjusted) {
        const hint = s.carried.t ? ' If part of that is your existing attendance, keep the semester start at the real first day of classes (or set "Total T" by hand).' : '';
        out.push({ severity: 'yellow', subjectId: s.subject.id, text: `${name}: the semester plan predicts ${s.TPlanned} classes but ${s.t} have been held — check the timetable or T.${hint}` });
      }
    }
    return out;
  }

  /**
   * Most recent past teaching day (within `lookback` days) that had classes but has no records at
   * all — i.e. the day you forgot to mark. Days with nothing scheduled are ignored on purpose.
   */
  function unmarkedDay(ctx, today, lookback) {
    lookback = lookback == null ? 7 : lookback;
    for (let i = 1; i <= lookback; i++) {
      const d = addDays(today, -i);
      const sem = ctx.data.settings.semester;
      if (sem.start && (d < sem.start || d > sem.end)) break;
      const plan = dayPlan(d, ctx);
      if (!plan.teaching) continue;
      if (!cellsForDay(ctx.data.timetable, plan.weekday).length) continue;
      if (recordsForDate(ctx, d).length) return null;
      return { date: d, plan };
    }
    return null;
  }

  /** "Classes I can bunk today": today's classes whose subject still has slack. */
  function bunkable(ctx, date, stats) {
    stats = stats || allStats(ctx);
    const byId = new Map(stats.map((s) => [s.subject.id, s]));
    const list = dayClasses(ctx, date)
      .filter((c) => !c.record)
      .map((c) => ({ ...c, stats: byId.get(c.subjectId) || null }));
    const safe = list.filter((c) => c.stats && c.stats.buffer > 0);
    return { total: list.length, safeCount: safe.length, safe, all: list };
  }

  /**
   * Cumulative attendance trend up to `upto` (for the line chart). It starts from the carried
   * balances so the line's last point agrees with the tiles, which also include them.
   */
  function trend(ctx, upto) {
    const sem = ctx.data.settings.semester;
    if (!sem.start || !sem.end) return [];
    const end = upto && upto < sem.end ? upto : sem.end;
    const out = [];
    let a = 0;
    let t = 0;
    for (const s of ctx.data.subjects) {
      const c = carriedOf(s);
      a += c.a;
      t += c.t;
    }
    for (const d of eachDay(sem.start, end)) {
      const plan = dayPlan(d, ctx);
      const scheduled = plan.teaching ? cellsForDay(ctx.data.timetable, plan.weekday).length : 0;
      const recs = recordsForDate(ctx, d);
      for (const r of recs) {
        if (r.status === 'leave' && ctx.data.settings.leaveMode === 'exclude') continue;
        const c = CONTRIBUTES[r.status] || { a: 0, t: 0 };
        a += c.a;
        t += c.t;
      }
      if (scheduled > 0 || recs.length) out.push({ date: d, a, t, pct: t ? a / t : null });
    }
    return out;
  }

  /**
   * Per-date summary used by the heatmap: present / absent / cancelled / off / unmarked / none.
   * Pass `today` so future teaching days read as "none" rather than "not marked yet".
   */
  function daySummary(ctx, date, today) {
    const recs = recordsForDate(ctx, date);
    const plan = dayPlan(date, ctx);
    const scheduled = plan.teaching ? cellsForDay(ctx.data.timetable, plan.weekday).length : 0;
    const present = recs.filter((r) => r.status === 'present').length;
    const absent = recs.filter((r) => r.status === 'absent' || (r.status === 'leave' && ctx.data.settings.leaveMode !== 'exclude')).length;
    const cancelled = recs.filter((r) => r.status === 'cancelled').length;
    let kind = 'none';
    if (plan.off) kind = 'off';
    else if (absent) kind = 'absent';
    else if (present) kind = 'present';
    else if (cancelled) kind = 'cancelled';
    else if (scheduled && recs.length === 0 && (!today || date <= today)) kind = 'unmarked';
    else if (!scheduled && recs.length === 0) kind = 'none';
    return { date, kind, present, absent, cancelled, scheduled, recs, plan };
  }

  const api = {
    addDays,
    eachDay,
    weekday,
    DAY_NAMES,
    fmtDate,
    fmtDayName,
    calendarIndex,
    dayPlan,
    cellsForDay,
    scheduledSlots,
    countTeachingDays,
    carriedOf,
    dayClasses,
    subjectStats,
    allStats,
    overallStats,
    missEffect,
    warnings,
    unmarkedDay,
    bunkable,
    trend,
    daySummary,
  };

  global.AD = global.AD || {};
  global.AD.Calc = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

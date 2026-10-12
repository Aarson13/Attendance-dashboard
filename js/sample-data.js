/* sample-data.js — the demo dataset behind Settings → "Load sample data".
 * It is generated from the same engine the app uses (AD.Calc) so the demo exercises real
 * scheduling: holidays from the bundled Manipal calendar, the two swapped "Friday timetable" days,
 * labs counting once, cancellations and medical leave.
 */
(function (global) {
  'use strict';
  const Store = global.AD && global.AD.Store;
  const Calc = global.AD && global.AD.Calc;

  const SUBJECTS = [
    { name: 'Data Structures and Algorithms', code: 'CS2001', credits: 4, faculty: 'Dr. Anitha Rao', bias: 0.9 },
    { name: 'Discrete Mathematics', code: 'MA2002', credits: 3, faculty: 'Dr. S. Nair', bias: 0.7 },
    { name: 'Digital Design', code: 'EC2003', credits: 3, faculty: 'Dr. K. Iyer', bias: 0.79 },
    { name: 'Object Oriented Programming', code: 'CS2004', credits: 3, faculty: 'Prof. R. Menon', bias: 0.95 },
    { name: 'Database Systems', code: 'CS2005', credits: 4, faculty: 'Dr. P. Shetty', bias: 0.86 },
    { name: 'DSA Lab', code: 'CS2001L', credits: 1, faculty: 'Dr. Anitha Rao', bias: 1 },
    { name: 'DBMS Lab', code: 'CS2005L', credits: 1, faculty: 'Dr. P. Shetty', bias: 0.92 },
  ];

  // day -> { periodId: [subjectCode, isLab] }
  const GRID = {
    1: { p1: ['CS2001'], p2: ['MA2002'], p3: ['CS2005'], p4: ['CS2004'] },
    2: { p1: ['CS2001'], p2: ['EC2003'], p3: ['CS2005'], p5: ['CS2001L', true] },
    3: { p1: ['MA2002'], p2: ['CS2001'], p4: ['CS2004'], p5: ['CS2005L', true] },
    4: { p1: ['EC2003'], p2: ['CS2005'], p3: ['MA2002'], p4: ['CS2004'] },
    5: { p1: ['CS2001'], p2: ['EC2003'], p4: ['CS2005'], p5: ['CS2001L', true] },
    6: { p2: ['MA2002'], p3: ['EC2003'] },
  };

  /** Deterministic 0..1 hash so the demo marks the same way every time it is loaded. */
  function roll(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
  }

  function bundledCalendar() {
    const snap = global.MANIPAL_CALENDAR;
    if (snap && Store) {
      const conv = Store.snapshotToCalendar(snap);
      return { sources: [conv.source], entries: conv.entries, semester: conv.semester };
    }
    return { sources: [], entries: [], semester: null };
  }

  function build(todayStr) {
    const data = Store.defaults();
    const cal = bundledCalendar();
    data.settings.semester = {
      name: cal.semester && cal.semester.name ? cal.semester.name : 'Odd semester 2026',
      start: (cal.semester && cal.semester.start) || '2026-07-23',
      end: (cal.semester && cal.semester.end) || '2026-11-13',
    };
    data.settings.theme = 'dark';
    data.calendar.sources = cal.sources;
    data.calendar.entries = cal.entries;

    const byCode = {};
    data.subjects = SUBJECTS.map((s) => {
      const sub = { id: Store.uid('sub'), name: s.name, code: s.code, credits: s.credits, faculty: s.faculty, color: '', classesPerWeek: null, expectedClasses: null };
      byCode[s.code] = sub;
      sub.bias = s.bias; // stripped by Store.normalize on save
      return sub;
    });
    for (const day of Object.keys(GRID)) {
      data.timetable[day] = {};
      for (const pid of Object.keys(GRID[day])) {
        const [code, lab] = GRID[day][pid];
        data.timetable[day][pid] = { subjectId: byCode[code].id, lab: !!lab };
      }
    }

    // Mark attendance for every teaching day up to (but not including) the most recent one, so the
    // "you haven't marked classes" reminder has something real to point at.
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const semEnd = data.settings.semester.end;
    const upto = today > semEnd ? semEnd : today;
    const ctx = { data, index: Calc.calendarIndex(data.calendar.entries, data.settings.semester.start, semEnd) };
    const teachingDays = [];
    for (const d of Calc.eachDay(data.settings.semester.start, upto)) {
      if (Calc.dayPlan(d, ctx).teaching) teachingDays.push(d);
    }
    teachingDays.pop(); // leave the most recent teaching day unmarked (demo for the reminder banner)
    for (const date of teachingDays) {
      const plan = Calc.dayPlan(date, ctx);
      for (const cell of Calc.cellsForDay(data.timetable, plan.weekday)) {
        const subject = data.subjects.find((s) => s.id === cell.subjectId);
        const r = roll(`${subject.code}|${date}|${cell.periodId}`);
        const bias = subject.bias == null ? 0.85 : subject.bias;
        let status = 'present';
        if (r >= bias) status = r < bias + (1 - bias) * 0.75 ? 'absent' : 'cancelled';
        if (r > 0.985) status = 'leave';
        data.records.push({ id: Store.uid('rec'), date, subjectId: subject.id, slotKey: cell.key, kind: cell.lab ? 'lab' : 'lecture', status, note: '', at: `${date}T09:30:00.000Z` });
      }
    }
    // Two extra classes (not in the timetable) the way a lab makeup would be entered by hand.
    // They sit a few teaching days back so the most recent day stays unmarked for the reminder.
    const pick = (back) => teachingDays[Math.max(0, teachingDays.length - back)] || upto;
    const ds = byCode.CS2001;
    const dbms = byCode.CS2005;
    if (ds) {
      data.records.push({ id: Store.uid('rec'), date: pick(5), subjectId: ds.id, slotKey: null, kind: 'extra', status: 'present', note: 'Makeup class', at: new Date().toISOString() });
    }
    if (dbms) {
      data.records.push({ id: Store.uid('rec'), date: pick(8), subjectId: dbms.id, slotKey: null, kind: 'extra', status: 'absent', note: 'Extra tutorial', at: new Date().toISOString() });
    }
    return Store.normalize(data);
  }

  let cache = null;
  function data() {
    if (!cache) cache = build();
    return cache;
  }

  const api = { SUBJECTS, build, data };
  global.AD = global.AD || {};
  global.AD.Sample = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

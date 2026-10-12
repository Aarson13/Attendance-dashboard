/* store.js — data model, localStorage persistence, import/export (JSON, CSV, ICS).
 * The whole app is one JSON document under one localStorage key. Everything that touches disk
 * lives here so the UI never has to think about shape or quota.
 */
(function (global) {
  'use strict';

  const KEY = 'attendance-dashboard/v1';
  const VERSION = 1;
  const APP_TAG = 'attendance-dashboard';

  function uid(prefix) {
    return `${prefix || 'id'}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
  }

  function defaultSettings() {
    return {
      threshold: 0.75,
      theme: 'dark',
      semester: { name: '', start: '', end: '' },
      leaveMode: 'absent', // 'absent' | 'exclude'
      sort: 'risk', // 'risk' | 'credits'
      schoolDays: [1, 2, 3, 4, 5, 6], // Mon..Sat
      periods: [
        { id: 'p1', label: 'P1', start: '09:00', end: '09:55' },
        { id: 'p2', label: 'P2', start: '10:00', end: '10:55' },
        { id: 'p3', label: 'P3', start: '11:05', end: '12:00' },
        { id: 'p4', label: 'P4', start: '12:05', end: '13:00' },
        { id: 'p5', label: 'P5', start: '14:00', end: '14:55' },
        { id: 'p6', label: 'P6', start: '15:00', end: '15:55' },
      ],
      spotlights: true, // pointer spotlight on cards (React Bits "Spotlight Card" idea)
    };
  }

  function defaults() {
    return {
      app: APP_TAG,
      version: VERSION,
      settings: defaultSettings(),
      subjects: [],
      timetable: {},
      calendar: { sources: [], entries: [] },
      records: [],
      ocr: { images: [] },
    };
  }

  /* ---------- persistence ---------- */
  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (err) {
      return defaults();
    }
    if (!raw) return defaults();
    try {
      return normalize(JSON.parse(raw));
    } catch (err) {
      console.warn('stored data was unreadable, starting fresh', err);
      return defaults();
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return { ok: true };
    } catch (err) {
      // Almost always the OCR images filling the quota: drop them and keep the numbers safe.
      if (data.ocr && data.ocr.images && data.ocr.images.length) {
        const dropped = data.ocr.images.length;
        data.ocr.images = [];
        try {
          localStorage.setItem(KEY, JSON.stringify(data));
          return { ok: true, warning: `Storage was full — dropped ${dropped} stored timetable image(s) to save your attendance data.` };
        } catch (err2) {
          return { ok: false, error: err2.message };
        }
      }
      return { ok: false, error: err.message };
    }
  }

  function storageBytes(data) {
    try {
      return new Blob([JSON.stringify(data)]).size;
    } catch (err) {
      return JSON.stringify(data).length;
    }
  }

  /** Whole-class count that survives a hand-edited backup: anything that is not a finite number reads as 0. */
  function countOrZero(v) {
    const n = Math.round(Number(v));
    return isFinite(n) ? Math.max(0, n) : 0;
  }

  function normalize(input) {
    const d = Object.assign(defaults(), input || {});
    d.settings = Object.assign(defaultSettings(), d.settings || {});
    d.settings.semester = Object.assign({ name: '', start: '', end: '' }, d.settings.semester || {});
    const th = Number(d.settings.threshold);
    d.settings.threshold = isFinite(th) && th > 0 && th <= 1 ? th : 0.75;
    d.settings.leaveMode = d.settings.leaveMode === 'exclude' ? 'exclude' : 'absent';
    d.settings.sort = d.settings.sort === 'credits' ? 'credits' : 'risk';
    if (!Array.isArray(d.settings.periods) || !d.settings.periods.length) d.settings.periods = defaultSettings().periods;
    if (!Array.isArray(d.settings.schoolDays) || !d.settings.schoolDays.length) d.settings.schoolDays = [1, 2, 3, 4, 5, 6];
    d.subjects = (Array.isArray(d.subjects) ? d.subjects : []).map((s) => ({
      id: s.id || uid('sub'),
      name: String(s.name || 'Untitled subject').trim(),
      code: String(s.code || '').trim(),
      credits: s.credits === '' || s.credits == null ? 3 : Number(s.credits),
      faculty: String(s.faculty || '').trim(),
      color: s.color || '',
      classesPerWeek: s.classesPerWeek == null || s.classesPerWeek === '' ? null : Number(s.classesPerWeek),
      expectedClasses: s.expectedClasses == null || s.expectedClasses === '' ? null : Number(s.expectedClasses),
      // Attendance brought in from before the user started marking (see Calc.carriedOf): stored as
      // whole non-negative classes, with anything unreadable in the file repaired to 0. The engine
      // clamps attended to held for the maths and the UI flags an impossible pair in the entry table.
      carried: {
        a: countOrZero(s.carried && s.carried.a),
        t: countOrZero(s.carried && s.carried.t),
      },
    }));
    d.timetable = d.timetable && typeof d.timetable === 'object' ? d.timetable : {};
    d.calendar = d.calendar && typeof d.calendar === 'object' ? d.calendar : { sources: [], entries: [] };
    d.calendar.entries = (Array.isArray(d.calendar.entries) ? d.calendar.entries : [])
      .filter((e) => e && e.start)
      .map((e) => ({
        id: e.id || uid('cal'),
        type: ['holiday', 'exam', 'suspended', 'working-swap'].indexOf(e.type) >= 0 ? e.type : 'holiday',
        start: e.start,
        end: e.end || e.start,
        title: String(e.title || ''),
        swapDay: e.swapDay ? Number(e.swapDay) : null,
        sourceId: e.sourceId || null,
      }));
    d.calendar.sources = Array.isArray(d.calendar.sources) ? d.calendar.sources : [];
    d.records = (Array.isArray(d.records) ? d.records : [])
      .filter((r) => r && r.date && r.subjectId)
      .map((r) => ({
        id: r.id || uid('rec'),
        date: r.date,
        subjectId: r.subjectId,
        slotKey: r.slotKey || null,
        kind: r.kind === 'lab' ? 'lab' : r.kind === 'extra' ? 'extra' : 'lecture',
        status: ['present', 'absent', 'cancelled', 'leave'].indexOf(r.status) >= 0 ? r.status : 'present',
        note: r.note || '',
        at: r.at || new Date().toISOString(),
      }));
    d.ocr = Object.assign({ images: [] }, d.ocr || {});
    if (!Array.isArray(d.ocr.images)) d.ocr.images = [];
    return d;
  }

  /* ---------- records ---------- */
  function setStatus(data, { date, subjectId, slotKey, kind, status }) {
    const idx = data.records.findIndex((r) => r.date === date && (slotKey ? r.slotKey === slotKey : !r.slotKey && r.subjectId === subjectId && r.kind === kind));
    if (status === 'clear') {
      if (idx >= 0) data.records.splice(idx, 1);
      return null;
    }
    if (idx >= 0) {
      data.records[idx].status = status;
      data.records[idx].at = new Date().toISOString();
      return data.records[idx];
    }
    const rec = { id: uid('rec'), date, subjectId, slotKey: slotKey || null, kind: kind || 'lecture', status, note: '', at: new Date().toISOString() };
    data.records.push(rec);
    return rec;
  }

  function addExtra(data, { date, subjectId, status, kind, note }) {
    const rec = { id: uid('rec'), date, subjectId, slotKey: null, kind: kind || 'extra', status, note: note || '', at: new Date().toISOString() };
    data.records.push(rec);
    return rec;
  }

  function subjectUsage(data, subjectId) {
    const records = data.records.filter((r) => r.subjectId === subjectId).length;
    let cells = 0;
    for (const day of Object.keys(data.timetable)) cells += Object.values(data.timetable[day] || {}).filter((c) => c.subjectId === subjectId).length;
    return { records, cells };
  }

  /* ---------- JSON export / import ---------- */
  function exportJSON(data) {
    return JSON.stringify({ app: APP_TAG, version: VERSION, exportedAt: new Date().toISOString(), data }, null, 2);
  }

  /** Import a full backup, or a calendar snapshot produced by scripts/sync-calendar.mjs. */
  function importJSON(text) {
    const parsed = JSON.parse(text);
    if (parsed && parsed.app === APP_TAG && parsed.data) {
      return { kind: 'backup', data: normalize(parsed.data), summary: `${parsed.data.subjects ? parsed.data.subjects.length : 0} subjects, ${parsed.data.records ? parsed.data.records.length : 0} attendance records` };
    }
    // Calendar snapshot from the scraper OR a hand-written { entries: [...] } file.
    if (parsed && Array.isArray(parsed.entries)) {
      return { kind: 'calendar', snapshot: snapshotToCalendar(parsed) };
    }
    if (parsed && parsed.subjects && parsed.records) {
      return { kind: 'backup', data: normalize(parsed), summary: 'raw data object' };
    }
    throw new Error('Unrecognised JSON — expected an attendance backup or a calendar snapshot.');
  }

  function snapshotToCalendar(snap) {
    const source = {
      id: uid('src'),
      title: snap.title || snap.id || 'Calendar snapshot',
      url: (snap.source && snap.source.url) || '',
      fetchedAt: (snap.source && snap.source.fetchedAt) || '',
      kind: (snap.source && snap.source.kind) || 'snapshot',
    };
    const entries = (snap.entries || [])
      .filter((e) => e && e.start)
      .map((e) => ({
        id: uid('cal'),
        type: ['holiday', 'exam', 'suspended', 'working-swap'].indexOf(e.type) >= 0 ? e.type : 'holiday',
        start: e.start,
        end: e.end || e.start,
        title: e.title || '',
        swapDay: e.swapDay ? Number(e.swapDay) : null,
        sourceId: source.id,
      }));
    return { source, semester: snap.semester || (snap.semesters && snap.semesters[0]) || null, semesters: snap.semesters || (snap.semester ? [snap.semester] : []), entries, notes: snap.notes || [] };
  }

  /* ---------- CSV ---------- */
  /** Small RFC4180-ish parser: quotes, escaped quotes, CRLF. */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const src = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inQuotes) {
        if (c === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (c !== '\r') field += c;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    // Blank lines and '#' comment lines (the sample templates carry their own instructions).
    const clean = rows.filter((r) => r.some((f) => String(f).trim() !== '') && !String(r[0] || '').trim().startsWith('#'));
    if (!clean.length) return { headers: [], rows: [] };
    const headers = clean[0].map((h) => h.trim().toLowerCase());
    const out = clean.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = (r[i] || '').trim()));
      return o;
    });
    return { headers, rows: out };
  }

  function dayNumber(value) {
    const v = String(value || '').trim().toLowerCase();
    const names = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
    if (names[v.slice(0, 3)]) return names[v.slice(0, 3)];
    const n = Number(v);
    return n >= 1 && n <= 6 ? n : null;
  }

  function findPeriod(settings, { period, start }) {
    const pl = String(period || '').trim().toLowerCase();
    if (pl) {
      const byLabel = settings.periods.find((p) => p.label.toLowerCase() === pl || p.id.toLowerCase() === pl);
      if (byLabel) return byLabel;
    }
    const st = String(start || '').trim();
    if (st) {
      const byTime = settings.periods.find((p) => p.start === st);
      if (byTime) return byTime;
      const np = { id: uid('p'), label: `P${settings.periods.length + 1}`, start: st, end: '' };
      settings.periods.push(np);
      return np;
    }
    return null;
  }

  /** Timetable CSV → cells. Missing subjects are created (flagged in warnings, never silent). */
  function timetableFromCSV(text, data) {
    const { headers, rows } = parseCSV(text);
    const warnings = [];
    if (!rows.length) return { cells: [], warnings: ['No data rows found.'] };
    if (headers.indexOf('day') < 0) warnings.push('No "day" column found — expected day,period,subject[,kind].');
    const cells = [];
    const findSubject = (value) => {
      const v = String(value || '').trim().toLowerCase();
      if (!v) return null;
      return data.subjects.find((s) => (s.code || '').toLowerCase() === v || s.name.toLowerCase() === v) ||
        data.subjects.find((s) => (s.code || '').toLowerCase().replace(/[^a-z0-9]/g, '') === v.replace(/[^a-z0-9]/g, '')) ||
        data.subjects.find((s) => s.name.toLowerCase().indexOf(v) >= 0 || v.indexOf(s.name.toLowerCase()) >= 0);
    };
    for (const r of rows) {
      const day = dayNumber(r.day);
      if (!day) {
        warnings.push(`Skipped row with unrecognised day "${r.day || ''}".`);
        continue;
      }
      const period = findPeriod(data.settings, r);
      if (!period) {
        warnings.push(`Skipped row for ${r.subject || 'subject'} on ${r.day}: no period or start time.`);
        continue;
      }
      const label = r.subject || r.subject_name || r.name || r.course || '';
      let subject = findSubject(r.subject_code || r.code || label);
      if (r.subject_code && r.subject_name) subject = findSubject(r.subject_code) || findSubject(r.subject_name);
      if (!subject) {
        subject = {
          id: uid('sub'),
          name: r.subject_name || label || 'Imported subject',
          code: r.subject_code || r.code || '',
          credits: 3,
          faculty: '',
          color: '',
          classesPerWeek: null,
          expectedClasses: null,
          carried: { a: 0, t: 0 },
        };
        data.subjects.push(subject);
        warnings.push(`Created new subject "${subject.name}" (3 credits default) — edit it if that's wrong.`);
      }
      const lab = /lab|practical/i.test(r.kind || r.type || '') || /lab/i.test(subject.name);
      cells.push({ day, periodId: period.id, subjectId: subject.id, lab });
    }
    return { cells, warnings };
  }

  function timetableToCSV(data) {
    const lines = ['day,period,start,end,subject_code,subject_name,kind'];
    const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (const day of Object.keys(data.timetable).map(Number).sort()) {
      const cells = data.timetable[String(day)] || {};
      for (const pid of Object.keys(cells).sort()) {
        const c = cells[pid];
        if (!c || !c.subjectId) continue;
        const s = data.subjects.find((x) => x.id === c.subjectId) || { name: '', code: '' };
        const p = data.settings.periods.find((x) => x.id === pid) || { label: pid, start: '', end: '' };
        lines.push([names[day] || day, p.label, p.start, p.end, s.code, s.name, c.lab ? 'lab' : 'lecture'].map(csvCell).join(','));
      }
    }
    return lines.join('\n');
  }

  function calendarToCSV(data) {
    const lines = ['type,start,end,title,swap_day'];
    for (const e of data.calendar.entries) lines.push([e.type, e.start, e.end, e.title, e.swapDay || ''].map(csvCell).join(','));
    return lines.join('\n');
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function parseLooseDate(value, fallbackYear) {
    const s = String(value || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    m = s.match(/^(\d{1,2})[\s\-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,\-]*(\d{4})?$/i);
    if (m) {
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const mo = months.indexOf(m[2].toLowerCase().slice(0, 3)) + 1;
      const y = m[3] || fallbackYear || new Date().getFullYear();
      return `${y}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
    return null;
  }

  function calendarFromCSV(text, year) {
    const { rows } = parseCSV(text);
    const warnings = [];
    const entries = [];
    for (const r of rows) {
      const start = parseLooseDate(r.start || r.date || r.from, year);
      if (!start) {
        warnings.push(`Skipped row with unreadable date "${r.start || r.date || ''}".`);
        continue;
      }
      const end = parseLooseDate(r.end || r.to, year) || start;
      const type = ['holiday', 'exam', 'suspended', 'working-swap'].indexOf(String(r.type || 'holiday').toLowerCase()) >= 0 ? String(r.type || 'holiday').toLowerCase() : 'holiday';
      entries.push({ id: uid('cal'), type, start, end: end < start ? start : end, title: r.title || r.name || r.reason || '', swapDay: dayNumber(r.swap_day || r.swapday || r.swap) || null, sourceId: null });
    }
    return { entries, warnings };
  }

  /** Minimal ICS reader: VEVENTs with all-day or datetime DTSTART/DTEND and a SUMMARY. */
  function calendarFromICS(text, year) {
    const lines = String(text).replace(/\r\n[ \t]/g, '').split(/\r?\n/);
    const entries = [];
    const warnings = [];
    let cur = null;
    const readDate = (v) => {
      const m = String(v).match(/(\d{4})(\d{2})(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      return parseLooseDate(v, year);
    };
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') cur = {};
      else if (line === 'END:VEVENT') {
        if (cur && cur.start) {
          let end = cur.end || cur.start;
          if (cur.end && end > cur.start) {
            // ICS DTEND is exclusive (a 15 Aug all-day holiday ends on the 16th); step back one day.
            // Timed single-day events have DTEND on the same date, so they take the other branch.
            const [y, m, d] = end.split('-').map(Number);
            const prev = new Date(Date.UTC(y, m - 1, d - 1));
            end = prev.toISOString().slice(0, 10);
          }
          if (end < cur.start) end = cur.start;
          const title = cur.summary || 'From ICS';
          const t = /holiday|leave|vacation|break|off|festival|pongal|diwali/i.test(title) ? 'holiday' : /exam|test|assessment/i.test(title) ? 'exam' : 'holiday';
          entries.push({ id: uid('cal'), type: t, start: cur.start, end, title, swapDay: null, sourceId: null });
        } else if (cur) warnings.push(`Skipped a VEVENT without a date${cur.summary ? ` (${cur.summary})` : ''}.`);
        cur = null;
      } else if (cur) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const key = line.slice(0, idx).split(';')[0].toUpperCase();
        const value = line.slice(idx + 1).trim();
        if (key === 'DTSTART') cur.start = readDate(value.split('/')[0]);
        else if (key === 'DTEND') cur.end = readDate(value.split('/')[0]);
        else if (key === 'SUMMARY') cur.summary = value.replace(/\\,/g, ',');
      }
    }
    return { entries, warnings };
  }

  const SAMPLE_TIMETABLE_CSV = [
    'day,period,subject_code,subject_name,kind',
    'Mon,P1,CS2001,Data Structures and Algorithms,lecture',
    'Mon,P2,MA2002,Discrete Mathematics,lecture',
    'Tue,P1,CS2001,Data Structures and Algorithms,lecture',
    'Tue,P3,CS2005,Database Systems,lecture',
    'Wed,P5,CS2001L,DSA Lab,lab',
    'Thu,P2,EC2003,Digital Design,lecture',
    'Fri,P4,CS2004,Object Oriented Programming,lecture',
    '',
    '# A lab row occupies two consecutive periods on the grid but counts as ONE class;',
    '# write it only on its first period (the grid merges the two).',
    '# Days: Mon-Sat (Sun is never a working day). Periods: P1-P6 by default.',
  ].join('\n');

  const SAMPLE_CALENDAR_CSV = [
    'type,start,end,title,swap_day',
    'holiday,2026-08-15,2026-08-15,Independence Day,',
    'holiday,2026-10-02,2026-10-02,Gandhi Jayanti,',
    'holiday,2026-10-20,2026-10-20,Dussehra,',
    'holiday,2026-11-08,2026-11-09,Diwali + Govardhan Puja,',
    'exam,2026-09-18,2026-09-25,Mid-term exams,',
    'working-swap,2026-09-10,2026-09-10,Thursday follows the Friday timetable,6',
    'suspended,2026-10-14,2026-10-14,Class suspended for institute event,',
    '',
    '# type: holiday | exam | suspended | working-swap',
    '# working-swap needs swap_day (1=Mon … 6=Sat): that date follows the named weekday\'s timetable.',
  ].join('\n');

  const api = {
    KEY,
    VERSION,
    uid,
    defaults,
    load,
    save,
    storageBytes,
    normalize,
    setStatus,
    addExtra,
    subjectUsage,
    exportJSON,
    importJSON,
    snapshotToCalendar,
    parseCSV,
    dayNumber,
    timetableFromCSV,
    timetableToCSV,
    calendarFromCSV,
    calendarToCSV,
    calendarFromICS,
    SAMPLE_TIMETABLE_CSV,
    SAMPLE_CALENDAR_CSV,
  };
  global.AD = global.AD || {};
  global.AD.Store = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Tests for the engine that everything else trusts: counting rules, scheduler, parsers.
 * Run: npm test  (node --test tests/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../js/calc.js');
await import('../js/store.js');
await import('../js/ocr.js');
await import('../js/manipal-calendar.js');
await import('../js/sample-data.js');
const { Calc, Store, Ocr, Sample } = globalThis.AD;

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function makeCtx(overrides = {}) {
  const data = Store.defaults();
  data.settings.semester = { name: 'test', start: '2026-07-27', end: '2026-08-09' }; // Mon 27 Jul -> Sun 9 Aug
  data.settings.threshold = 0.75;
  data.subjects = [
    { id: 'sub_a', name: 'Alpha', code: 'AA100', credits: 4, faculty: '', classesPerWeek: null, expectedClasses: null },
    { id: 'sub_b', name: 'Beta Lab', code: 'BB200', credits: 1, faculty: '', classesPerWeek: null, expectedClasses: null },
  ];
  data.timetable = { 1: { p1: { subjectId: 'sub_a' } }, 3: { p5: { subjectId: 'sub_b', lab: true } } };
  Object.assign(data, overrides.data || {});
  Object.assign(data.settings, overrides.settings || {});
  const ctx = { data, index: Calc.calendarIndex(data.calendar.entries, data.settings.semester.start, data.settings.semester.end) };
  return ctx;
}

test('date helpers: weekday, addDays, eachDay', () => {
  assert.equal(Calc.weekday('2026-07-27'), 1, '27 Jul 2026 is a Monday');
  assert.equal(Calc.weekday('2026-08-02'), 7, '2 Aug 2026 is a Sunday');
  assert.equal(Calc.addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(Calc.addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(Calc.eachDay('2026-07-27', '2026-08-09').length, 14);
  assert.deepEqual(Calc.eachDay('2026-08-09', '2026-07-27'), [], 'invalid range yields nothing');
});

test('scheduler: 1 cell = 1 class, labs count once, Sundays skipped', () => {
  const ctx = makeCtx();
  const a = Calc.scheduledSlots(ctx, 'sub_a');
  const b = Calc.scheduledSlots(ctx, 'sub_b');
  assert.equal(a.length, 2, 'Monday P1 in each of the two weeks');
  assert.equal(b.length, 2, 'Wednesday lab counts once per week, not once per period');
  assert.ok(b.every((s) => s.lab));
  assert.ok(Calc.scheduledSlots(ctx).length === 4);
});

test('calendar: holidays remove classes, exams count as no-class days, swaps change the weekday used', () => {
  const ctx = makeCtx({
    data: {
      calendar: {
        sources: [],
        entries: [
          { id: 'e1', type: 'holiday', start: '2026-08-03', end: '2026-08-03', title: 'Holiday' }, // Monday wk2
          { id: 'e2', type: 'exam', start: '2026-08-05', end: '2026-08-05', title: 'MTE' }, // Wednesday wk2 (lab day)
          { id: 'e3', type: 'working-swap', start: '2026-08-08', end: '2026-08-08', swapDay: 1, title: 'Saturday follows Monday' },
        ],
      },
    },
  });
  assert.equal(Calc.scheduledSlots(ctx, 'sub_a').length, 2, 'wk1 Monday + swapped Saturday holds a second Monday-style class');
  assert.equal(Calc.scheduledSlots(ctx, 'sub_b').length, 1, 'the lab on 5 Aug is cancelled by the exam window');
  const plan = Calc.dayPlan('2026-08-08', ctx);
  assert.equal(plan.teaching, true);
  assert.equal(plan.weekday, 1, 'swapped day uses Monday');
  const off = Calc.dayPlan('2026-08-03', ctx);
  assert.equal(off.teaching, false);
  assert.equal(off.off, true);
});

test('holiday wins over a swapped day on the same date', () => {
  const ctx = makeCtx({
    data: {
      calendar: {
        sources: [],
        entries: [
          { id: 'e1', type: 'holiday', start: '2026-08-08', end: '2026-08-08', title: 'Holiday' },
          { id: 'e2', type: 'working-swap', start: '2026-08-08', end: '2026-08-08', swapDay: 1, title: 'swap' },
        ],
      },
    },
  });
  assert.equal(Calc.dayPlan('2026-08-08', ctx).teaching, false);
});

test('stats: pct, safe buffer, must-attend-in-a-row, projections', () => {
  const ctx = makeCtx();
  const rec = (date, subjectId, status, extra = {}) => Object.assign({ id: `r${date}${status}${Math.random()}`, date, subjectId, slotKey: null, kind: 'extra', status, note: '', at: '' }, extra);
  // 10 present, 2 absent => t = 12, a = 10
  for (let i = 0; i < 10; i++) ctx.data.records.push(rec(`2026-07-${String(10 + i).padStart(2, '0')}`, 'sub_a', 'present'));
  ctx.data.records.push(rec('2026-07-01', 'sub_a', 'absent'));
  ctx.data.records.push(rec('2026-07-02', 'sub_a', 'absent'));
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.a, 10);
  assert.equal(s.t, 12);
  assert.ok(approx(s.pct, 10 / 12));
  assert.equal(s.buffer, Math.floor(10 / 0.75 - 12), 'safe misses = floor(a/p - t)');
  assert.equal(s.buffer, 1);
  assert.equal(s.mustAttend, 0, 'already above the threshold');
  assert.equal(s.usedMisses, 2);
  assert.equal(s.T, 2 + 12, 'T = the two timetable cells plus every extra class that was actually held');
  assert.equal(s.projectedWorst, 10 / s.T);

  // now push it below the threshold: 8 present, 4 absent
  ctx.data.records = [];
  for (let i = 0; i < 8; i++) ctx.data.records.push(rec(`2026-07-${String(10 + i).padStart(2, '0')}`, 'sub_a', 'present'));
  for (let i = 0; i < 4; i++) ctx.data.records.push(rec(`2026-07-0${i + 1}`, 'sub_a', 'absent'));
  const s2 = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.ok(approx(s2.pct, 8 / 12));
  assert.equal(s2.status, 'red');
  assert.equal(s2.buffer, 0);
  assert.equal(s2.mustAttend, Math.ceil((0.75 * 12 - 8) / 0.25), 'ceil((p*t - a)/(1 - p))');
  assert.equal(s2.mustAttend, 4);
  assert.equal(s2.maxMissTotal, Math.floor(0.25 * s2.T));
});

test('cancelled classes are excluded everywhere; leave follows the setting', () => {
  const ctx = makeCtx();
  const rec = (date, status) => ({ id: `r${date}${status}`, date, subjectId: 'sub_a', slotKey: null, kind: 'extra', status, note: '', at: '' });
  ctx.data.records.push(rec('2026-07-01', 'present'), rec('2026-07-02', 'absent'), rec('2026-07-03', 'cancelled'), rec('2026-07-04', 'leave'));
  let s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.t, 3, 'cancelled is not held; leave counts as absent by default');
  assert.equal(s.a, 1);
  ctx.data.settings.leaveMode = 'exclude';
  s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.t, 2, 'excluded leave behaves like a cancelled class');
  assert.equal(s.a, 1);
});

test('t = 0 is N/A, never a division by zero', () => {
  const ctx = makeCtx();
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.pct, null);
  assert.equal(s.buffer, null);
  assert.equal(s.status, 'none');
  assert.equal(s.mustAttend, 0);
  const overall = Calc.overallStats(ctx, [s]);
  assert.equal(overall.pct, null);
});

test('manual T overrides, credits fall back when there is no timetable', () => {
  const ctx = makeCtx();
  ctx.data.subjects.push({ id: 'sub_c', name: 'Gamma', code: 'CC300', credits: 3, classesPerWeek: null, expectedClasses: 40 });
  const stats = Calc.allStats(ctx);
  const c = stats.find((s) => s.subject.id === 'sub_c');
  assert.equal(c.TSource, 'manual');
  assert.equal(c.T, 40);

  const ctx2 = makeCtx({ data: { timetable: {} } });
  const s2 = Calc.subjectStats(ctx2.data.subjects[0], ctx2);
  assert.equal(s2.TSource, 'estimated', 'no timetable -> credits per week estimate');
  assert.equal(s2.T, Math.round((4 * Calc.countTeachingDays(ctx2)) / 6));
});

test('cancelling a scheduled class shrinks T', () => {
  const ctx = makeCtx();
  const base = Calc.subjectStats(ctx.data.subjects[0], ctx).T;
  ctx.data.records.push({ id: 'x1', date: '2026-07-27', subjectId: 'sub_a', slotKey: '1:p1', kind: 'lecture', status: 'cancelled', note: '', at: '' });
  assert.equal(Calc.subjectStats(ctx.data.subjects[0], ctx).T, base - 1);
});

test('what-if simulator and warnings', () => {
  const ctx = makeCtx();
  const rec = (date, status) => ({ id: `w${date}`, date, subjectId: 'sub_a', slotKey: null, kind: 'extra', status, note: '', at: '' });
  for (let i = 0; i < 9; i++) ctx.data.records.push(rec(`2026-07-${String(i + 1).padStart(2, '0')}`, 'present'));
  for (let i = 0; i < 3; i++) ctx.data.records.push(rec(`2026-08-0${i + 1}`, 'absent'));
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx); // 9/12 = 75%
  const eff = Calc.missEffect(s, 1, 0.75);
  assert.ok(approx(eff.pct, 9 / 13));
  assert.equal(eff.safe, false, 'one more miss drops below 75%');
  assert.ok(Calc.warnings(ctx).some((w) => w.text.includes('Alpha')));
  const stats = Calc.allStats(ctx);
  assert.equal(Calc.overallStats(ctx, stats).atRisk, 1);
});

test('threshold of 100%: nothing is safe and a missed class cannot be recovered', () => {
  const ctx = makeCtx({ settings: { threshold: 1 } });
  const rec = (date, status) => ({ id: `p${date}`, date, subjectId: 'sub_a', slotKey: null, kind: 'extra', status, note: '', at: '' });
  ctx.data.records.push(rec('2026-07-01', 'present'), rec('2026-07-02', 'absent')); // 1 of 2 held
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.pct, 0.5);
  assert.equal(s.buffer, 0, 'at a 100% requirement every remaining class is compulsory');
  assert.equal(s.mustAttend, null, 'recovery is impossible here, not Infinity');
  assert.equal(s.status, 'red');
  assert.equal(s.maxMissTotal, 0);
  const text = JSON.stringify(Calc.warnings(ctx));
  assert.ok(!/Infinity|NaN/.test(text), `no Infinity or NaN may reach user-facing text: ${text}`);
  assert.ok(Calc.warnings(ctx).some((w) => /cannot get back to 100%/.test(w.text)));

  // a perfect record at 100% must still divide cleanly and ask for nothing
  const clean = makeCtx({ settings: { threshold: 1 } });
  clean.data.records.push(rec('2026-07-03', 'present'));
  const cleanStats = Calc.subjectStats(clean.data.subjects[0], clean);
  assert.equal(cleanStats.mustAttend, 0);
  assert.equal(cleanStats.buffer, 0);
  assert.equal(cleanStats.pct, 1);
});

test('existing attendance: carried counts join every formula', () => {
  const ctx = makeCtx();
  // The college portal says 18 held / 12 attended for Alpha and 2 held / 1 attended for the lab
  // before the user started marking anything here.
  ctx.data.subjects[0].carried = { a: 12, t: 18 };
  ctx.data.subjects[1].carried = { a: 1, t: 2 };
  // then four Alpha classes since: three present, one absent (Mon–Thu of week 1)
  const rec = (date, status) => ({ id: `c${date}`, date, subjectId: 'sub_a', slotKey: null, kind: 'extra', status, note: '', at: '' });
  ctx.data.records.push(rec('2026-07-27', 'present'), rec('2026-07-28', 'present'), rec('2026-07-29', 'present'), rec('2026-07-30', 'absent'));
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.a, 15, 'attended = carried 12 + marked 3');
  assert.equal(s.t, 22, 'held = carried 18 + marked 4');
  assert.ok(approx(s.pct, 15 / 22));
  assert.equal(s.usedMisses, 7, 'the carried absences count as misses used');
  assert.equal(s.buffer, Math.max(0, Math.floor(15 / 0.75 - 22)), 'safe misses are computed on the combined counts');
  assert.equal(s.remaining, s.T - 22, 'the semester plan is not reset by the carried numbers');
  assert.equal(s.carried.a, 12);

  // the overall and credit-weighted totals see them too (Alpha 4 credits, lab 1 credit)
  const stats = Calc.allStats(ctx);
  const overall = Calc.overallStats(ctx, stats);
  assert.equal(overall.a, 16, '15 from Alpha + 1 carried in for the lab');
  assert.equal(overall.t, 24);
  assert.ok(approx(overall.creditPct, (4 * 15 + 1 * 1) / (4 * 22 + 1 * 2)), 'the credit-weighted figure includes carried classes');

  // the trend line ends exactly where the tiles point, and starts from the carried balance
  const line = Calc.trend(ctx);
  const all = Calc.allStats(ctx);
  assert.ok(line.length > 1);
  assert.equal(line[line.length - 1].a, all.reduce((n, x) => n + x.a, 0), 'the last point totals the same attended count');
  assert.equal(line[line.length - 1].t, all.reduce((n, x) => n + x.t, 0), 'and the same held count');
  assert.equal(line[0].a, 14, "the first point already carries the 12+1 balance plus that day's marked class");

  // the balance has no date, so no single day in the heatmap may claim it
  const friday = Calc.daySummary(ctx, '2026-07-31', '2026-07-31');
  assert.equal(friday.present, 0);
  assert.equal(friday.scheduled, 0);
  const monday = Calc.daySummary(ctx, '2026-07-27', '2026-07-31');
  assert.equal(monday.present, 1, 'only the class marked on that day counts on that day');
});

test('existing attendance: impossible pairs are clamped, never believed', () => {
  const ctx = makeCtx();
  ctx.data.subjects[0].carried = { a: 40, t: 12 }; // attended can never exceed held
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.carried.a, 12, 'attended is clamped to held for the maths');
  assert.equal(s.carried.t, 12);
  assert.equal(s.pct, 1);
  assert.ok(s.pct <= 1, 'a percentage above 100% is impossible');

  // negatives, floats and junk from a pasted backup are all repaired
  assert.deepEqual(Calc.carriedOf({ carried: { a: -5, t: -2 } }), { a: 0, t: 0 });
  assert.deepEqual(Calc.carriedOf({ carried: { a: '7.6', t: '9' } }), { a: 8, t: 9 });
  assert.deepEqual(Calc.carriedOf({ carried: { a: 'abc', t: null } }), { a: 0, t: 0 });
  assert.deepEqual(Calc.carriedOf({}), { a: 0, t: 0 }, 'a subject with no carried balance is fine');
  assert.deepEqual(Calc.carriedOf(undefined), { a: 0, t: 0 });
});

test('existing attendance survives a save/load round trip', () => {
  const data = Store.defaults();
  data.subjects.push({ id: 'x', name: 'Carried', code: 'CR1', credits: 3, carried: { a: 8, t: 12 } });
  const back = Store.normalize(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(back.subjects[0].carried, { a: 8, t: 12 });
  // a backup written by an older version has no carried field at all
  const legacy = Store.normalize({ subjects: [{ name: 'Old', code: 'O1', credits: 4 }] });
  assert.deepEqual(legacy.subjects[0].carried, { a: 0, t: 0 });
  // and junk is repaired on the way in
  const junk = Store.normalize({ subjects: [{ name: 'Junk', carried: { a: 'nonsense', t: -3 } }] });
  assert.deepEqual(junk.subjects[0].carried, { a: 0, t: 0 });
});

test('carried attendance larger than the semester plan raises T and says so', () => {
  const ctx = makeCtx();
  ctx.data.subjects[0].carried = { a: 3, t: 4 };
  // the plan for Alpha is 2 slots in this fixture, so 4 carried classes beat it
  const s = Calc.subjectStats(ctx.data.subjects[0], ctx);
  assert.equal(s.TAdjusted, true);
  assert.equal(s.TPlanned, 2, 'the plan that was too small is still reported');
  assert.equal(s.T, 4, 'T is raised so more classes are never held than planned');
  const text = Calc.warnings(ctx).map((w) => w.text).join(' ');
  assert.ok(/semester plan predicts 2 classes but 4 have been held/.test(text), text);
  assert.ok(/semester start at the real first day/.test(text), 'the warning tells you how to fix it');
});

test('bunkable today + unmarked-day reminder', () => {
  const ctx = makeCtx();
  const mono = Calc.dayPlan('2026-07-27', ctx);
  assert.equal(Calc.bunkable(ctx, '2026-07-27').total, 1);
  assert.equal(Calc.bunkable(ctx, '2026-07-27').safeCount, 0, 'nothing marked yet for Alpha -> no safe bunk');
  const reminder = Calc.unmarkedDay(ctx, '2026-07-28');
  assert.equal(reminder.date, '2026-07-27');
  assert.equal(mono.teaching, true);
});

/* ---------- store ---------- */
test('CSV parser handles quotes and CRLF', () => {
  const { headers, rows } = Store.parseCSV('a,b\r\n"x,1","say ""hi"""\r\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.deepEqual(rows[0], { a: 'x,1', b: 'say "hi"' });
});

test('timetable CSV import maps days/periods, flags labs, creates unknown subjects', () => {
  const data = Store.defaults();
  const csv = ['day,period,subject_code,subject_name,kind', 'Mon,P1,CS2001,Data Structures,lecture', 'Wed,P5,CS9999,Robotics Lab,lab', 'Funday,P1,CS2001,Data Structures,'].join('\n');
  const { cells, warnings } = Store.timetableFromCSV(csv, data);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells[0], { day: 1, periodId: 'p1', subjectId: data.subjects[0].id, lab: false });
  assert.equal(cells[1].lab, true);
  assert.equal(data.subjects.length, 2, 'unknown subject was created');
  assert.ok(warnings.some((w) => /Funday/.test(w)));
});

test('CSV exports round-trip back through the importers', () => {
  const data = Sample.build('2026-10-12');
  const csv = Store.timetableToCSV(data);
  assert.ok(csv.split('\n').length > 8, 'one row per assigned cell');
  const fresh = Store.defaults();
  fresh.subjects = data.subjects.map((s) => ({ ...s }));
  const res = Store.timetableFromCSV(csv, fresh);
  assert.equal(res.warnings.length, 0, 'exported CSV re-imports without complaints');
  assert.equal(res.cells.length, Object.values(data.timetable).reduce((n, day) => n + Object.keys(day).length, 0));
  assert.equal(res.cells.filter((c) => c.lab).length, 3, 'the three lab slots keep their lab flag');

  const calCsv = Store.calendarToCSV(data);
  const back = Store.calendarFromCSV(calCsv, 2026);
  assert.equal(back.entries.length, data.calendar.entries.length);
  assert.deepEqual(
    back.entries.filter((e) => e.type === 'working-swap').map((e) => [e.start, e.swapDay]),
    data.calendar.entries.filter((e) => e.type === 'working-swap').map((e) => [e.start, e.swapDay]),
  );
});

test('calendar CSV + ICS import', () => {
  const csv = ['type,start,end,title,swap_day', 'holiday,15/08/2026,,Independence Day,', 'exam,2026-09-18,2026-09-25,MTE,', 'working-swap,2026-09-10,,Thursday follows Friday,6'].join('\n');
  const { entries, warnings } = Store.calendarFromCSV(csv, 2026);
  assert.equal(warnings.length, 0);
  assert.equal(entries[0].start, '2026-08-15');
  assert.equal(entries[0].end, '2026-08-15');
  assert.equal(entries[1].type, 'exam');
  assert.equal(entries[2].swapDay, 6);

  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'SUMMARY:Gandhi Jayanti', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const parsed = Store.calendarFromICS(ics, 2026);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].start, '2026-10-02');
  assert.equal(parsed.entries[0].end, '2026-10-02', 'exclusive DTEND is stepped back');
  assert.equal(parsed.entries[0].type, 'holiday');
});

test('JSON import understands both backups and scraper snapshots', () => {
  const data = Store.defaults();
  const backup = Store.importJSON(Store.exportJSON(data));
  assert.equal(backup.kind, 'backup');
  const snap = Store.importJSON(JSON.stringify(globalThis.MANIPAL_CALENDAR));
  assert.equal(snap.kind, 'calendar');
  assert.ok(snap.snapshot.entries.length > 5);
  assert.ok(snap.snapshot.entries.some((e) => e.type === 'working-swap' && e.swapDay === 6));
  assert.equal(snap.snapshot.semester.start, '2026-07-23');
});

test('normalize repairs junk input instead of losing data', () => {
  const d = Store.normalize({ settings: { threshold: 'nonsense' }, subjects: [{ name: 'X' }], records: [{ date: '2026-01-01' }, { bad: true }] });
  assert.equal(d.settings.threshold, 0.75);
  assert.equal(d.subjects[0].credits, 3);
  assert.equal(d.records.length, 0, 'records without a subject are dropped');
});

/* ---------- OCR parsers ---------- */
const word = (text, x0, y0, x1, y1, confidence = 90) => ({ text, bbox: { x0, y0, x1, y1 }, confidence });

test('OCR grid: days as columns, cells matched to subjects', () => {
  const words = [
    word('Mon', 90, 5, 130, 25), word('Tue', 190, 5, 230, 25), word('Wed', 290, 5, 330, 25),
    word('09:00-10:00', 20, 45, 80, 60), word('10:00-11:00', 20, 95, 80, 110),
    word('CS2001', 95, 48, 150, 62), word('MA 2002', 195, 98, 250, 112), word('DBMS', 295, 98, 340, 112),
  ];
  const grid = Ocr.gridFromWords(words);
  assert.equal(grid.ok, true);
  assert.equal(grid.orientation, 'days-as-columns');
  assert.equal(grid.cells.length, 3);
  const mon = grid.cells.find((c) => c.day === 1 && c.time === '09:00-10:00');
  assert.equal(mon.text, 'CS2001');
  const subjects = [{ id: 's1', name: 'Data Structures', code: 'CS2001', faculty: '' }, { id: 's2', name: 'Discrete Mathematics', code: 'MA2002', faculty: '' }];
  const parsed = Ocr.parseTimetable(words, subjects);
  const r1 = parsed.rows.find((r) => r.day === 1 && r.time === '09:00-10:00');
  assert.equal(r1.match.subjectId, 's1');
  assert.equal(r1.state, 'matched');
  const r3 = parsed.rows.find((r) => r.day === 3);
  assert.equal(r3.state, 'unmatched', 'unmatched text is flagged, never guessed');
});

test('OCR grid: days as rows works too', () => {
  const words = [
    word('Mon', 5, 45, 45, 60), word('Tue', 5, 95, 45, 110),
    word('9:00', 90, 10, 130, 25), word('10:00', 190, 10, 235, 25),
    word('DSA', 95, 48, 130, 62), word('DBMS', 195, 98, 235, 112),
  ];
  const grid = Ocr.gridFromWords(words);
  assert.equal(grid.ok, true);
  assert.equal(grid.orientation, 'days-as-rows');
  assert.equal(grid.cells.find((c) => c.day === 2 && c.time === '10:00').text, 'DBMS');
});

test('OCR fuzzy matching prefers an exact subject code, scores partial names lower', () => {
  const subjects = [{ id: 's1', name: 'Operating Systems', code: 'CS3002', faculty: 'Dr. Iyer' }];
  assert.equal(Ocr.fuzzyMatch('CS3002', subjects).matched, true);
  assert.equal(Ocr.fuzzyMatch('CS3002', subjects).confidence, 'good');
  assert.equal(Ocr.fuzzyMatch('Operating System', subjects).subjectId, 's1');
  assert.equal(Ocr.fuzzyMatch('zzzz qqqq', subjects).matched, false);
});

test('OCR preprocessing: the crop is mapped back through the rotation', () => {
  // identity: no rotation, no surprises
  assert.deepEqual(Ocr.sourceRect(200, 100, 0, [0, 0, 1, 1]), { x: 0, y: 0, w: 200, h: 100 });
  assert.deepEqual(Ocr.sourceRect(200, 100, 0, [0, 0, 0.5, 1]), { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(Ocr.sourceRect(200, 100, 0, [0.6, 0.5, 1, 1]), { x: 120, y: 50, w: 80, h: 50 });

  // a full-frame crop covers the whole source no matter how it is turned
  for (const rot of [0, 90, 180, 270, -90, 450]) {
    assert.deepEqual(Ocr.sourceRect(200, 100, rot, [0, 0, 1, 1]), { x: 0, y: 0, w: 200, h: 100 }, `rot ${rot}`);
  }

  // the crop sliders are read off the rotated preview, so a quarter turn swaps the axes:
  // the left half of a 90° clockwise turn is the bottom half of the file, and vice versa at 270°.
  assert.deepEqual(Ocr.sourceRect(200, 100, 90, [0, 0, 0.5, 1]), { x: 0, y: 50, w: 200, h: 50 });
  assert.deepEqual(Ocr.sourceRect(200, 100, 270, [0, 0, 0.5, 1]), { x: 0, y: 0, w: 200, h: 50 });
  // 180° mirrors both axes, so the left half comes from the right half of the source
  assert.deepEqual(Ocr.sourceRect(200, 100, 180, [0, 0, 0.5, 1]), { x: 100, y: 0, w: 100, h: 100 });

  // whatever the rotation and crop, the mapped rectangle must stay inside the source image
  for (const rot of [0, 90, 180, 270]) {
    for (const crop of [[0, 0, 1, 1], [0.25, 0.25, 0.75, 0.75], [0, 0, 0.5, 1], [0.5, 0, 1, 1], [0, 0.5, 1, 1]]) {
      const r = Ocr.sourceRect(200, 100, rot, crop);
      const label = `rot ${rot} crop ${crop} -> ${JSON.stringify(r)}`;
      assert.ok(r.x >= -0.001 && r.y >= -0.001, `escapes the top-left corner: ${label}`);
      assert.ok(r.x + r.w <= 200.001 && r.y + r.h <= 100.001, `escapes the bottom-right corner: ${label}`);
    }
  }
});

test('OCR calendar dates: many formats, types, and cross-year rollover', () => {
  const rows = Ocr.parseDates(
    ['Independence Day 15 August 2026', 'Mid-term exams 18th - 25th September', 'Diwali 8 Nov', 'Holiday 15/08/2026', 'Examination 10-3-2026', 'Friday timetable 14 October 2026'],
    { year: 2026, firstMonth: 7 },
  );
  const find = (t) => rows.find((r) => r.start === t);
  assert.ok(find('2026-08-15'));
  assert.equal(find('2026-08-15').type, 'holiday');
  assert.equal(find('2026-09-18').end, '2026-09-25');
  assert.equal(find('2026-09-18').type, 'exam');
  assert.equal(find('2026-11-08').type, 'holiday');
  assert.ok(find('2026-03-10'), 'explicit numeric year wins over rollover');
  const swap = rows.find((r) => r.type === 'working-swap');
  assert.equal(swap.start, '2026-10-14');
  assert.equal(swap.swapDay, 5);
});

test('bundled Manipal calendar matches the published PDF', () => {
  const snap = globalThis.MANIPAL_CALENDAR;
  assert.equal(snap.source.url, 'https://jaipur.manipal.edu/img/pdf/academicrules/AC-calender-2026-27.pdf');
  assert.deepEqual(snap.semester, { name: 'Odd semester 2026', start: '2026-07-23', end: '2026-11-13' });
  const holidays = snap.entries.filter((e) => e.type === 'holiday').map((e) => e.start);
  for (const d of ['2026-08-15', '2026-10-02', '2026-10-20', '2026-11-08', '2026-11-09', '2026-11-11']) assert.ok(holidays.includes(d), `missing holiday ${d}`);
  assert.equal(snap.entries.filter((e) => e.type === 'exam').length, 2);
  assert.deepEqual(snap.entries.filter((e) => e.type === 'working-swap').map((e) => [e.start, e.swapDay]), [['2026-09-10', 6], ['2026-10-14', 6]]);
});

/* ---------- sample dataset ---------- */
test('sample data is internally consistent and exercises the real scheduler', () => {
  const data = Sample.build('2026-10-12');
  const ctx = { data, index: Calc.calendarIndex(data.calendar.entries, data.settings.semester.start, data.settings.semester.end) };
  assert.equal(data.subjects.length, 7);
  assert.ok(data.records.length > 200, `expected a few hundred records, got ${data.records.length}`);
  // every record must sit on a teaching day and belong to a scheduled class or be an extra
  for (const r of data.records) {
    if (r.kind === 'extra' || !r.slotKey) continue;
    assert.ok(Calc.dayPlan(r.date, ctx).teaching, `${r.date} should be a teaching day`);
  }
  // no records on a holiday
  const holiday = data.calendar.entries.find((e) => e.type === 'holiday' && e.start > data.settings.semester.start);
  assert.ok(holiday, 'bundled calendar supplied holidays');
  assert.equal(data.records.filter((r) => r.date >= holiday.start && r.date <= (holiday.end || holiday.start)).length, 0);
  // each lab day produces exactly one record for that lab slot
  const labRecs = data.records.filter((r) => r.kind === 'lab');
  assert.ok(labRecs.length > 5);
  assert.ok(labRecs.every((r) => r.slotKey && r.slotKey.indexOf(':p5') > 0));
  // at least one subject is below the threshold and one comfortably safe (a useful demo)
  const stats = Calc.allStats(ctx);
  assert.ok(stats.some((s) => s.status === 'red'), 'demo has an at-risk subject');
  assert.ok(stats.some((s) => s.status === 'green'), 'demo has a safe subject');
  // today itself is intentionally unmarked so the Today view opens with work to do
  assert.equal(Calc.daySummary(ctx, '2026-10-12').kind, 'unmarked');
  assert.equal(Calc.unmarkedDay(ctx, '2026-10-12'), null, 'nothing older than today is unmarked in the demo');
  // and if the user forgets a day, the reminder finds it
  const victims = data.records.filter((r) => r.date === '2026-10-10');
  assert.ok(victims.length, 'demo marks Saturday 10 Oct');
  data.records = data.records.filter((r) => r.date !== '2026-10-10');
  assert.equal(Calc.unmarkedDay(ctx, '2026-10-12').date, '2026-10-10');
});

/* Tests for the natural-language timetable entry (js/magic.js).
 * Run: npm test  (node --test tests/)
 *
 * The point of these is the promise the panel makes to the user: everything the parser understood is
 * shown before it is added, and everything it had to *guess* is flagged. So the assertions are about
 * resolved cells and about warnings appearing exactly when something was assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../js/calc.js');
await import('../js/store.js');
await import('../js/ocr.js');
await import('../js/magic.js');
const { Magic, Store, Calc } = globalThis.AD;

function makeData() {
  const data = Store.defaults();
  data.subjects = [
    { id: 'sub_dsa', name: 'Data Structures and Algorithms', code: 'CS2001', credits: 4, faculty: 'Dr. Anitha Rao' },
    { id: 'sub_ma', name: 'Discrete Mathematics', code: 'MA2002', credits: 3, faculty: '' },
    { id: 'sub_db', name: 'Database Systems', code: 'CS2005', credits: 4, faculty: '' },
    { id: 'sub_oo', name: 'Object Oriented Programming', code: 'CS2004', credits: 3, faculty: '' },
    { id: 'sub_lab', name: 'DSA Lab', code: 'CS2001L', credits: 1, faculty: '' },
  ];
  return data;
}

const slot = (row) => `${row.day}:${row.periodId}`;

test('magic: a subject is placed on the days and periods it names', () => {
  const data = makeData();
  const { rows, warnings, error } = Magic.parse('CS2001 Mon 9-10, Wed 11-12', data);
  assert.equal(error, null);
  assert.deepEqual(rows.map(slot), ['1:p1', '3:p3'], 'Mon 09:00 is P1 and Wed ends 12:00, which is P3');
  assert.deepEqual(rows.map((r) => r.subjectId), ['sub_dsa', 'sub_dsa']);
  assert.deepEqual(rows.map((r) => r.state), ['matched', 'matched']);
  assert.deepEqual(warnings, [], 'nothing was guessed, so nothing is complained about');
  assert.deepEqual(data.timetable, {}, 'parsing never writes');
});

test('magic: a day range expands over the week', () => {
  const data = makeData();
  const { rows } = Magic.parse('Mon-Fri P1 Data Structures', data);
  assert.deepEqual(rows.map(slot), ['1:p1', '2:p1', '3:p1', '4:p1', '5:p1']);
  assert.ok(rows.every((r) => r.subjectId === 'sub_dsa'), 'matched on partial words, not on the code alone');
  assert.ok(rows.every((r) => r.how === 'label'));
});

test('magic: a day column fills the periods in order and says so', () => {
  const data = makeData();
  const { rows, warnings } = Magic.parse('Mon: CS2001, MA2002, CS2005', data);
  assert.deepEqual(rows.map(slot), ['1:p1', '1:p2', '1:p3']);
  assert.deepEqual(rows.map((r) => r.subjectId), ['sub_dsa', 'sub_ma', 'sub_db']);
  assert.ok(rows.every((r) => r.assumed), 'every row in a guess-the-time column is marked assumed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Mon: no times given, so P1, P2 and P3 were filled in order/);
});

test('magic: one time for several days applies to all of them', () => {
  const data = makeData();
  const { rows } = Magic.parse('CS2005 Mon, Wed, Fri 10-11', data);
  assert.deepEqual(rows.map(slot), ['1:p2', '3:p2', '5:p2']);
  assert.ok(rows.every((r) => r.subjectId === 'sub_db'));
});

test('magic: a bare follow-up keeps the day and the time it belongs to', () => {
  const data = makeData();
  const { rows } = Magic.parse('CS2001 Mon 9-10\nWed', data);
  assert.deepEqual(rows.map(slot), ['1:p1', '3:p1']);
  assert.equal(rows[1].how, 'same');
  assert.ok(rows[1].assumed, 'the inherited time is flagged, not presented as if it was typed');
  assert.equal(rows[1].subjectId, 'sub_dsa');
});

test('magic: a bare “lab” marks the same subject as a lab on another day', () => {
  const data = makeData();
  const { rows, warnings } = Magic.parse('CS2001 Mon 9-10, Fri P2 lab', data);
  assert.deepEqual(rows.map(slot), ['1:p1', '5:p2']);
  assert.equal(rows[1].subjectId, 'sub_dsa', 'the name carries over instead of being read as “lab”');
  assert.equal(rows[1].lab, true);
  assert.equal(rows[0].lab, false);
  assert.deepEqual(warnings, []);
});

test('magic: days and times pair up when both are listed', () => {
  const data = makeData();
  const { rows, warnings } = Magic.parse('CS2001 Mon 9-10 and Wed 11-12', data);
  assert.deepEqual(rows.map(slot), ['1:p1', '3:p3']);
  assert.deepEqual(warnings, []);
});

test('magic: an afternoon time is read as afternoon', () => {
  const data = makeData();
  const { rows } = Magic.parse('DSA Lab Thu 2-4', data);
  assert.deepEqual(rows.map(slot), ['4:p5'], '2-4 is 14:00, P5');
  assert.equal(rows[0].lab, true, 'the word “Lab” marks the slot as a lab');
  assert.equal(rows[0].subjectId, 'sub_lab');
  const { rows: evening } = Magic.parse('CS2004 Fri 3:30', data);
  assert.deepEqual(evening.map(slot), ['5:p6'], '3:30 falls inside P6 (15:00-15:55)');
  assert.equal(evening[0].how, 'inside', 'and the preview can say the time was rounded');
});

test('magic: a spoken period and a lone number both mean a period', () => {
  const data = makeData();
  const p3 = Magic.parse('Tue 3rd period CS2001', data).rows;
  assert.deepEqual(p3.map(slot), ['2:p3']);
  const p2 = Magic.readItem('Mon 2', data.settings.periods);
  assert.equal(p2.specs[0].period.id, 'p2');
  const p5 = Magic.parse('Mon period 5 CS2004', data).rows;
  assert.deepEqual(p5.map(slot), ['1:p5']);
});

test('magic: an unknown subject is handed back for a decision, never guessed', () => {
  const data = makeData();
  const { rows } = Magic.parse('Mon 9-10 CHEM9999', data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'unmatched');
  assert.equal(rows[0].subjectId, null);
  assert.equal(rows[0].text, 'CHEM9999');
  assert.equal(data.subjects.length, 5, 'no subject is invented by the parser');
});

test('magic: a partial subject name is offered, a rough one is flagged as unsure', () => {
  const data = makeData();
  // same matcher the OCR review uses: a distinctive shared word is a good match
  const partial = Magic.parse('Mon 9-10 Discrete Maths', data).rows[0];
  assert.equal(partial.subjectId, 'sub_ma');
  assert.equal(partial.state, 'matched');
  // a near-miss is pre-selected but marked unsure, so the preview stays honest about it
  data.subjects.push({ id: 'sub_phy', name: 'Physics Lab', code: '', credits: 1, faculty: '' });
  const rough = Magic.parse('Mon 9-10 Phys Lab', data).rows[0];
  assert.equal(rough.subjectId, 'sub_phy');
  assert.equal(rough.state, 'low');
});

test('magic: lines it cannot place are explained instead of dropped', () => {
  const data = makeData();
  const noDay = Magic.parse('CS2001 9-10', data);
  assert.equal(noDay.rows.length, 0);
  assert.match(noDay.warnings[0], /doesn't name a day/);
  assert.ok(noDay.error, 'the box says what to do next');

  const noTime = Magic.parse('CS2001 Tue', data);
  assert.equal(noTime.rows.length, 0);
  assert.match(noTime.warnings[0], /no time — add “9-10” or “P2”/);

  const sunday = Magic.parse('Sun 9-10 CS2001', data);
  assert.equal(sunday.rows.length, 0);
  assert.match(sunday.warnings[0], /Sunday is not one of your school days/);
  assert.match(sunday.error, /Sunday/);
});

test('magic: a repeated slot keeps the last one and reports the clash', () => {
  const data = makeData();
  const { rows, warnings } = Magic.parse('Mon P1 CS2001, Mon P1 MA2002', data);
  assert.deepEqual(rows.map(slot), ['1:p1']);
  assert.equal(rows[0].subjectId, 'sub_ma', 'the later instruction wins');
  assert.equal(warnings.filter((w) => /given twice/.test(w)).length, 1);
});

test('magic: a lab in the last period is called out', () => {
  const data = makeData();
  const { warnings } = Magic.parse('CS2001 Sat P6 lab', data);
  assert.ok(warnings.some((w) => /last period of the day/.test(w)));
});

test('magic: apply writes the same cells the grid editor writes', () => {
  const data = makeData();
  const { rows } = Magic.parse('CS2001 Mon 9-10, DSA Lab Thu 2-4\nWed 11-12 CHEM9999', data);
  assert.equal(rows.length, 3, 'two good rows and one that still needs a subject');
  const res = Magic.apply(rows, data);
  assert.equal(res.applied, 2, 'the unmatched row is not written');
  assert.equal(res.skipped, 1, '…but it is counted, so the panel can report it');
  assert.deepEqual(data.timetable, {
    1: { p1: { subjectId: 'sub_dsa', lab: false } },
    4: { p5: { subjectId: 'sub_lab', lab: true } },
  });

  // and the app's own scheduler reads them straight back out
  data.settings.semester = { name: 't', start: '2026-07-27', end: '2026-08-09' };
  const ctx = { data, index: Calc.calendarIndex(data.calendar.entries, data.settings.semester.start, data.settings.semester.end) };
  const monday = Calc.dayPlan('2026-07-27', ctx);
  assert.equal(monday.teaching, true);
  assert.deepEqual(Calc.cellsForDay(data.timetable, monday.weekday).map((c) => c.subjectId), ['sub_dsa']);
  assert.deepEqual(Calc.cellsForDay(data.timetable, 4).map((c) => [c.periodId, c.lab]), [['p5', true]]);
});

test('magic: empty input and junk feedback stay quiet', () => {
  const data = makeData();
  const blank = Magic.parse('   \n ', data);
  assert.equal(blank.error, null, 'an untouched box shows the on-ramp hint, not an error');
  assert.deepEqual(blank.rows, []);
  const junk = Magic.parse('hello there', data);
  assert.equal(junk.rows.length, 0);
  assert.ok(junk.error);
});

test('magic: the examples in the panel all resolve on the sample dataset', () => {
  const data = Store.defaults();
  data.subjects = [
    { id: 's1', name: 'Data Structures and Algorithms', code: 'CS2001', credits: 4, faculty: '' },
    { id: 's2', name: 'Discrete Mathematics', code: 'MA2002', credits: 3, faculty: '' },
    { id: 's3', name: 'Database Systems', code: 'CS2005', credits: 4, faculty: '' },
    { id: 's4', name: 'Object Oriented Programming', code: 'CS2004', credits: 3, faculty: '' },
    { id: 's5', name: 'DSA Lab', code: 'CS2001L', credits: 1, faculty: '' },
  ];
  for (const example of Magic.EXAMPLES) {
    const { rows, error } = Magic.parse(example.text, data);
    assert.ok(!error, `${example.text} → ${error}`);
    assert.ok(rows.length, `${example.text} produced no rows`);
    assert.ok(rows.every((r) => r.state === 'matched'), `${example.text} should resolve cleanly, got ${rows.map((r) => r.state).join(',')}`);
  }
});

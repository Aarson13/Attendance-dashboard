/* Tests for the home page's data layer: the percentage formula, the configurable 75% minimum, the
 * colour bands and the recovery/safe-miss maths — the numbers the landing page draws.
 * Run: npm test  (node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMBER_BAND_PCT,
  MIN_ATTENDANCE_PCT,
  SUBJECTS,
  TODAY_CLASSES,
  TREND,
  alerts,
  bandOf,
  classesNeededToReach,
  overall,
  pct,
  safeMisses,
  subjectPct,
} from '../src/data/attendance.js';

test('attendance percentage is attended / total × 100, and never NaN', () => {
  assert.equal(pct(30, 40), 75);
  assert.equal(pct(0, 0), 0, 'nothing held yet reads as 0, not NaN');
  assert.equal(pct(0, 5), 0);
  for (const subject of SUBJECTS) {
    const value = subjectPct(subject);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 100, `${subject.code} is in range`);
  }
});

test('the minimum is configurable and moves the three colour bands with it', () => {
  assert.equal(MIN_ATTENDANCE_PCT, 75);
  assert.equal(AMBER_BAND_PCT, 5);
  assert.equal(bandOf(76), 'ok');
  assert.equal(bandOf(75), 'ok', 'exactly at the minimum is safe');
  assert.equal(bandOf(74.9), 'warn');
  assert.equal(bandOf(70), 'warn', 'the amber band starts 5 points below the minimum');
  assert.equal(bandOf(69.9), 'low');
  // raising the minimum moves the whole band, rather than leaving 75 hard-coded
  assert.equal(bandOf(81, 80), 'ok');
  assert.equal(bandOf(78, 80), 'warn');
  assert.equal(bandOf(74, 80), 'low');
});

test('classes needed to recover use the same formula as the tracker engine', () => {
  // 30/42 = 71.4% → ceil((0.75×42 − 30) / (1 − 0.75)) = 6
  assert.equal(classesNeededToReach(30, 42), 6);
  assert.equal(classesNeededToReach(30, 40), 0, 'already at the minimum');
  assert.equal(classesNeededToReach(35, 40, 90), 10, 'ceil((0.9×40 − 35) / 0.1)');
  assert.equal(classesNeededToReach(30, 30, 100), 0);
  assert.equal(classesNeededToReach(24, 30, 100), null, 'a 100% minimum cannot be recovered from');
});

test('safe misses are whole classes and never negative', () => {
  assert.equal(safeMisses(36, 40), 8, 'floor(36 / 0.75 − 40)');
  assert.equal(safeMisses(30, 40), 0, 'exactly at the minimum leaves no room');
  assert.equal(safeMisses(30, 42), 0, 'already below the minimum clamps to 0, not a negative');
  assert.equal(safeMisses(24, 30, 100), 0);
});

test('overall figures are pooled from the counts, not averaged from the percentages', () => {
  const totals = overall();
  const attended = SUBJECTS.reduce((n, s) => n + s.attended, 0);
  const total = SUBJECTS.reduce((n, s) => n + s.total, 0);

  assert.equal(totals.attended, attended);
  assert.equal(totals.total, total);
  assert.equal(totals.missed, total - attended);
  assert.ok(Math.abs(totals.pct - (attended / total) * 100) < 1e-9, 'Σ attended / Σ held');
  assert.ok(totals.pct <= Math.max(...SUBJECTS.map(subjectPct)) + 1e-9, 'a pooled rate cannot beat every subject');
  assert.ok(totals.pct >= Math.min(...SUBJECTS.map(subjectPct)) - 1e-9);
  assert.ok(totals.bunkable >= 0);
});

test('the placeholder data is internally consistent', () => {
  const codes = new Set(SUBJECTS.map((s) => s.code));
  assert.equal(codes.size, SUBJECTS.length, 'subject codes are unique');

  for (const subject of SUBJECTS) {
    assert.ok(Number.isInteger(subject.attended) && Number.isInteger(subject.total), `${subject.code} counts whole classes`);
    assert.ok(subject.total > 0, `${subject.code} has held classes`);
    assert.ok(subject.attended >= 0 && subject.attended <= subject.total, `${subject.code} cannot attend more than was held`);
    assert.ok(subject.faculty, `${subject.code} names a faculty member`);
  }

  const statuses = new Set(['present', 'absent', 'cancelled', 'upcoming']);
  for (const item of TODAY_CLASSES) {
    assert.ok(statuses.has(item.status), `unknown status "${item.status}"`);
    assert.ok(codes.has(item.code), `${item.code} is one of the subjects`);
    assert.match(item.time, /^\d{2}:\d{2}$/);
  }

  assert.ok(TREND.length >= 2, 'a trend needs at least two points');
  assert.ok(
    TREND.every((point) => Number.isFinite(point.pct) && point.pct >= 0 && point.pct <= 100),
    'every trend point is a real percentage',
  );
});

test('alerts list only subjects under the minimum, worst first', () => {
  const list = alerts();
  const expected = SUBJECTS.filter((s) => subjectPct(s) < MIN_ATTENDANCE_PCT);

  assert.equal(list.length, expected.length);
  for (const subject of list) {
    assert.ok(subjectPct(subject) < MIN_ATTENDANCE_PCT);
    assert.ok(subject.band === 'warn' || subject.band === 'low');
    assert.ok(subject.needed === null || subject.needed > 0, 'a listed subject needs classes to recover');
  }
  const values = list.map((s) => s.pct);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'worst first');
});

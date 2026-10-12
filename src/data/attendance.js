/**
 * Placeholder attendance data for the home-page preview.
 *
 * Every percentage on the home page comes from these numbers, never from markup: attendance % is
 * `attended / total × 100`, and the configurable minimum is MIN_ATTENDANCE_PCT (75% — the same
 * default the tracker app uses). Swapping this file for a real API response is the whole wiring job.
 */

/** Minimum attendance a student must keep, in percent. Configurable in one place. */
export const MIN_ATTENDANCE_PCT = 75;

/**
 * Width of the amber band, in percentage points below the minimum. The brief asks for
 * "green ≥75%, amber 70–75%, red <70%", which is exactly this band with the default minimum; tie it
 * to the minimum rather than to 75 so raising MIN_ATTENDANCE_PCT keeps the three states coherent.
 */
export const AMBER_BAND_PCT = 5;

export const SUBJECTS = [
  { code: 'CS2001', name: 'Data Structures & Algorithms', faculty: 'Dr. Anitha Rao', attended: 34, total: 36 },
  { code: 'CS2002', name: 'Database Systems', faculty: 'Dr. P. Shetty', attended: 27, total: 32 },
  { code: 'MA2002', name: 'Discrete Mathematics', faculty: 'Dr. S. Nair', attended: 19, total: 28 },
  { code: 'EC2003', name: 'Digital Design', faculty: 'Dr. K. Iyer', attended: 21, total: 30 },
  { code: 'CS2004', name: 'Object Oriented Programming', faculty: 'Prof. R. Menon', attended: 25, total: 26 },
  { code: 'CS2001L', name: 'DSA Lab', faculty: 'Dr. Anitha Rao', attended: 11, total: 12 },
];

/** Today's classes, in timetable order. `status` drives the chips. */
export const TODAY_CLASSES = [
  { time: '09:00', code: 'CS2001', name: 'Data Structures & Algorithms', kind: 'Lecture', room: 'AB-204', status: 'present' },
  { time: '10:00', code: 'MA2002', name: 'Discrete Mathematics', kind: 'Lecture', room: 'AB-107', status: 'absent' },
  { time: '11:05', code: 'CS2002', name: 'Database Systems', kind: 'Lecture', room: 'AB-204', status: 'present' },
  { time: '12:05', code: 'CS2004', name: 'Object Oriented Programming', kind: 'Lab', room: 'Lab-3', status: 'cancelled' },
  { time: '14:00', code: 'EC2003', name: 'Digital Design', kind: 'Lecture', room: 'AB-301', status: 'upcoming' },
];

/** Weekly cumulative attendance %, oldest first — one point per teaching week. */
export const TREND = [
  { label: 'W1', pct: 96 },
  { label: 'W2', pct: 92 },
  { label: 'W3', pct: 88 },
  { label: 'W4', pct: 84 },
  { label: 'W5', pct: 86 },
  { label: 'W6', pct: 82 },
  { label: 'W7', pct: 80 },
  { label: 'W8', pct: 79 },
  { label: 'W9', pct: 83 },
  { label: 'W10', pct: 81 },
  { label: 'W11', pct: 84 },
  { label: 'W12', pct: 86 },
];

/* ------------------------------------------------------------------ helpers */

/** Attendance percentage, 0 when nothing has been held yet (never NaN). */
export function pct(attended, total) {
  return total > 0 ? (attended / total) * 100 : 0;
}

/** Percentage for one subject row. */
export function subjectPct(subject) {
  return pct(subject.attended, subject.total);
}

/** 'ok' (green) | 'warn' (amber) | 'low' (red) for a percentage, against the configured minimum. */
export function bandOf(value, min = MIN_ATTENDANCE_PCT) {
  if (value >= min) return 'ok';
  return value >= min - AMBER_BAND_PCT ? 'warn' : 'low';
}

/**
 * Classes that must be attended in a row for `attended / total` to reach the minimum:
 * ceil((p·t − a) / (1 − p)) — the same formula as the tracker's engine (js/calc.js).
 * Returns null when the minimum is 100% and a class has already been missed, because no number of
 * future classes can recover it.
 */
export function classesNeededToReach(attended, total, min = MIN_ATTENDANCE_PCT) {
  const p = min / 100;
  if (pct(attended, total) >= min) return 0;
  if (p >= 1) return null;
  // Dividing floats can land a hair above an exact integer — 0.9 × 40 − 35 is 1.000000000000004, so
  // the answer to a 10-class recovery computes as 11. A tiny epsilon keeps "attend 10 in a row" true.
  return Math.ceil((p * total - attended) / (1 - p) - 1e-9);
}

/** Classes that can still be missed without dropping below the minimum (never negative). */
export function safeMisses(attended, total, min = MIN_ATTENDANCE_PCT) {
  const p = min / 100;
  if (p <= 0) return 0;
  return Math.max(0, Math.floor(attended / p - total));
}

/** Totals for the stat row: overall % is Σ attended / Σ held, not the average of the subject rows. */
export function overall(subjects = SUBJECTS, min = MIN_ATTENDANCE_PCT) {
  const attended = subjects.reduce((n, s) => n + s.attended, 0);
  const total = subjects.reduce((n, s) => n + s.total, 0);
  return {
    attended,
    total,
    missed: total - attended,
    pct: pct(attended, total),
    bunkable: subjects.reduce((n, s) => n + safeMisses(s.attended, s.total, min), 0),
  };
}

/** Subjects under the minimum, worst first, with the classes needed to recover. */
export function alerts(subjects = SUBJECTS, min = MIN_ATTENDANCE_PCT) {
  return subjects
    .filter((s) => subjectPct(s) < min)
    .map((s) => ({
      ...s,
      pct: subjectPct(s),
      band: bandOf(subjectPct(s), min),
      needed: classesNeededToReach(s.attended, s.total, min),
    }))
    .sort((a, b) => a.pct - b.pct);
}

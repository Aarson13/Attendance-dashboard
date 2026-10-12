import GlassCard from './GlassCard.jsx';
import Ring from './Ring.jsx';
import { MIN_ATTENDANCE_PCT, SUBJECTS, bandOf, pct } from '../data/attendance.js';

export default function SubjectRings() {
  return (
    <GlassCard as="section" id="subjects" index={4} className="p-6 lg:col-span-7" aria-labelledby="subjects-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight" id="subjects-title">
          Subject-wise attendance
        </h2>
        <p className="text-xs text-muted">
          green ≥ {MIN_ATTENDANCE_PCT}% · amber ≤ {MIN_ATTENDANCE_PCT}% · red under {MIN_ATTENDANCE_PCT - 5}%
        </p>
      </div>

      <ul className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {SUBJECTS.map((subject) => {
          const value = pct(subject.attended, subject.total);
          return (
            <li className="flex items-center gap-4" key={subject.code}>
              <Ring value={value} band={bandOf(value)} />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">{subject.name}</p>
                <p className="truncate text-xs text-muted">
                  {subject.code} · {subject.faculty}
                </p>
                <p className="mt-1 text-xs text-muted tabular-nums">
                  {subject.attended} attended / {subject.total} held
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}

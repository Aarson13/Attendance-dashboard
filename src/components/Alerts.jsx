import GlassCard from './GlassCard.jsx';
import { MIN_ATTENDANCE_PCT, alerts } from '../data/attendance.js';

const open = alerts();

export default function Alerts() {
  return (
    <GlassCard as="section" id="notices" index={7} className="p-6 lg:col-span-7" aria-labelledby="notices-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight" id="notices-title">
          Low attendance alerts
        </h2>
        <p className="text-xs text-muted">
          {open.length ? `${open.length} subject${open.length === 1 ? '' : 's'} below ${MIN_ATTENDANCE_PCT}%` : `everything above ${MIN_ATTENDANCE_PCT}%`}
        </p>
      </div>

      {open.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No subject is under the minimum. Nothing to fix today.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {open.map((subject) => (
            <li
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border border-glass-line bg-white/[0.03] px-4 py-3"
              key={subject.code}
            >
              <span className={subject.band === 'low' ? 'chip chip-low' : 'chip chip-warn'}>
                {subject.pct.toFixed(1)}%
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{subject.name}</p>
                <p className="text-xs text-muted">
                  {subject.needed === null
                    ? `A missed class cannot be recovered at a ${MIN_ATTENDANCE_PCT}% minimum`
                    : `Attend ${subject.needed} more class${subject.needed === 1 ? '' : 'es'} to reach ${MIN_ATTENDANCE_PCT}%`}
                  <span className="text-muted/70"> · {subject.attended}/{subject.total} held</span>
                </p>
              </div>
              <a className="btn-link text-xs" href="./app.html">
                Open tracker →
              </a>
            </li>
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

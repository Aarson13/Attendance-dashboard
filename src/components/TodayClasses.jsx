import GlassCard from './GlassCard.jsx';
import { TODAY_CLASSES } from '../data/attendance.js';

const STATUS = {
  present: { label: 'Present', className: 'chip chip-ok' },
  absent: { label: 'Absent', className: 'chip chip-warn' },
  cancelled: { label: 'Cancelled', className: 'chip chip-quiet' },
  upcoming: { label: 'Not marked', className: 'chip chip-violet' },
};

export default function TodayClasses() {
  return (
    <GlassCard as="section" id="timetable" index={6} className="p-6 lg:col-span-5" aria-labelledby="timetable-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight" id="timetable-title">
          Today&rsquo;s classes
        </h2>
        <p className="text-xs text-muted">{TODAY_CLASSES.length} periods</p>
      </div>

      <ul className="mt-4 divide-y divide-glass-line">
        {TODAY_CLASSES.map((item) => {
          const status = STATUS[item.status] || STATUS.upcoming;
          return (
            <li className="flex items-center gap-4 py-3" key={`${item.time}-${item.code}`}>
              <span className="w-12 shrink-0 text-xs text-muted tabular-nums">{item.time}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white">{item.name}</p>
                <p className="truncate text-xs text-muted">
                  {item.code} · {item.kind} · {item.room}
                </p>
              </div>
              <span className={status.className}>{status.label}</span>
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}

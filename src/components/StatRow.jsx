import GlassCard from './GlassCard.jsx';
import { MIN_ATTENDANCE_PCT, SUBJECTS, overall } from '../data/attendance.js';

const totals = overall();

const STATS = [
  {
    label: 'Overall attendance',
    value: `${totals.pct.toFixed(1)}%`,
    note: `${totals.attended} of ${totals.total} classes held`,
  },
  {
    label: 'Classes attended',
    value: String(totals.attended),
    note: `across ${SUBJECTS.length} subjects`,
  },
  {
    label: 'Classes missed',
    value: String(totals.missed),
    note: `${MIN_ATTENDANCE_PCT}% minimum keeps you exam-eligible`,
  },
  {
    label: 'Classes I can still bunk',
    value: String(totals.bunkable),
    note: 'safe misses before you drop below',
  },
];

export default function StatRow() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {STATS.map((stat, i) => (
        <GlassCard key={stat.label} index={i} className="p-5">
          <p className="text-xs uppercase tracking-[0.14em] text-muted">{stat.label}</p>
          <p className="mt-3 text-3xl font-light tracking-tight text-white tabular-nums">{stat.value}</p>
          <p className="mt-2 text-sm text-muted">{stat.note}</p>
        </GlassCard>
      ))}
    </div>
  );
}

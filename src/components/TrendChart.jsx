import { useId } from 'react';
import GlassCard from './GlassCard.jsx';
import { MIN_ATTENDANCE_PCT, TREND } from '../data/attendance.js';

const W = 340;
const H = 150;
const PAD = 6;

const values = TREND.map((point) => point.pct);
const low = Math.max(0, Math.min(...values) - 8);
const high = Math.min(100, Math.max(...values) + 6);

const x = (i) => (i / (TREND.length - 1)) * W;
const y = (pct) => H - PAD - ((pct - low) / (high - low || 1)) * (H - PAD * 2);

const linePath = TREND.map((point, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(point.pct).toFixed(1)}`).join(' ');
const areaPath = `${linePath} L ${W} ${H - PAD} L 0 ${H - PAD} Z`;
const last = TREND[TREND.length - 1];
const thresholdY = y(MIN_ATTENDANCE_PCT);

export default function TrendChart() {
  const uid = useId().replace(/:/g, '');
  const stroke = `trend-line-${uid}`;
  const fill = `trend-area-${uid}`;
  const glow = `trend-glow-${uid}`;

  return (
    <GlassCard as="section" id="reports" index={5} className="p-6 lg:col-span-5" aria-labelledby="reports-title">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-medium tracking-tight" id="reports-title">
          Attendance trend
        </h2>
        <p className="text-xs text-muted">last {TREND.length} weeks</p>
      </div>

      <p className="mt-3 text-3xl font-light tracking-tight text-white tabular-nums">
        {last.pct.toFixed(1)}%
        <span className="ml-2 text-sm font-normal text-muted">
          {last.pct >= MIN_ATTENDANCE_PCT ? 'above the minimum' : 'below the minimum'}
        </span>
      </p>

      <svg
        className="mt-4 w-full"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Attendance trend from ${TREND[0].pct}% in ${TREND[0].label} to ${last.pct}% in ${last.label}, minimum ${MIN_ATTENDANCE_PCT}%`}
      >
        <defs>
          <linearGradient id={stroke} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#6D4AFF" />
            <stop offset="0.62" stopColor="#A78BFA" />
            <stop offset="1" stopColor="#EFE7FF" />
          </linearGradient>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6D4AFF" stopOpacity="0.34" />
            <stop offset="1" stopColor="#6D4AFF" stopOpacity="0" />
          </linearGradient>
          <filter id={glow} x="-20%" y="-40%" width="140%" height="180%">
            <feGaussianBlur stdDeviation="4" />
          </filter>
        </defs>

        <path d={areaPath} fill={`url(#${fill})`} />
        {/* the same line, blurred underneath, is what reads as glow */}
        <path d={linePath} fill="none" stroke="#A78BFA" strokeWidth="5" strokeLinecap="round" opacity="0.55" filter={`url(#${glow})`} />
        <path
          d={linePath}
          fill="none"
          stroke={`url(#${stroke})`}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        <line
          x1="0"
          x2={W}
          y1={thresholdY}
          y2={thresholdY}
          stroke="var(--color-warn)"
          strokeWidth="1"
          strokeDasharray="4 5"
          opacity="0.75"
          vectorEffect="non-scaling-stroke"
        />
        <circle cx={x(TREND.length - 1)} cy={y(last.pct)} r="3.5" fill="#EFE7FF" />
      </svg>

      <div className="mt-2 flex justify-between text-[0.7rem] text-muted">
        <span>{TREND[0].label}</span>
        <span className="text-warn">{MIN_ATTENDANCE_PCT}% minimum</span>
        <span>{last.label}</span>
      </div>
    </GlassCard>
  );
}

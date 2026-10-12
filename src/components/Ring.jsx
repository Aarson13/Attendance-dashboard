const BAND_COLOUR = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  low: 'var(--color-low)',
};

/** One circular progress ring. The colour is the attendance band, never decoration. */
export default function Ring({ value, band, size = 76, stroke = 5 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(100, value));

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
      role="img"
      aria-label={`${value.toFixed(1)}% attendance`}
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth={stroke} />
      {filled > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={BAND_COLOUR[band] || BAND_COLOUR.ok}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(filled / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#fff"
        fontSize={size * 0.26}
        fontWeight="500"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {Math.round(value)}%
      </text>
    </svg>
  );
}

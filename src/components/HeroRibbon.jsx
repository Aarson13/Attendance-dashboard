import { useId } from 'react';

/**
 * HeroRibbon — the symmetric "hourglass / bowtie" ribbon behind the hero copy.
 *
 * Three stacked, blurred copies of the same silhouette (widest to narrowest): violet #6D4AFF,
 * light purple #A78BFA and a near-white lavender #EFE7FF band through the centre, over one heavily
 * blurred ambient glow. The layers composite with `mix-blend-mode: screen`, so the narrow middle
 * where all three overlap is the brightest point — which is what makes the shape read as light
 * rather than as three flat shapes.
 *
 * Layer blurs, colours and the breathe animation all come from CSS variables (see src/styles/index.css),
 * so the whole visual is tunable from the token block.
 */

/**
 * Concave bowtie outline: thin at the horizontal centre, flaring towards all four corners.
 * Four cubic segments — top-left, top-right, bottom-right, bottom-left — keep it symmetric by
 * construction: the right half is the left half mirrored, and so is the bottom.
 */
function bowtie({ width, height, pinch, flare, inset = 0 }) {
  const mid = height / 2;
  const cx = width / 2;
  const left = inset;
  const right = width - inset;
  const span = cx - left;
  const n = (v) => Number(v.toFixed(1));

  return [
    // top edge, left wing → centre
    `M ${n(left)} ${n(mid - flare)} C ${n(left + span * 0.5)} ${n(mid - flare * 0.26)} ${n(cx - span * 0.42)} ${n(mid - pinch)} ${n(cx)} ${n(mid - pinch)}`,
    // top edge, centre → right wing
    `C ${n(cx + span * 0.42)} ${n(mid - pinch)} ${n(right - span * 0.5)} ${n(mid - flare * 0.26)} ${n(right)} ${n(mid - flare)}`,
    // the wing tip
    `L ${n(right)} ${n(mid + flare)}`,
    // bottom edge, right wing → centre → left wing
    `C ${n(right - span * 0.5)} ${n(mid + flare * 0.26)} ${n(cx + span * 0.42)} ${n(mid + pinch)} ${n(cx)} ${n(mid + pinch)}`,
    `C ${n(cx - span * 0.42)} ${n(mid + pinch)} ${n(left + span * 0.5)} ${n(mid + flare * 0.26)} ${n(left)} ${n(mid + flare)}`,
    'Z',
  ].join(' ');
}

const VIEW = { width: 1200, height: 620 };

const LAYERS = [
  { key: 'outer', className: 'ribbon-layer ribbon-outer', fill: '#6D4AFF', shape: { pinch: 26, flare: 236, inset: 0 } },
  { key: 'middle', className: 'ribbon-layer ribbon-middle', fill: '#A78BFA', shape: { pinch: 18, flare: 168, inset: 46 } },
  // The core is the one layer with a gradient, so its ends dissolve instead of stopping dead.
  { key: 'core', className: 'ribbon-layer ribbon-core', shape: { pinch: 9, flare: 34, inset: 150 } },
];

export default function HeroRibbon() {
  const uid = useId().replace(/:/g, '');
  const coreGradient = `ribbon-core-${uid}`;
  const grain = `ribbon-grain-${uid}`;

  return (
    <div className="ribbon" aria-hidden="true">
      <div className="ribbon-stage">
        <div className="ribbon-ambient" />

        <svg className="ribbon-layer ribbon-outer" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}>
          <path d={bowtie({ ...VIEW, ...LAYERS[0].shape })} fill={LAYERS[0].fill} />
        </svg>

        <svg className="ribbon-layer ribbon-middle" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}>
          <path d={bowtie({ ...VIEW, ...LAYERS[1].shape })} fill={LAYERS[1].fill} />
        </svg>

        <svg className="ribbon-layer ribbon-core" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}>
          <defs>
            <linearGradient id={coreGradient} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#EFE7FF" stopOpacity="0" />
              <stop offset="0.22" stopColor="#EFE7FF" stopOpacity="0.75" />
              <stop offset="0.5" stopColor="#FFFFFF" />
              <stop offset="0.78" stopColor="#EFE7FF" stopOpacity="0.75" />
              <stop offset="1" stopColor="#EFE7FF" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={bowtie({ ...VIEW, ...LAYERS[2].shape })} fill={`url(#${coreGradient})`} />
        </svg>

        {/* faint grain so the large gradients never band */}
        <svg className="ribbon-grain" width="100%" height="100%">
          <filter id={grain} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#${grain})`} />
        </svg>
      </div>
    </div>
  );
}

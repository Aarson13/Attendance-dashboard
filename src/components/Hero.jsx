import HeroRibbon from './HeroRibbon.jsx';

const DOTS = [0, 1, 2];

export default function Hero() {
  return (
    <section className="hero-bg relative isolate overflow-hidden" id="top">
      <HeroRibbon />

      {/* Keeps the copy legible where it crosses the ribbon's bright core. */}
      <div className="hero-shield" aria-hidden="true" />

      <div className="relative mx-auto flex min-h-[42rem] max-w-4xl flex-col items-center justify-center px-5 pb-24 pt-24 text-center sm:min-h-[46rem] sm:px-8">
        <span className="pill animate-rise">
          <span className="pill-rule" aria-hidden="true" />
          <span className="flex items-center gap-1.5" aria-hidden="true">
            {DOTS.map((d) => (
              <span className="pill-dot" key={d} />
            ))}
          </span>
          Live Attendance Tracking
          <span className="flex items-center gap-1.5" aria-hidden="true">
            {DOTS.map((d) => (
              <span className="pill-dot" key={d} />
            ))}
          </span>
          <span className="pill-rule is-right" aria-hidden="true" />
        </span>

        <h1
          className="mt-7 animate-rise text-[36px] font-light leading-[1.08] tracking-[-0.03em] text-white [animation-delay:120ms] sm:text-5xl lg:text-[56px] [text-shadow:0_2px_28px_rgb(5_3_15/0.65)]"
        >
          Smart Attendance Tracking.
          <span className="block">Zero Surprises.</span>
        </h1>

        <p className="mt-5 max-w-xl animate-rise text-base text-muted [animation-delay:240ms] sm:text-lg">
          Track every class, predict your bunk limit and stay above 75%.
        </p>

        <div className="mt-9 flex animate-rise flex-col gap-3 [animation-delay:360ms] sm:flex-row sm:items-center">
          <a className="btn btn-white" href="./app.html">
            Get started
          </a>
          <a className="btn btn-ghost" href="./app.html?demo=1">
            View demo
          </a>
        </div>
      </div>
    </section>
  );
}

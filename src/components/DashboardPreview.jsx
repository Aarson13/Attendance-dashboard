import GlassCard from './GlassCard.jsx';
import StatRow from './StatRow.jsx';
import SubjectRings from './SubjectRings.jsx';
import TrendChart from './TrendChart.jsx';
import TodayClasses from './TodayClasses.jsx';
import Alerts from './Alerts.jsx';

/** Everything below the hero: the student view with a sample semester loaded. */
export default function DashboardPreview() {
  return (
    <div className="preview-bg pb-24 pt-6 sm:pt-10">
      <section className="mx-auto max-w-7xl px-5 sm:px-8" id="dashboard" aria-labelledby="dashboard-title">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-lavender">Live preview</p>
            <h2 className="mt-2 text-2xl font-light tracking-tight sm:text-3xl" id="dashboard-title">
              Everything that matters, on one screen
            </h2>
          </div>
          <p className="max-w-sm text-sm text-muted">
            Sample semester, real maths: percentages, safe misses and recovery targets all come from the
            same formulas the tracker uses. Faculty see the same numbers per class.
          </p>
        </div>

        <StatRow />

        <div className="mt-5 grid gap-5 lg:grid-cols-12">
          <SubjectRings />
          <TrendChart />
          <TodayClasses />
          <Alerts />
        </div>

        <GlassCard index={8} className="mt-5 flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="text-sm text-muted">
            Add your subjects, drop in the timetable, mark classes in one tap. No account, no cloud —
            everything stays in your browser.
          </p>
          <a className="btn btn-white !px-5 !py-2.5 text-sm" href="./app.html">
            Open the tracker
          </a>
        </GlassCard>
      </section>
    </div>
  );
}

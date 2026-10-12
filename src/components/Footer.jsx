export default function Footer() {
  return (
    <footer className="footer-bg border-t border-glass-line">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-8 text-sm text-muted sm:px-8">
        <p className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-violet/20 text-lavender" aria-hidden="true">
            ✓
          </span>
          College Attendance Dashboard
        </p>
        <nav className="flex flex-wrap items-center gap-5" aria-label="Footer">
          <a className="btn-link" href="./app.html">
            Open the tracker
          </a>
          <a className="btn-link" href="#subjects">
            Subjects
          </a>
          <a className="btn-link" href="#reports">
            Reports
          </a>
        </nav>
      </div>
    </footer>
  );
}

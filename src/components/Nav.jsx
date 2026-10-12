import { useState } from 'react';
import { useScrolled } from '../lib/hooks.js';

const LINKS = [
  { href: '#dashboard', label: 'Dashboard' },
  { href: '#subjects', label: 'Subjects' },
  { href: '#reports', label: 'Reports' },
  { href: '#timetable', label: 'Timetable' },
  { href: '#notices', label: 'Notices' },
];

/** Transparent over the hero, blurred and tinted once the page scrolls. */
export default function Nav() {
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);

  return (
    <header className={`nav ${scrolled ? 'is-scrolled' : ''}`}>
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-5 sm:px-8">
        <a className="flex items-center gap-2.5 text-white" href="#top">
          <svg
            className="h-6 w-6 text-lavender animate-spin-slow motion-reduce:animate-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 2.5v19M4 7.2l16 9.6M20 7.2 4 16.8" />
          </svg>
          <span className="text-[0.95rem] font-medium tracking-tight">College Attendance</span>
        </a>

        <nav className="mx-auto hidden items-center gap-7 md:flex" aria-label="Sections">
          {LINKS.map((link) => (
            <a key={link.href} className="btn-link" href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <a className="btn btn-white ml-auto hidden !px-5 !py-2.5 text-sm md:inline-flex" href="./app.html">
          Start for free
        </a>

        <button
          className="ml-auto grid h-10 w-10 place-items-center rounded-full border border-glass-line text-white md:hidden"
          type="button"
          aria-expanded={open}
          aria-controls="nav-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 8h16M4 16h16" />}
          </svg>
        </button>
      </div>

      {open && (
        <div id="nav-menu" className="border-t border-glass-line bg-ink/90 px-5 pb-5 pt-2 backdrop-blur-xl md:hidden">
          <nav className="flex flex-col" aria-label="Sections">
            {LINKS.map((link) => (
              <a
                key={link.href}
                className="border-b border-glass-line py-3 text-sm text-white/80 last:border-0"
                href={link.href}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
          </nav>
          <a className="btn btn-white mt-4 w-full" href="./app.html">
            Start for free
          </a>
        </div>
      )}
    </header>
  );
}

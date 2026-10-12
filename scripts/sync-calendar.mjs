#!/usr/bin/env node
/**
 * sync-calendar.mjs — scrape a Manipal-style academic calendar into an importable JSON snapshot.
 *
 * Why this exists: the academic calendar is the one part of the app that changes outside our
 * control, so it is refreshed by scraping the official PDF/HTML "every once in a while" instead
 * of typing dates by hand. The app itself never fetches anything — you import the JSON this
 * script writes (Calendar → Import). `--emit-js` additionally writes a plain <script> bundle so
 * the app can offer it offline / from file://.
 *
 * Usage:
 *   node scripts/sync-calendar.mjs --url <pdf-or-html-url> --label muj-2026-27 \
 *        [--year 2026] [--first-month JULY] [--out data/] [--emit-js js/manipal-calendar.js] [--title "..."]
 *
 * Examples:
 *   npm run sync:calendar -- --url "https://jaipur.manipal.edu/img/pdf/academicrules/AC-calender-2026-27.pdf" \
 *        --label muj-2026-27 --emit-js js/manipal-calendar.js
 *   npm run sync:calendar -- --url "https://www.manipal.edu/content/dam/manipal/mu/mit/documents/academic-calendar/Academic%20Calendar%2025-26.pdf" \
 *        --label mit-2025-26
 *
 * Output: data/<label>.json (importable), data/<label>.days.txt (raw day-by-day dump for review),
 * and optionally a JS bundle. Always eyeball the dump before trusting a new snapshot — the parser
 * prints warnings for duplicates and misses instead of silently guessing.
 */
import fs from 'node:fs';
import path from 'node:path';

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

// Festival names that are usually full holidays. Anything else is recorded as an "event" note
// (visible in the day dump, not turned into a no-class day).
const HOLIDAYS = [
  'Independence Day', 'Republic Day', 'Raksha Bandhan', 'Janmashtami', 'Gandhi Jayanti',
  'Dussehra', 'Diwali', 'Govardhan Puja', 'Bhai Dooj', 'Christmas', 'Holi', 'Makar Sankranti',
  'Good Friday', 'May Day', 'Ramzan', 'Eid',
];

// Non-holiday observances we want to keep as notes only.
const EVENT_DAYS = ['Engineers\' Day', 'National Sports Day', 'National Science Day', 'Founders\' Day', 'International Yoga Day', 'Scholarship and Appreciation Day'];

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const iso = (y, m, d) => fmt(new Date(Date.UTC(y, m - 1, d)));

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (attendance-dashboard calendar sync)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { res, buffer: Buffer.from(await res.arrayBuffer()) };
}

/** Reconstruct day -> events[] from a text-layer PDF laid out as a 12/13-column month grid. */
async function readPdfGrid(buffer, opts) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const days = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.replace(/\s+/g, ' ').trim() }));

    // Month headers live in the top band, sorted left -> right.
    const maxY = Math.max(...items.map((i) => i.y));
    const band = items.filter((i) => i.y > maxY - 90);
    const headers = band
      .map((i) => ({ m: MONTHS.indexOf(i.s.toUpperCase().replace(/-\d\d$/, '').trim()), x: i.x, y: i.y }))
      .filter((h) => h.m >= 0)
      .sort((a, b) => a.x - b.x);
    if (headers.length < 3) continue; // not a month grid page

    const firstMonth = opts['first-month'] ? MONTHS.indexOf(String(opts['first-month']).toUpperCase()) + 1 : headers[0].m + 1;
    const firstYear = opts.year ? +opts.year : new Date().getUTCFullYear();
    let year = firstYear;
    let prevM = 0;

    headers.forEach((h, idx) => {
      const month = h.m + 1;
      if (idx > 0 && month < prevM) year++; // rolled over into the next calendar year
      prevM = month;
      const lo = idx === 0 ? -Infinity : (headers[idx - 1].x + h.x) / 2;
      const hi = idx === headers.length - 1 ? Infinity : (h.x + headers[idx + 1].x) / 2;
      const colItems = items.filter((i) => i.x >= lo && i.x < hi && i.y <= maxY - 90).sort((a, b) => b.y - a.y || a.x - b.x);
      let day = null;
      const perDay = new Map(); // day -> [{y, text}], so labels that sit a hair above the next day number can be re-homed
      const push = (d, y, text) => {
        if (!perDay.has(d)) perDay.set(d, []);
        perDay.get(d).push({ y, text });
      };
      for (const it of colItems) {
        const s = it.s;
        if (/^\d{1,2}$/.test(s)) {
          const n = +s;
          if (n >= 1 && n <= 31 && (day === null ? n <= 3 : n === day + 1)) {
            // Grid labels are often printed with their baseline 0.1-2pt above the day number of the
            // row they belong to; hand those back to the new day.
            const prev = perDay.get(day) || [];
            const moved = prev.filter((e) => e.y >= it.y - 0.5 && e.y <= it.y + 3.5);
            if (moved.length) {
              perDay.set(day, prev.filter((e) => !(e.y >= it.y - 0.5 && e.y <= it.y + 3.5)));
              for (const e of moved) push(n, e.y, e.text);
            }
            day = n;
            continue;
          }
        }
        if (day === null) continue;
        if (/^(Slot|Registrar|MUJ reserves)/i.test(s)) continue; // side notes
        if (WEEKDAYS.some((w) => w.startsWith(s.slice(0, 2).toUpperCase())) && s.length <= 3) continue; // weekday chip
        if (MONTHS.includes(s.toUpperCase())) continue; // repeated header
        push(day, it.y, s);
      }
      for (const [d, evs] of perDay) {
        for (const e of evs) days.push({ date: iso(year, month, d), month, day: d, wd: null, text: e.text });
      }
    });
  }
  return days;
}

/** Plain-text fallback for HTML calendars: keep lines that look like "14 Aug 2026 — Holiday". */
function readHtmlLines(buffer) {
  const html = buffer.toString('utf8');
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ date: null, month: null, day: null, text }));
}

function matchHoliday(text) {
  const t = text.replace(/\s+/g, ' ');
  return HOLIDAYS.find((h) => new RegExp(`\\b${h}\\b`, 'i').test(t)) || null;
}

function buildSnapshot({ days, label, title, url, kind }) {
  const entries = [];
  const notes = [];
  const seen = new Set();

  // Group extracted strings by date so multi-token labels ("Last Instruction" + "Day") can be joined.
  const byDate = new Map();
  for (const d of days) {
    if (!d.date) continue;
    if (!byDate.has(d.date)) byDate.set(d.date, []);
    byDate.get(d.date).push(d.text);
  }
  const joined = new Map([...byDate].map(([date, arr]) => [date, arr.join(' · ')]));

  // Holidays: if the same festival is printed twice in a month (grid label duplication),
  // keep the earliest printed date and warn.
  const festivalFirst = new Map();
  for (const [date, text] of [...joined].sort()) {
    const h = matchHoliday(text);
    if (!h) continue;
    const monthKey = `${h}|${date.slice(0, 7)}`;
    if (festivalFirst.has(monthKey)) {
      notes.push(`duplicate label "${h}" on ${date} ignored (already on ${festivalFirst.get(monthKey)})`);
      continue;
    }
    festivalFirst.set(monthKey, date);
    entries.push({ type: 'holiday', start: date, end: date, title: h });
  }

  // Swapped-timetable days, e.g. "Friday Timetable" printed on a Thursday.
  for (const [date, text] of joined) {
    const m = text.match(/\b(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+TIMETABLE\b/i);
    if (m) entries.push({ type: 'working-swap', start: date, end: date, swapDay: WEEKDAYS.indexOf(m[1].toUpperCase()) + 1, title: `${m[1][0]}${m[1].slice(1).toLowerCase()} timetable (swapped day)` });
  }

  // Exam windows and semester bounds from printed markers. Labels in these PDFs get split across
  // text runs ("Commencement of the" + "classes for Higher Semester") and can contain typos
  // ("Comencement of ETE"), so match against a de-separated copy with loose patterns.
  const flat = [...joined].sort().map(([date, t]) => [date, t.replace(/ · /g, ' ')]);
  const findMarker = (re) => flat.find(([, t]) => re.test(t))?.[0] || null;
  const findAll = (re) => flat.filter(([, t]) => re.test(t)).map(([d]) => d);
  const COMMENCE = 'comm?[a-z]{0,3}encement'; // tolerates the "Comencement" typo these PDFs ship with
  const mteStart = findMarker(/\bstart of MTE\b/i);
  const mteEnd = findMarker(/\bend of MTE\b/i);
  const eteStart = findMarker(new RegExp(`${COMMENCE} of ETE|start of ETE`, 'i'));
  const eteEnd = findMarker(/\bend of ETE\b/i);
  if (mteStart && mteEnd) entries.push({ type: 'exam', start: mteStart, end: mteEnd, title: 'Mid-term exams (MTE)' });
  if (eteStart && eteEnd) entries.push({ type: 'exam', start: eteStart, end: eteEnd, title: 'End-term exams (ETE)' });
  if (!mteStart) notes.push('MTE window not found');
  if (!eteStart) notes.push('ETE window not found');

  // Semester windows: each class-commencement paired with the next "last instruction day".
  const classStarts = findAll(new RegExp(`${COMMENCE} of (the )?(classes|even sem|odd sem)|classes (start|for (higher|1st|first|2nd|second))`, 'i')).sort();
  // "Last Instruction Day" is sometimes split by month-grid labels printed on the same date
  // (e.g. "Last Instruction · Govardhan Puja · Day"), so check both words on the same date.
  const lastDays = flat.filter(([, t]) => /last instruction/i.test(t) && /\bday\b/i.test(t)).map(([d]) => d).sort();
  const semesters = [];
  const half = (d) => `${d.slice(0, 4)}-${+d.slice(5, 7) <= 6 ? 'H1' : 'H2'}`;
  for (const start of classStarts) {
    const end = lastDays.find((d) => d > start);
    if (!end || semesters.some((s) => half(s.start) === half(start))) continue;
    const m = +start.slice(5, 7);
    semesters.push({ name: `${m <= 6 ? 'Even' : 'Odd'} semester ${start.slice(0, 4)}`, start, end });
  }
  if (!semesters.length) notes.push('semester windows not found — set start/end manually in Settings');

  // Informational observances (not holidays).
  for (const [date, text] of [...joined].sort()) {
    const e = EVENT_DAYS.find((k) => text.toLowerCase().includes(k.toLowerCase()));
    if (e) notes.push(`${date}: ${e}`);
  }

  entries.sort((a, b) => a.start.localeCompare(b.start));
  return {
    id: label,
    title,
    source: { url, kind, fetchedAt: new Date().toISOString().slice(0, 10) },
    semester: semesters[0] || null,
    semesters,
    entries,
    notes,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    const url = 'https://jaipur.manipal.edu/img/pdf/academicrules/AC-calender-2026-27.pdf';
    console.error(`No --url given. Example:\n  node scripts/sync-calendar.mjs --url "${url}" --label muj-2026-27 --year 2026 --emit-js js/manipal-calendar.js`);
    process.exit(2);
  }
  const label = String(args.label || 'calendar');
  const outDir = String(args.out || 'data');
  const { res, buffer } = await fetchText(String(args.url));
  const ctype = res.headers.get('content-type') || '';
  const kind = ctype.includes('pdf') || buffer.slice(0, 5).toString() === '%PDF-' ? 'pdf' : 'html';
  const days = kind === 'pdf' ? await readPdfGrid(buffer, args) : readHtmlLines(buffer);
  const matched = days.filter((d) => d.date).length;
  console.log(`fetched ${buffer.length} bytes (${kind}); extracted ${days.length} text items, ${matched} dated`);
  if (kind === 'pdf' && matched === 0) {
    console.error('No text layer found — this PDF is probably a scan. Run OCR-lite by exporting the page as an image and using the in-app calendar OCR instead.');
    process.exit(1);
  }

  const title = String(args.title || `${label} (scraped)`);
  const snap = buildSnapshot({ days, label, title, url: String(args.url), kind });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(snap, null, 2));
  fs.writeFileSync(
    path.join(outDir, `${label}.days.txt`),
    days.filter((d) => d.date).map((d) => `${d.date}  ${d.text}`).join('\n') +
      (snap.notes.length ? `\n\n-- notes --\n${snap.notes.join('\n')}\n` : '\n'),
  );
  console.log(`wrote ${path.join(outDir, `${label}.json`)} — ${snap.entries.length} entries; review ${path.join(outDir, `${label}.days.txt`)}`);
  console.log(`semesters: ${snap.semesters.map((s) => `${s.name} ${s.start}..${s.end}`).join(' | ') || 'none'}`);
  if (snap.notes.length) console.log(`notes:\n  ${snap.notes.join('\n  ')}`);

  if (args['emit-js']) {
    const out = String(args['emit-js']);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      `/* Calendar snapshot scraped by scripts/sync-calendar.mjs on ${snap.source.fetchedAt}.\n` +
        ` * Source: ${snap.source.url}\n * Regenerate: npm run sync:calendar -- --url "${snap.source.url}" --label ${label} --emit-js ${out}\n */\n` +
        `(typeof window !== 'undefined' ? window : globalThis).MANIPAL_CALENDAR = ${JSON.stringify(snap, null, 2)};\n`,
    );
    console.log(`wrote ${out} (offline <script> bundle)`);
  }
}

main().catch((err) => {
  console.error(`sync failed: ${err.message}`);
  process.exit(1);
});

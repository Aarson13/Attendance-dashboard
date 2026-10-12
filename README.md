# Attendance dashboard

A one-person college attendance tracker. Static HTML/CSS/vanilla JS — no framework, no build step,
no backend, no account. Everything is stored in your browser's `localStorage`, and it keeps working
offline after the first load.

Built around one rule: **you need `p` % attendance in every subject** (`p` defaults to 75% and is
editable). Every number on screen comes from the same formulas, and the academic calendar is
*scraped* from the college's PDF rather than typed in by hand — with OCR kept as the fallback for
notice-board photos.

---

## Quick start

```bash
cd Attendance-dashboard
npm install          # only for the calendar scraper + tests; the app itself needs nothing
npx serve -l 4173 .  # or: python -m http.server 4173
```

Open <http://127.0.0.1:4173>.

Then either press **Settings → Load sample semester** to explore a complete demo, or start with
**Subjects → add a subject**.

> Opening `index.html` straight from disk (`file://`) works for everything except OCR and the
> service worker: browsers block those on `file://`, and `fetch()` of local JSON is blocked too.
> Serving over localhost is recommended.

---

## Tech

| Concern | Choice | Why |
|---|---|---|
| UI | plain HTML + CSS + classic `<script>` files | no build step, readable in five years, works offline |
| State | one JSON document in `localStorage` | nothing to host; export/import is your backup |
| Charts | hand-rolled SVG (`js/charts.js`) | one less CDN dependency, still works offline |
| OCR | Tesseract.js from a CDN, only loaded when you press *Run OCR* | images are processed in your browser, never uploaded |
| Calendar | `scripts/sync-calendar.mjs` (Node + `pdfjs-dist`) | the calendar is scraped from the official PDF, then imported |

Interaction contract, worth knowing before editing any view: **one `data-act` attribute, two event
paths.** Buttons, links and images run their action on `click`; `input`/`select`/`textarea` run
theirs on `change` only. The click delegate deliberately ignores form controls — running their
action on click would `preventDefault()` the file pickers into never opening and re-render the field
under your cursor (native date pickers, sliders and dropdowns all break that way).

---

## Counting rules (the contract)

These are implemented once, in [`js/calc.js`](js/calc.js), and unit-tested in
[`tests/calc.test.mjs`](tests/calc.test.mjs).

- **1 timetable cell = 1 class.** A lab occupies two periods on the grid and is drawn as one merged
  block, but it counts as exactly one class.
- **Classes held** `t` = present + absent (+ medical/duty leave when that setting is *count as
  absent*), **plus the existing attendance you carried in**.
- **Classes attended** `a` = present only, plus the carried attendance.
- **Existing attendance** (`carried: { a, t }` per subject, entered in the *Subjects* tab) is what
  your portal already knew before you started marking here. It folds into `a` and `t` for every
  formula below, and it is *dateless*: it never shows up on one day, so it stays out of the heatmap
  and out of every recorded date — but the trend line is seeded with it, which is why the line's
  last point always equals the dashboard tiles. If carried classes push `t` past the semester plan
  `T`, `T` is raised to `t` (and a warning tells you to fix the semester dates or set *Total T*),
  because more classes can never have been held than the plan contains.
- **Cancelled classes are not counted anywhere** — they don't add to `t` and don't add to `T`.
- **Holidays, exam windows and suspended days** are skipped automatically; a day from the calendar
  always beats the weekly timetable.
- **`T`, scheduled classes this semester** = timetable cells falling on teaching days inside your
  semester window, minus cancellations, plus extra classes you actually held. A manual
  *"total classes expected (T)"* on a subject overrides the calculation; with no timetable at all it
  falls back to *credits = classes per week*.
- **Swapped days** (`extra working day / swapped timetable`) make that date follow another
  weekday's timetable, e.g. a Saturday following Monday.

Per subject:

```
current %          = a / t                                   (N/A when t = 0 — never a divide-by-zero)
safe misses left   = max(0, floor(a / p - t))
attend in a row to recover = ceil((p*t - a) / (1 - p))        (only when below p)
projected best     = (a + remaining) / T                      (attend everything left)
projected worst    = a / T                                    (miss everything left)
misses allowed all semester = floor((1 - p) * T)              ·  used = t - a
overall %          = Σa / Σt     credit-weighted = Σ(credits·a) / Σ(credits·t)
```

Colour status per subject: **green** safe (buffer > 3), **yellow** borderline (buffer 1–3),
**red** below `p` or buffer 0.

The recovery formula divides by `1 - p`, so a threshold of exactly **100%** is a special case: once
you have missed a single class there is no number of classes that gets you back, and the app says so
("can't return to 100%") instead of printing `Infinity`. `p` is editable between 0.5 and 1.

---

## Data model

One object, exported as `{ app, version, exportedAt, data }`:

```js
{
  settings: {
    threshold: 0.75,                 // p
    theme: 'dark' | 'light',
    semester: { name, start, end },  // YYYY-MM-DD
    leaveMode: 'absent' | 'exclude', // medical/duty leave handling
    schoolDays: [1,2,3,4,5,6],       // Mon..Sat
    periods: [{ id, label, start, end }],
    sort: 'risk' | 'credits',
    spotlights: true
  },
  subjects: [{ id, name, code, credits, faculty, classesPerWeek: null, expectedClasses: null,
               carried: { a: 0, t: 0 } }],   // classes attended/held before you started marking
  timetable: { "1": { "p1": { subjectId, lab: false } } },   // day 1=Mon … 6=Sat
  calendar: {
    sources: [{ id, title, url, fetchedAt, kind }],
    entries: [{ id, type, start, end, title, swapDay, sourceId }]  // holiday | exam | suspended | working-swap
  },
  records:  [{ id, date, subjectId, slotKey, kind, status, note }],  // kind: lecture | lab | extra
                                                                     // status: present | absent | cancelled | leave
  ocr:      { images: [{ id, name, dataUrl, addedAt }] }             // compressed timetable images (max 2)
}
```

`slotKey` (`"3:p2"` = Wednesday, period 2) ties a mark to a timetable cell; extra classes have
`slotKey: null`. Editing the timetable later never rewrites old marks.

---

## How to use it

1. **Subjects** — add each subject with credits and optional faculty. Classes-per-week defaults to
   the credit count until a timetable exists; *Total T* overrides the semester total if your
   college publishes one. Joining mid-semester? Type the two numbers your portal already shows into
   **Existing attendance** (attended / held, per subject) — they count in every figure immediately,
   and *Clear* wipes a row back to 0. Don't double-count: only enter classes you have not already
   marked on the Today tab.
2. **Timetable** — click any cell to assign a subject; tick *Lab* for a lab (it then spans that
   period and the next, and counts once). Periods are editable under *Edit periods*.
   You can also bring a timetable in three ways:
   - **CSV** — `day,period,subject_code,subject_name,kind`, sample downloadable in the app
     ([`samples/timetable-sample.csv`](samples/timetable-sample.csv)). Import merges into the grid;
     the file's cells win for the slots it mentions, unknown subjects are created (3 credits) and
     every guess is reported back.
   - **JSON** — the same shape as `timetable` in the data model.
   - **OCR** — see below.
3. **Calendar** — set the semester dates, press **Import this calendar** to load the scraped
   Manipal snapshot, or add/import entries yourself (CSV/ICS/OCR). Types: holiday, exam period
   (no classes), classes suspended, and *extra working day / swapped timetable* (with the weekday it
   follows).
4. **Today** — one tap per class: **Present / Absent / Leave / Cancelled**. Tap the same button again
   to clear it. Move with ◀ ▶ or pick any date to fix past days. *Add an extra class* records
   make-up classes that aren't in the timetable.
5. **Dashboard** — overall %, credit-weighted %, subjects at risk, "you can bunk today", per-subject
   cards sorted most-at-risk-first (or by credits), a bar chart, a trend line, and a monthly
   heatmap you can click to jump into that day.
6. **Tools** — the *what-if* simulator ("if I miss X more classes of Y…") and the *can I skip
   tomorrow?* planner, which shows every class that day plus what skipping it does to that subject.
7. **Settings → Export everything (JSON)** — do this before switching browsers or clearing site data.

---

## Sample data

- **In the app:** Settings → *Load sample semester* builds 7 subjects, a Mon–Sat timetable with two
  labs, the scraped Manipal calendar (holidays, MTE/ETE windows, two swapped "Friday timetable"
  days) and ~2½ months of deterministic attendance — including one subject below the threshold, one
  borderline, cancelled classes, a medical-leave mark and two extra classes.
- **On disk:** [`samples/sample-data.json`](samples/sample-data.json) is the same dataset as a
  backup file — import it via Settings → *Import backup / calendar JSON*.
  Regenerate all three files with `npm run samples`.
- [`samples/timetable-sample.csv`](samples/timetable-sample.csv) and
  [`samples/calendar-sample.csv`](samples/calendar-sample.csv) are the CSV templates.

---

## Academic calendar: scrape first, OCR as the fallback

The calendar is the one input that changes outside the app, so it is scraped rather than typed:

```bash
npm run sync:calendar -- \
  --url "https://jaipur.manipal.edu/img/pdf/academicrules/AC-calender-2026-27.pdf" \
  --label muj-2026-27 --year 2026 --first-month JULY \
  --emit-js js/manipal-calendar.js
```

The script downloads the PDF (or an HTML calendar), reconstructs the month grid from the PDF's text
coordinates, and writes:

- `data/<label>.json` — importable: holidays, exam windows, swapped-timetable days, semester windows
- `data/<label>.days.txt` — the raw day-by-day dump, for eyeballing before you trust it
- `js/manipal-calendar.js` — the offline `<script>` bundle the app offers as *Bundled* in the
  Calendar tab (regenerate it with `--emit-js` and reload the page)

It prints warnings instead of guessing: duplicate festival labels, missing markers, unscannable
PDFs. Anything it gets wrong is fixable by hand in the Calendar tab — the import never overwrites
your existing entries, and entries are deduplicated on type + dates + title.

**Bundled snapshot:** Manipal University Jaipur's official *Academic Calendar 2026-27* (odd semester
23 Jul – 13 Nov 2026; MTE 18–25 Sep; ETE 18 Nov – 2 Dec; two "Friday timetable" swap days on 10 Sep
and 14 Oct). Scraped 2026-10-12; the exact source URL and fetch date are shown in the app.

**MIT Manipal:** its calendar page currently publishes 2025-26 only
(<https://www.manipal.edu/mit/mit-experience/academic-calendar.html>). Point the same command at
that PDF (or at whichever campus applies) when a 2026-27 file appears — no code changes needed.

**Fallback for notices (OCR):** photos of holiday lists and circulars can be read in the Calendar
tab. Dates are parsed into a review table (type / from / to / title, all editable, each row
deselectable) and nothing is saved until you press *Confirm*.

---

## OCR for timetables

1. Drop a screenshot/photo (or take one on mobile) in the Timetable tab.
2. The image is preprocessed on a canvas: grayscale, contrast stretch, upscaling of small scans,
   optional invert (dark-mode screenshots), 90° rotation and crop sliders. The preview updates when
   you press *Apply preprocessing only*; stored in `localStorage` (compressed, newest two kept) so
   you can compare later.
3. **Run OCR** shows a progress bar with the recogniser's own status text.
4. **Review & Fix** — the processed image sits next to an editable grid. Every detected cell has a
   subject dropdown (plus *create a new subject from this text*), a Lab checkbox, the raw recognised
   text and its confidence. Matched rows are green, unsure matches yellow, unmatched red. Nothing is
   written until **Confirm and save timetable**.
5. If the layout is too complex, the app says so, keeps the image on screen as a reference, and you
   fill the grid in by hand. Re-running with different contrast / page mode / language is one click.

Layout detection: day names decide whether days are columns or rows, clock times (single or ranges)
build the other axis, and each text word is assigned to the nearest cell — so unmatched text is
flagged rather than guessed. Both orientations are covered by tests.

---

## Privacy, storage and offline

- Attendance lives in `localStorage` under one key. Nothing is uploaded; the only network traffic is
  the one-time Tesseract.js download (engine + English model, from a CDN) when you run OCR.
- OCR images are stored compressed and capped at two; if the storage quota is hit while saving, the
  app drops the images first and keeps your numbers.
- A `sw.js` service worker caches the app shell and the OCR CDN assets, so the app opens offline
  after the first load (http/https only; it prefers the network for local files so edits show up).
- Add it to a phone home screen — `manifest.webmanifest` + `icon.svg` are included.

---

## Tests

```bash
npm test
```

29 tests cover the counting rules, the semester scheduler (labs, holidays, exam windows, swapped
days, holiday-beats-swap), the CSV/ICS/JSON importers, the OCR grid + date parsers, the crop-to-source
mapping used when an image is rotated before OCR, the 100%-threshold edge case, the sample
dataset's internal consistency, and the existing-attendance maths: carried counts reach `a`/`t`, the
buffer, recovery, projections, the overall and credit-weighted totals and the trend baseline;
impossible pairs (attended > held) are clamped rather than believed, and junk in a hand-edited backup
is repaired on import. The engine files are dependency-free and DOM-free on purpose, which
is what makes them testable; `js/app.js` is the one file that needs a DOM, so its event wiring is
verified in a browser rather than here.

## Repository layout

```
index.html styles.css sw.js manifest.webmanifest icon.svg
js/    calc.js  store.js  charts.js  ocr.js  ui.js  panels.js  app.js  sample-data.js  manipal-calendar.js
data/  muj-2026-27.json  muj-2026-27.days.txt        # scraper output
scripts/ sync-calendar.mjs  write-samples.mjs
samples/ timetable-sample.csv  calendar-sample.csv  sample-data.json
tests/  calc.test.mjs
```

---

## Credits and known limits

- Interface details are adapted from two component libraries and reimplemented in plain CSS/JS: the
  faint pointer spotlight on cards from **React Bits**' *Spotlight Card*
  (<https://reactbits.dev>), and the animated summary numbers plus the scroll progress bar from
  **Rare UI**'s *Animated counter* / *Scroll Progress* (<https://www.rareui.com>). No component code
  was copied; both are credited here. Check their licences before shipping
  anything commercial.
- Calendar data belongs to the college; the bundled file is MUJ's published 2026-27 PDF, included to
  make the demo work out of the box.
- Known limits: OCR expects a reasonably straight table (photos at an angle need cropping first); the
  scraper understands Manipal-style month-grid PDFs and falls back to a readable day dump for other
  layouts; charts are deliberately simple SVG; there is no multi-device sync — export/import is the
  sync.

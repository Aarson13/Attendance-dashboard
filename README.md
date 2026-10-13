# Attendance dashboard

Two pages, one repository:

- **`/` — the home page.** A dark, centred landing hero with a symmetric glowing hourglass ribbon and
a glass dashboard preview underneath. React 19 + Vite + Tailwind v4, built to `dist/`.
- **`/app.html` — the tracker.** The actual product: static HTML/CSS/vanilla JS, no framework, no
build step, no account. Your semester is kept as **one JSON document in a sync target** you choose:
this site's own Cloudflare database by default (nothing to set up — the first visit claims a space
and keeps its key), or a file in a GitHub repository you own. Every interaction pulls the document,
applies the change and writes it back, so the target is the source of truth. Nothing about your
attendance is stored in the browser.

Both are built around one rule: **you need `p` % attendance in every subject** (`p` defaults to 75%
and is editable). Every number on screen comes from the same formulas, and the academic calendar is
*scraped* from the college's PDF rather than typed in by hand — with OCR kept as the fallback for
notice-board photos.

---

## Quick start

```bash
cd Attendance-dashboard
npm install
npm run dev          # Vite dev server: the home page at / and the tracker at /app.html
```

Then open `/app.html`, go to **Settings → “Where your data lives”**, and pick a target:

1. **this site's database** (the default whenever the page is served over http) — nothing to fill in.
   The first save claims a *space* and keeps its key in that browser; **Show space id & key** is what
   you paste into a second device to carry the semester over.
2. **a GitHub repository** — the owner and repository (the code repository works, or a separate
   private one), plus a **fine-grained personal access token** with *Contents: read and write* on just
   that repository (GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained
   tokens*).

Press **Save & test** and the tracker writes its first document. After that, every tap marks a class
and writes it, and the topbar chip tells you it happened.

To serve the built site exactly as it ships:

```bash
npm run build        # vite build + copies the tracker into dist/
npm run serve        # static server for dist/ → home page at /, tracker at /app.html
```

Then either press **Settings → Load sample semester** to explore a complete demo, or start with
**Subjects → add a subject**. The landing page's *Get started* / *View demo* buttons link to
`./app.html` and `./app.html?demo=1`; the `?demo=1` URL offers the sample semester on arrival.

The tracker alone needs no build at all — `npm run serve:tracker` serves this folder directly, and
`npx -y serve@14 -l 4173 .` (or `python -m http.server 4173`) does the same.

> Opening the tracker straight from disk (`file://`) works for everything except OCR and the
> service worker: browsers block those on `file://`, and `fetch()` of local JSON is blocked too.
> Serving over localhost is recommended.

---

## Tech

| Concern | Choice | Why |
|---|---|---|
| Home page | React 19 + Vite + Tailwind v4, no UI kit | one page, componentised, and the tracker beside it stays build-free |
| Tracker UI | plain HTML + CSS + classic `<script>` files | no build step, readable in five years, works offline |
| State | one JSON document, rendered as plain functions of it | every number on screen comes from `js/calc.js` |
| Charts | hand-rolled SVG (`js/charts.js`, and the preview's own `TrendChart.jsx`) | one less CDN dependency, still works offline |
| Fonts | Inter Variable, self-hosted via `@fontsource-variable/inter` | no third-party request on first paint |
| OCR | Tesseract.js from a CDN, only loaded when you press *Run OCR* | images are processed in your browser, never uploaded |
| Storage | a JSON file in your GitHub repository | no server to run or pay for; git history is a free audit trail and undo; open the file on any device |
| Sync | `js/github.js` over the GitHub Contents API | pull-merge-push per interaction, with sha conflict handling and no credentials in the document |
| Calendar | `scripts/sync-calendar.mjs` (Node + `pdfjs-dist`) | the calendar is scraped from the official PDF, then imported |
| Post-build | `scripts/copy-tracker.mjs` | the tracker has no build step, so the home page's build copies it into `dist/` |

Interaction contract, worth knowing before editing any view: **one `data-act` attribute, two event
paths.** Buttons, links and images run their action on `click`; `input`/`select`/`textarea` run
theirs on `change` only. The click delegate deliberately ignores form controls — running their
action on click would `preventDefault()` the file pickers into never opening and re-render the field
under your cursor (native date pickers, sliders and dropdowns all break that way).

---

## Where your data lives (the built-in database, the default)

The tracker's document — subjects, timetable, calendar, marks, settings — is one JSON object, and by
default it lives as a row in the site's own Cloudflare D1 database (`worker/api.js`, served by the
same Worker that serves the static files):

- **First use claims a space.** `POST /api/spaces` mints a 12-character space id and a 32-character
  key; the server stores only the SHA-256 of the key, and the browser keeps the pair. That is the
  whole credential model — no account, no token, nothing typed.
- **Every read and write carries the key**, so a space is readable and writable only by devices that
  hold it. `Settings → Sync → Show space id & key` is how a phone joins the same semester; a write
  with a foreign `Origin` is refused as well.
- **`rev` replaces the file's sha.** A write states the rev it was based on, and the server updates
  conditionally (`WHERE rev = ?`), so two devices that read the same rev cannot both win: the loser
  gets `409` with the winner's document attached, merges, and retries once.
- **Screenshots ride in their own kind** (`images` vs `doc`, separate revisions) and are written only
  when the set changes — same trick, second file.

Local development runs the identical stack in workerd:

```bash
npm run build:deploy   # dist/ + deploy/manifest.json (the Cloudflare Sites upload)
npm run dev:api        # wrangler dev on http://127.0.0.1:8787, local D1 included
```

The Vite dev server proxies `/api` to that port, so `npm run dev` syncs too. Deployment itself is a
prebuilt Worker plus static assets: `wrangler.jsonc` is the local twin of `deploy/manifest.json`,
which binds the `DB` (D1) and `ASSETS` and points the Worker at `index.js` / `api.js`.

## Where your data lives (GitHub sync)

Attendance is **not** stored on the device, whichever target you choose. The whole semester is one
JSON document — subjects, timetable, calendar, marks, settings — and with GitHub as the target it
lives in a file in a repository you own, default `attendance.json` on `main`. `js/github.js` is the
only code that touches the network (both targets go through it):

- **On load** the file is pulled, so a fresh browser (or phone) shows your real semester with no
  import step and nothing to lose.
- **On every interaction** the file is pulled again, the change is applied, and the result is
  committed. The repository is the source of truth, and one commit per interaction means the history
  reads like a log of the semester (`Mark CS2001 present`, `Import 214 earlier marks from this
  browser`) and any commit can be reverted in GitHub itself.
- **If another device wrote in the meantime**, the pull notices the file's `sha` moved, the two
  documents are merged (subjects and marks are unioned by id, with this device's values winning on a
  genuine clash) and the write retried once. A write that loses that race is never a silent overwrite.
- **Uploaded timetable screenshots** are the only bulky field, so they ride in a second file
  (`attendance-images.json`) and are committed only when the set actually changes — otherwise every
  tap would push a megabyte into the history for nothing.
- **Failures are visible, not swallowed.** A rejected token, a missing repository, a rate limit and a
  lost race each say what they are: the topbar chip turns red, a toast explains, and the change stays
  in memory marked as unsaved. The tracker never pretends a write succeeded, and it never quietly
  falls back to storing on the device.

**Credentials.** The token is the one thing that may be kept on this device, and only if you tick
*remember the token*. Unticked, it lives in the page for that tab and is gone when the tab is. It is
never written into the JSON document, never logged, and needs *Contents: read and write* on one
repository — nothing else. **If that repository is public, your attendance file is public too**, its
history included; use a private repository for the data if that matters to you.

**What “no device storage” costs.** With nothing cached locally, a change that cannot reach GitHub
lives in memory only: close the tab while offline and that tap is gone, which is why a failed push
shouts instead of whispering. Migration is handled once — if an older version left data in
`localStorage`, the app offers to fold it into the repository and, only after that push succeeds,
deletes it from the browser.

**Trying it without an account:** the home page's *View demo* (`/app.html#demo`) loads the sample
semester **in memory** — no repository, no token, no writes, and every save says so.

---

## The home page (`index.html` + `src/`)

```
index.html              dev entry; Vite builds it to dist/index.html
vite.config.js          react() + tailwindcss(), base: './' so the site works from any sub-path
src/
  main.jsx              mounts <App/> and imports the design system once
  App.jsx               Nav → Hero → DashboardPreview → Footer
  styles/index.css      the design tokens (@theme), keyframes and component classes
  data/attendance.js    placeholder attendance data + the maths the preview draws
  lib/hooks.js          useScrolled, useReveal (staggered reveal), usePrefersReducedMotion
  components/
    Nav.jsx             logo, centred links, white pill CTA, hamburger under md, blurs on scroll
    Hero.jsx            the copy (pill tag, headline, subtext, two buttons) over the ribbon
    HeroRibbon.jsx      the hourglass ribbon: 3 stacked SVG layers + ambient glow + grain + mask
    GlassCard.jsx       the one card surface (4% fill, hairline border, 20px blur, 18px radius)
    StatRow.jsx         overall %, attended, missed, classes I can still bunk
    SubjectRings.jsx    per-subject progress rings (green ≥75%, amber 70–75%, red <70%)
    Ring.jsx            one SVG ring
    TrendChart.jsx      12-week line with a violet→lavender gradient and a glow underneath
    TodayClasses.jsx    today's timetable with Present / Absent / Cancelled / Not-marked chips
    Alerts.jsx          subjects below the minimum, worst first, with "attend N more"
    DashboardPreview.jsx  lays the preview out and owns the section ids the nav links to
    Footer.jsx
scripts/copy-tracker.mjs  postbuild: app.html + styles.css + sw.js + manifest + js/ data/ samples/ → dist/
tests/home-data.test.mjs  the preview's maths, in Node
```

**Colours, blur radii and radius live in one `@theme` block** in
[`src/styles/index.css`](src/styles/index.css), so each is both a CSS variable and a Tailwind
utility: `--color-ink`, `--color-violet` (#6D4AFF), `--color-lavender` (#A78BFA), `--color-core`
(#EFE7FF), `--blur-outer` (24px), `--blur-middle` (35px), `--blur-ambient` (100px), `--blur-glass`
(20px), `--radius-card` (18px). Green/amber/red appear only as *data* states — attendance bands,
chips and the low-attendance warning — never as decoration.

**The ribbon** is one closed cubic-Bézier bowtie path drawn three times, widest to narrowest (violet
`flare 236`, lavender `flare 168 / inset 46`, near-white core `flare 34 / inset 150`), each layer
blurred with its own token, all compositing with `mix-blend-mode: screen` so the narrow middle where
they overlap is the brightest point. A blurred violet radial adds the ambient glow, a 5%
`feTurbulence` layer keeps the large gradients from banding, and a radial `mask-image` on the stage
melts the flares into the page. Above and below the copy the hero fades to pure black through
`.hero-bg`, so the ribbon never ends on a hard edge.

| Viewport | Worst hero text contrast (brightest pixel behind the glyphs) |
|---|---|
| 390px | white 18.9:1 · muted 7.4:1 |
| 768px | white 18.7:1 · muted 7.4:1 |
| 1024–1440px | white 15.6:1 · muted 6.1:1 |
| 1920px | white 15.8:1 · muted 6.2:1 |

Those numbers come from rendering the page with the glyphs made transparent and measuring the
brightest pixel inside each text element's own box — the pessimistic reading, i.e. what the letters
actually sit on. 390px and 1440px were re-measured with every animated ribbon layer pinned at its
*brightest* frame; the widths between them were measured mid-cycle, inside the same range. Keeping them above the 4.5:1 floor is the job of `.hero-shield`, a soft radial veil
over the copy; it is the reason the middle of the ribbon is calmer than its glow either side
(`min(940px, 150vw)` wide, because on a phone the copy is nearly full-bleed).

**Motion** is CSS-only and honours `prefers-reduced-motion`: the ribbon breathes over 9s (the ambient
glow over 10s, so the two never lock together), the hero copy rises in on load, the preview cards
stagger in as they scroll into view, and every animation collapses to nothing when the OS asks for
reduced motion. Because the animated layers change how bright the ribbon is behind the copy, the
contrast figures above were re-measured with **every layer pinned at its brightest frame**
(`scale(1.035)`, glow 0.64, core 0.96) — the ceiling of the cycle, not one lucky instant.

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
   You can also bring a timetable in four ways:
   - **Quick add** — describe it in English in the box at the top of the tab
     (`CS2001 Mon 9-10, Wed 11-12`, `Mon: CS2001, MA2002, CS2005`); see below.
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

## Quick add: describing a timetable in English

The Timetable tab opens with one box that reads plain English:

```
CS2001 Mon 9-10, Wed 11-12       one subject, twice a week
Mon-Fri P1 CS2001                every weekday, first period
Mon: CS2001, MA2002, CS2005      a whole day's column — P1, P2, P3 in order
DSA Lab Thu 2-4                  an afternoon lab
Fri 3:30 CS2004                  a time the grid rounds to a period
```

It parses as you type and shows every slot it worked out — day, period, resolved subject, lab —
before anything is written. Four chips (Day, Time, Subject, Lab) light up as each part of the
sentence is recognised, *Add to timetable* stays off while a row still needs a subject, and each row
can be corrected (subject, lab, drop) right there. Parsing is `js/magic.js`: a pure function of the
text and the document, with no network and no model, so the box stays instant and offline. Nothing is
written until you press Add, and then it is one commit like any other edit.

- **Days** — `Mon`, `Monday`, `Tue & Thu`, `Mon-Fri` (Sunday is not a school day).
- **Times** — `9-10`, `09:00-10:00`, `2-4` (afternoon), `3:30`, `9am`; or a period: `P2`,
  `period 3`, or a lone `3`. A time that only *rounds* to a period says which one it picked.
- **Subjects** — by code, full name or a distinctive part of one, through the same fuzzy matcher the
  OCR review uses. A near-miss is pre-selected but marked *unsure*; anything unplaceable comes back
  red with a subject picker and *create a new subject from this text* — never a silent guess.
- **Guesses are named, not hidden.** A day column typed without times fills the periods in order and
  says it did; a line that leaves out the time keeps the one before it, marked *same time as the line
  before*; a lab in the last period is flagged because it cannot span two. A line it cannot place at
  all — no day, no time, a repeated slot, Sunday — is explained instead of dropped.

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

- Attendance lives in **your** sync target and nowhere else: no account with us. With the built-in
  database that is this site's own D1 (a space protected by its key); with GitHub as the target, the
  only origin the app talks to is `api.github.com`. The other origins the browser is allowed to touch
  are the one-time Tesseract.js download (engine + English model, from a CDN) when you run OCR, and
  the hosting platform's own usage beacon (`static.cloudflareinsights.com`, cookieless, injected into
  every page it serves — blocking it made the host unable to account for the site and it suspended
  serving, which is why it is allowed).
- The app needs nothing else: the built-in target asks for no token, and the GitHub target needs
  *Contents: read and write* on the one repository you name.
- With no local copy, the app is honest about needing the network: the shell and the OCR engine are
  cached by `sw.js`, so it *opens* offline, but until a save reaches GitHub the topbar chip says it
  has not been saved.
- Add it to a phone home screen — `manifest.webmanifest` + `icon.svg` are included.

---

## Security notes

Small app, small attack surface: no account, no third-party JavaScript at runtime except the one OCR
engine, and a backend of one Worker whose API is a space claim plus a conditional write
(`worker/api.js`) — the only state it holds is the document and a hash of the key that guards it.
The pieces that are not obvious from the code:

- **The policy is in `app.html`** (a meta CSP, since the app is static): the only script origins are
  the app's own files and `cdn.jsdelivr.net`, no inline script exists, `object-src`/`base-uri`/
  `form-action` are closed, and `connect-src` lists the GitHub API plus the two OCR hosts. The landing
  page carries the parts of the policy that cannot fight the Vite dev server
  (`index.html`), and `_headers` adds the rest for hosts that read it — `X-Content-Type-Options`,
  `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors` and a real CSP header per page. GitHub Pages
  and `npx serve` ignore `_headers`, so there the meta policy is what you get.
- **The CDN script is pinned twice**: `js/ocr.js` loads `tesseract.js@6.0.1` with a `sha384` integrity
  hash, so a substituted CDN response is refused by the browser instead of executed. Bumping the
  version means recomputing that hash (the comment above the loader says how).
- **Source URLs are scheme-checked, never merely escaped.** `escapeHtml` cannot make
  `javascript:alert(1)` safe — it is valid HTML — so the only place a URL becomes an `href`
  (`js/panels.js`) goes through `Store.safeUrl`, and `Store.normalize` strips a non-http(s) URL as it
  reads the document, so a hostile one never reaches the DOM at all.
- **Files this app did not write are treated as untrusted**: `Store.normalize` and `Github.merge`
  drop `__proto__`/`constructor`/`prototype` keys before folding a document in, so a repository file
  or an imported snapshot cannot reach an `Object.prototype`.
- **The token stays out of the document, the URL and the log.** It lives in memory unless you tick
  *remember on this device*, in which case it is one `localStorage` key; nothing logs it, and it is
  never part of the JSON that is committed.

---

## Tests

```bash
npm test              # 73 tests: engine, home-page data, the sync client and the quick-add parser
npm run build         # a failure here is a real failure, not a warning to read past
```

29 of them cover the counting rules, the semester scheduler (labs, holidays, exam windows, swapped
days, holiday-beats-swap), the CSV/ICS/JSON importers, the OCR grid + date parsers, the crop-to-source
mapping used when an image is rotated before OCR, the 100%-threshold edge case, the sample
dataset's internal consistency, and the existing-attendance maths: carried counts reach `a`/`t`, the
buffer, recovery, projections, the overall and credit-weighted totals and the trend baseline;
impossible pairs (attended > held) are clamped rather than believed, and junk in a hand-edited backup
is repaired on import. Two of the 32 go at the untrusted edges instead: a document full of
prototype-shaped keys is normalised without touching `Object.prototype`, and a non-http(s) source URL
(including a `JaVaScRiPt:` one) is dropped by `Store.safeUrl` — both on import and in a scraped
snapshot. The engine files are dependency-free and DOM-free on purpose, which
is what makes them testable; `js/app.js` is the one file that needs a DOM, so its event wiring is
verified in a browser rather than here.

`tests/home-data.test.mjs` adds 8 more for the home page's data layer: `attended / total × 100`, the
configurable minimum moving the three colour bands with it, the `ceil((p·t − a) / (1 − p))` recovery
formula including the 100%-threshold `null`, safe misses, the pooled overall figures (Σa / Σt, not the
average of the percentages), the placeholder data's internal consistency, and the alert ordering.
The React components themselves need a DOM, so they are verified in a browser (see the contrast
table above) rather than in this suite.

`tests/magic.test.mjs` adds 17 for the quick-add parser: a subject placed on the days and periods it
names (including a time resolved through a period's *end*), a day range expanded over the week, a day
column filled in order and flagged as assumed, one time shared across several days, a follow-up line
inheriting the day and time before it, days and times paired when both are listed, afternoon
readings (`2-4` is 14:00, and `3:30` says it rounds into P6), a spoken period and a lone number, an
unknown subject handed back for a decision, a partial name matched against a rough one flagged
unsure, a bare `lab` keeping the subject from the line before, repeated slots keeping the last one,
a lab called out in the last period, warnings for the lines it cannot place — and that `Magic.apply`
writes the same cell shape the grid editor does, which the app's own scheduler then reads back.

`tests/github.test.mjs` adds 17 for the sync client, against a scripted Contents API: a pasted URL
is cleaned up and a token is required before anything syncs; the token never reaches the document;
base64 round-trips the real strings in a timetable; a missing file is a first run, not an error; a
file too large to be inlined is read through the blob endpoint; broken JSON is reported instead of
half-applied; a write carries the `sha` it read and the commit message it was given; a **409 re-reads,
merges both devices and writes once more**; simultaneous interactions share one commit while
sequential ones get one commit each, with the API never seeing two writes at once; a rejected token,
a permission error and a rate limit are three different messages (and a rate limit stops further
requests before they are spent); a dead network is a `network` error that leaves the change flagged
as unsaved; and the merge unions subjects and marks by id without dropping either side — and refuses
a prototype-shaped remote document rather than adopting its keys.

## Repository layout

```
index.html  vite.config.js          # the home page (built by Vite into dist/)
app.html    styles.css  sw.js  manifest.webmanifest  icon.svg  _headers
js/    calc.js  store.js  github.js  charts.js  ocr.js  magic.js  ui.js  panels.js  app.js  sample-data.js  manipal-calendar.js
data/  muj-2026-27.json  muj-2026-27.days.txt        # scraper output
src/   main.jsx  App.jsx  data/attendance.js  lib/hooks.js  styles/index.css  components/*.jsx
scripts/ sync-calendar.mjs  write-samples.mjs  copy-tracker.mjs  build-deploy.mjs
worker/  worker.js  api.js                  # the sync API + security headers; wrangler.jsonc runs it locally
samples/ timetable-sample.csv  calendar-sample.csv  sample-data.json
tests/  calc.test.mjs  home-data.test.mjs  github.test.mjs  cloud-sync.test.mjs  worker-api.test.mjs
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
- Known limits: nothing is cached on the device, so an interaction made while GitHub is unreachable
  survives reload only if the push eventually succeeds — the app says so loudly rather than pretending,
  and the alternative (a local cache) is exactly what this design avoids; the API allows 5,000
  authenticated requests an hour per user, which a term's marking never approaches but a stuck retry
  loop could, so a rate limit pauses syncing until GitHub's own reset time; a public repository makes
  the attendance file public; the hero's copy sits over the brightest part of the ribbon, so the veil that keeps it
  at ≥4.5:1 is also what makes the ribbon's middle dimmer than its glow either side — the shape is
  visible around the text, not through it; OCR expects a reasonably straight table (photos at an angle
  need cropping first); the scraper understands Manipal-style month-grid PDFs and falls back to a
  readable day dump for other layouts; charts are deliberately simple SVG; the home page's sample
  semester is illustrative data in `src/data/attendance.js`, not the tracker's own `localStorage`
  state, so the two never need to agree; there is no multi-device sync — export/import is the sync.

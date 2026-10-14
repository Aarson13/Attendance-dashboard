/* magic.js — the natural-language timetable entry ("quick add").
 *
 * One line of English in, timetable cells out: "CS2001 Mon 9-10, Wed 11-12" or "Mon: CS2001, MA2002"
 * or "DSA Lab Thu 2-4". Parsing is pure and local — no network, no OCR — and it *never writes*: it
 * answers with rows + warnings + a guidance error, the panel renders that live as you type, and the
 * user presses Add. Anything the parser had to guess (a time that only rounds to a period, a day
 * column typed without times) comes back flagged `assumed` and is named in the warnings, so a guess
 * can never be committed silently.
 *
 * The grammar, in the order each part is peeled off a phrase:
 *   days     Mon, Monday, "Tue & Thu", Mon-Fri, "every Mon"      → 1..6 (Sunday is never a school day)
 *   time     "9-10", "2-4", "3:30", "9am", "2pm to 4pm"          → the period whose start/end matches
 *   period   "P2", "period 3", "3rd period", or a lone number     → that period's label
 *   kind     lab / practical / tutorial (or a subject named "… Lab")
 *   subject  "CS2001", "Discrete Maths", "DSA Lab"                → AD.Ocr.fuzzyMatch, never a guess
 *   column   "Mon: CS2001, MA2002"                                → P1, P2 in order (flagged assumed)
 */
(function (global) {
  'use strict';

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  /** Words that are grammar, never part of a subject name — stripped from the ends of what's left. */
  const CONNECTORS = new Set(['add', 'put', 'at', 'on', 'in', 'for', 'from', 'to', 'till', 'until', 'the', 'a', 'an', 'of', 'and', 'with', 'my', 'new', 'every', 'each', 'all', 'class', 'classes', 'lecture', 'lectures', 'please', 'timing', 'time', 'onwards']);
  const LAB_WORD = /\b(labs?|practicals?|pracs?|tutorials?|tuts?|workshops?|studios?)\b/i;
  const SUNDAY = /^(sun|sunday)$/i;

  /** Shown as one-tap examples under the box: the shapes people actually type. */
  const EXAMPLES = [
    { text: 'CS2001 Mon 9-10, Wed 11-12', hint: 'one subject, twice a week' },
    { text: 'Mon-Fri P1 CS2001', hint: 'every weekday, first period' },
    { text: 'Mon: CS2001, MA2002, CS2005', hint: "a whole day's column, no times needed" },
    { text: 'DSA Lab Thu 2-4', hint: 'an afternoon lab' },
    { text: 'Fri 3:30 CS2004', hint: 'a time the grid rounds to a period' },
  ];

  const byStart = (a, b) => String(a.start || '').localeCompare(String(b.start || ''));
  const dayName = (day) => DAY_NAMES[day - 1] || `day ${day}`;
  const listify = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

  function normalise(text) {
    return String(text == null ? '' : text)
      .replace(/\r/g, '\n')
      .replace(/[\u2013\u2014\u2012\u2212]/g, '-') // en/em dash → plain hyphen
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function store() {
    return global.AD && global.AD.Store;
  }

  /** "monday" → 1, "Tue" → 2, "Funday" → null. Alphabetic tokens only, so "3" is never a day. */
  function dayOf(word) {
    const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    const S = store();
    if (w.length < 3 || !S) return null;
    return S.dayNumber(w);
  }

  /** "9", "9:30", "9.30", "2pm" → "HH:MM". A bare 1..7 is an afternoon hour, as on any class timetable. */
  function clock(hour, minutes, mer) {
    let h = Number(hour);
    if (!isFinite(h) || h > 23) return null;
    const m = minutes == null || minutes === '' ? 0 : Number(minutes);
    if (!isFinite(m) || m > 59) return null;
    if (mer) {
      const pm = /p/i.test(mer);
      if (h === 12) h = pm ? 12 : 0;
      else if (pm) h += 12;
    } else if (h >= 1 && h <= 7) {
      h += 12;
    }
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const minsOf = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  /** "P3", "3", "slot 3", or a label like "Period 3" → that period. */
  function periodByNumber(n, periods) {
    const want = String(n);
    return (
      periods.find((p) => {
        const label = String(p.label || '').toLowerCase();
        const id = String(p.id || '').toLowerCase();
        if (label === `p${want}` || id === `p${want}` || label === want || id === want) return true;
        const digits = label.replace(/\D+/g, '');
        return !!digits && digits === want;
      }) || null
    );
  }

  /**
   * A clock time → the period it belongs to. Exact start beats exact end beats "inside" beats
   * "within ten minutes of a start" — each weaker step is reported through `how` so the preview can
   * say that it rounded ("your 11:00 → P3, which starts 11:05").
   */
  function periodByTime(time, periods, opts) {
    const exactOnly = !!(opts && opts.exactOnly);
    const target = minsOf(time);
    if (target == null) return null;
    const sorted = periods.filter((p) => p.start).slice().sort(byStart);
    const start = sorted.find((p) => minsOf(p.start) === target);
    if (start) return { period: start, how: 'start' };
    const end = sorted.find((p) => p.end && minsOf(p.end) === target);
    if (end) return { period: end, how: 'end' };
    if (exactOnly) return null;
    const inside = sorted.find((p) => p.end && minsOf(p.start) < target && target < minsOf(p.end));
    if (inside) return { period: inside, how: 'inside' };
    let near = null;
    for (const p of sorted) {
      const delta = Math.abs(minsOf(p.start) - target);
      if (delta <= 10 && (!near || delta < near.delta)) near = { period: p, how: 'near', delta };
    }
    return near;
  }

  function resolveRange(fromTime, toTime, periods) {
    return (
      periodByTime(fromTime, periods, { exactOnly: true }) ||
      (toTime ? periodByTime(toTime, periods, { exactOnly: true }) : null) ||
      periodByTime(fromTime, periods) ||
      (toTime ? periodByTime(toTime, periods) : null)
    );
  }

  function cleanLabel(text) {
    const words = String(text || '').split(' ').filter(Boolean);
    while (words.length && (CONNECTORS.has(words[0].toLowerCase()) || /^[^\w]+$/.test(words[0]))) words.shift();
    while (words.length && (CONNECTORS.has(words[words.length - 1].toLowerCase()) || /^[^\w]+$/.test(words[words.length - 1]))) words.pop();
    return words.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * One phrase → the pieces it mentions. Days, times and periods are removed from the text as they
   * are recognised; whatever survives is the subject name. Returns:
   *   { days[], specs[{period, how, text}], text, lab, sunday }
   */
  function readItem(raw, periods) {
    let text = ` ${String(raw || '')} `;
    const days = [];
    const specs = [];
    let sunday = false;

    // day ranges first: "Mon-Fri" has to be read before "Mon" is taken as a lone day
    text = text.replace(/\b([a-z]{3,9})\s*-\s*([a-z]{3,9})\b/gi, (all, a, b) => {
      const from = dayOf(a);
      const to = dayOf(b);
      if (from == null || to == null) return all;
      const step = from <= to ? 1 : -1;
      for (let d = from; d !== to + step; d += step) if (d >= 1 && d <= 6 && days.indexOf(d) < 0) days.push(d);
      return ' ';
    });

    // day words anywhere in the phrase: "Mon 9-10", "9-10 on Tuesday", "Tue & Thu"
    text = text.replace(/\b([a-z]{3,9})\b/gi, (all, word) => {
      if (SUNDAY.test(word)) {
        sunday = true;
        return ' ';
      }
      const d = dayOf(word);
      if (d == null) return all;
      if (days.indexOf(d) < 0) days.push(d);
      return ' ';
    });

    // a clock range: "9-10", "09:00 - 10:00", "9.30 to 10.30", "2pm-4pm"
    text = text.replace(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|to|till|until)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/gi, (all, h1, m1, mer1, h2, m2, mer2) => {
      const from = clock(h1, m1, mer1);
      const to = clock(h2, m2, mer2);
      const hit = from && resolveRange(from, to, periods);
      if (!hit) return all;
      specs.push({ period: hit.period, how: hit.how, text: all.trim() });
      return ' ';
    });

    // a spoken period: "P2", "period 3", "3rd period", "slot 4", "hour 5"
    text = text.replace(/\b(?:p|per|period|slot|hour|hr|lecture)\s*\.?\s*(\d{1,2})\b/gi, (all, n) => {
      const per = periodByNumber(n, periods);
      if (!per) return all;
      specs.push({ period: per, how: 'label', text: all.trim() });
      return ' ';
    });
    text = text.replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:period|hour|slot|lecture|class)\b/gi, (all, n) => {
      const per = periodByNumber(n, periods);
      if (!per) return all;
      specs.push({ period: per, how: 'label', text: all.trim() });
      return ' ';
    });

    // a single clock time: "3:30", "09:00", "9am", "2 pm"
    text = text.replace(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/gi, (all, h1, m1, mer1, h2, mer2) => {
      const at = clock(h1 == null ? h2 : h1, h1 == null ? null : m1, h1 == null ? mer2 : mer1);
      const hit = at && periodByTime(at, periods);
      if (!hit) return all;
      specs.push({ period: hit.period, how: hit.how, text: all.trim() });
      return ' ';
    });

    // a lone number is the period ("Mon 2" = second period); only if no time was named yet
    if (!specs.length) {
      text = text.replace(/(?:^|\s)(\d{1,2})(?=\s|$)/, (all, n) => {
        const byLabel = periodByNumber(n, periods);
        const hit = byLabel ? { period: byLabel, how: 'label' } : periodByTime(clock(n), periods);
        if (!hit) return all;
        specs.push({ period: hit.period, how: hit.how, text: n });
        return ' ';
      });
    }

    const cleaned = cleanLabel(text.replace(/\s+/g, ' ').trim());
    // "lab" on its own is a kind, not a name: "CS2001 Mon 9-10, Fri P2 lab" means the same subject
    // again, on Friday, as a lab — so the name is left empty and inherited from the line before.
    const named = cleaned.replace(new RegExp(LAB_WORD.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
    return { days, specs, text: named ? cleaned : '', lab: LAB_WORD.test(raw), sunday };
  }

  function matchSubject(label, subjects) {
    const Ocr = global.AD && global.AD.Ocr;
    if (!Ocr || !Ocr.fuzzyMatch || !label) return null;
    return Ocr.fuzzyMatch(label, subjects);
  }

  const uniqueBy = (list, key) => {
    const seen = new Set();
    return list.filter((v) => {
      const k = key(v);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  /**
   * Parse a whole box of English into timetable rows.
   * → { rows: [{ day, periodId, subjectId, text, state, score, reason, lab, how }], warnings[], error }
   * `state` mirrors the OCR review screen: 'matched' | 'low' (a rough match, pre-selected and flagged)
   * | 'unmatched' (pick a subject or create one). Nothing here touches the data model.
   */
  function parse(rawText, data) {
    const out = { rows: [], warnings: [], error: null };
    const text = normalise(rawText);
    if (!text) return out;
    const settings = (data && data.settings) || {};
    const subjects = (data && data.subjects) || [];
    const periods = (settings.periods || []).filter((p) => p && p.start).slice().sort(byStart);
    if (!periods.length) {
      out.error = 'No periods are set up yet — add them under “Edit periods” below first.';
      return out;
    }
    const labelOf = (periodId) => {
      const p = periods.find((x) => x.id === periodId);
      return p ? String(p.label || p.id) : periodId;
    };

    let carry = { day: null, spec: null, text: '', subjectId: null };
    const assumed = {}; // day → period labels filled without a time, reported once at the end
    const seenAt = {}; // "day:period" → row index, so a repeat replaces the earlier row
    const spanWarned = new Set();
    let skippedSunday = false;

    for (const segment of text.split(/\n|;/).map((s) => s.trim()).filter(Boolean)) {
      // "Mon: CS2001, MA2002" — a day (or day list) colon, then one subject per line of that day
      let body = segment;
      let column = null;
      const colon = /^([^:]{0,60}):\s*(.+)$/.exec(segment);
      if (colon) {
        const left = readItem(colon[1], periods);
        if (left.days.length && !left.specs.length && !left.text) {
          column = left.days;
          body = colon[2];
        }
      }

      // Each comma-separated phrase is read on its own; what it leaves out is inherited from the one
      // before it, which is what makes "CS2001 Mon 9-10, Wed 11-12" work in either order.
      const items = body.split(',').map((s) => s.trim()).filter(Boolean).map((s) => readItem(s, periods));
      // One time for several days ("CS2001 Mon, Wed, Fri 9-10") applies to every line that lacks one.
      const distinct = uniqueBy(items.reduce((all, it) => all.concat(it.specs), []), (s) => s.period.id);
      const shared = distinct.length === 1 && items.some((it) => !it.specs.length) ? distinct[0] : null;

      items.forEach((item, index) => {
        if (item.sunday) {
          skippedSunday = true;
          return;
        }
        const days = item.days.length ? item.days : column || (carry.day != null ? [carry.day] : []);
        const subjectText = item.text || (item.days.length || item.specs.length || item.lab ? carry.text : '');
        const match = matchSubject(subjectText, subjects);
        const state = !match ? 'unmatched' : match.matched ? 'matched' : match.confidence === 'low' ? 'low' : 'unmatched';
        const subject = state === 'unmatched' ? null : subjects.find((s) => s.id === match.subjectId) || null;

        let specs = item.specs.slice();
        if (!specs.length && shared && (item.days.length || column)) specs = [shared];
        // "… Mon 9-10 CS2001, Wed" — a bare follow-up keeps the time it belongs to
        if (!specs.length && carry.spec && (!item.text || (subject && subject.id === carry.subjectId))) specs = [{ period: carry.spec.period, how: 'same', text: '' }];
        if (!specs.length && column) {
          const per = periods[Math.min(index, periods.length - 1)];
          specs = [{ period: per, how: 'assumed', text: '' }];
          if (index >= periods.length) out.warnings.push(`“${subjectText || 'that line'}” has more entries than ${dayName(days[0] || 1)} has periods.`);
        }

        if (!days.length) {
          out.warnings.push(`“${segment}” doesn't name a day — add “Mon”, “Tue & Thu” or “Mon-Fri”.`);
          return;
        }
        if (!specs.length) {
          out.warnings.push(`${subjectText || 'That line'} on ${dayName(days[0])}: no time — add “9-10” or “P2”.`);
          return;
        }

        const pairs =
          days.length > 1 && specs.length > 1
            ? (() => {
                const n = Math.min(days.length, specs.length);
                if (days.length !== specs.length) {
                  out.warnings.push(`“${segment}” reads as ${days.length} day(s) and ${specs.length} time(s) — paired the first ${n} in order.`);
                }
                return days.slice(0, n).map((day, i) => [day, specs[i]]);
              })()
            : days.reduce((all, day) => all.concat(specs.map((spec) => [day, spec])), []);

        for (const [day, spec] of pairs) {
          const isLab = item.lab || !!(subject && /\blab\b/i.test(subject.name || ''));
          const row = {
            day,
            periodId: spec.period.id,
            subjectId: subject ? subject.id : null,
            text: subjectText,
            state,
            score: match ? match.score : 0,
            reason: match ? match.reason : '',
            lab: isLab,
            how: spec.how,
            // true when the period was not actually written down: filled in for a day column, or
            // inherited from the line before. The preview says so on the row instead of pretending.
            assumed: spec.how === 'assumed' || spec.how === 'same',
            specText: spec.text || '',
          };
          const key = `${day}:${row.periodId}`;
          if (seenAt[key] != null) {
            const name = subject ? subject.name : subjectText || 'that line';
            out.warnings.push(`${dayName(day)} ${labelOf(row.periodId)} was given twice — kept “${name}”.`);
            out.rows[seenAt[key]] = row;
          } else {
            seenAt[key] = out.rows.length;
            out.rows.push(row);
          }
          if (isLab && periods.indexOf(spec.period) === periods.length - 1) {
            const note = `${labelOf(spec.period.id)} is the last period of the day — a lab there can't span two periods.`;
            if (!spanWarned.has(note)) {
              spanWarned.add(note);
              out.warnings.push(note);
            }
          }
          if (spec.how === 'assumed') (assumed[day] = assumed[day] || []).push(labelOf(row.periodId));
        }

        carry = {
          day: days[days.length - 1],
          spec: specs[specs.length - 1],
          text: item.text || carry.text,
          subjectId: subject ? subject.id : carry.subjectId,
        };
      });
    }

    for (const day of Object.keys(assumed)) {
      out.warnings.push(`${dayName(Number(day))}: no times given, so ${listify(assumed[day])} were filled in order.`);
    }
    if (skippedSunday) out.warnings.push('Sunday is not one of your school days — that line was skipped.');

    if (!out.rows.length) {
      out.error = skippedSunday
        ? 'Sunday is not a school day — try a Monday to Saturday slot.'
        : 'Nothing to add yet — try “CS2001 Mon 9-10, Wed 11-12”.';
    }
    return out;
  }

  /**
   * Write parsed rows into a timetable, in the same cell shape the CSV importer and the grid editor
   * use ({ subjectId, lab }), so nothing downstream can tell them apart. A row whose subject is still
   * unresolved is skipped and counted — the panel refuses the Add button before it gets here.
   */
  function apply(rows, data) {
    let applied = 0;
    let skipped = 0;
    for (const row of rows || []) {
      if (!row || !row.subjectId || !row.periodId || !row.day) {
        skipped++;
        continue;
      }
      const day = String(row.day);
      if (!data.timetable[day]) data.timetable[day] = {};
      data.timetable[day][row.periodId] = { subjectId: row.subjectId, lab: !!row.lab };
      applied++;
    }
    return { applied, skipped };
  }

  const api = { EXAMPLES, parse, apply, readItem };
  global.AD = global.AD || {};
  global.AD.Magic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ocr.js — in-browser OCR for timetables and academic-calendar notices.
 *
 * Privacy: images are read with FileReader, preprocessed on a <canvas> and sent to a Tesseract
 * worker that runs in this browser. Nothing is uploaded; the only network traffic is the one-time
 * download of tesseract.js + its english model from a CDN.
 *
 * The parsers below never guess silently: every cell keeps a confidence and an "unmatched" state so
 * the Review & Fix screen can colour it yellow/red. Nothing is written to the timetable until the
 * user presses Confirm (the UI enforces that; this module only produces candidates).
 */
(function (global) {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const DAY_WORDS = [
    ['monday', 'mon', 'm0n'],
    ['tuesday', 'tue', 'tues', 'tuse'],
    ['wednesday', 'wed'],
    ['thursday', 'thu', 'thur', 'thurs'],
    ['friday', 'fri'],
    ['saturday', 'sat'],
  ];

  /* ---------- CDN loader (tesseract is only fetched when the user actually runs OCR) ---------- */
  let loader = null;
  function loadTesseract(src) {
    if (global.Tesseract) return Promise.resolve(global.Tesseract);
    if (loader) return loader;
    loader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src || CDN;
      s.async = true;
      s.onload = () => (global.Tesseract ? resolve(global.Tesseract) : reject(new Error('Tesseract loaded but the global is missing.')));
      s.onerror = () => reject(new Error('Could not load tesseract.js from the CDN. Check your connection — OCR needs one online run, then the service worker caches it.'));
      document.head.appendChild(s);
    });
    return loader;
  }

  /* ---------- file helpers ---------- */
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('Could not read that file.'));
      fr.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file is not an image the browser can read.'));
      img.src = dataUrl;
    });
  }

  /**
   * Canvas preprocessing for better OCR: grayscale, contrast stretch, upscale small scans,
   * optional invert (dark timetable photos) and rotation, plus percentage crop.
   * Returns a JPEG data URL (also used, compressed, for the stored reference image).
   */
  async function preprocess(dataUrl, opts) {
    const o = Object.assign({ grayscale: true, contrast: true, upscale: true, invert: false, rotate: 0, crop: [0, 0, 1, 1], maxWidth: 1600, quality: 0.8 }, opts || {});
    const img = await loadImage(dataUrl);
    const rot = ((o.rotate % 360) + 360) % 360;
    const sw = rot % 180 === 0 ? img.naturalWidth : img.naturalHeight;
    const sh = rot % 180 === 0 ? img.naturalHeight : img.naturalWidth;
    const [ct, cl, cr, cb] = o.crop || [0, 0, 1, 1];
    const cw = Math.max(1, Math.round(sw * (cr - cl)));
    const ch = Math.max(1, Math.round(sh * (cb - ct)));
    let scale = 1;
    if (o.upscale && cw < 1200) scale = Math.min(2.5, 1200 / cw);
    if (cw * scale > o.maxWidth) scale = o.maxWidth / cw;
    const outW = Math.round(cw * scale);
    const outH = Math.round(ch * scale);

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    // draw the cropped source region, scaled, centred after rotation
    const dw = (rot % 180 === 0 ? cw : ch) * scale;
    const dh = (rot % 180 === 0 ? ch : cw) * scale;
    ctx.drawImage(img, cl * sw, ct * sh, cw, ch, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();

    const data = ctx.getImageData(0, 0, outW, outH);
    const px = data.data;
    if (o.grayscale || o.contrast) {
      for (let i = 0; i < px.length; i += 4) {
        let v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (o.contrast) v = v < 140 ? Math.max(0, v - 28) : Math.min(255, v + 28); // simple level stretch around paper white
        if (o.grayscale) {
          px[i] = px[i + 1] = px[i + 2] = v;
        }
        if (o.invert) {
          px[i] = 255 - px[i];
          px[i + 1] = 255 - px[i + 1];
          px[i + 2] = 255 - px[i + 2];
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    return { dataUrl: canvas.toDataURL('image/jpeg', o.quality), width: outW, height: outH };
  }

  /** Downscale for storage in localStorage (keeps the side-by-side reference without blowing the quota). */
  async function compressForStorage(dataUrl, maxWidth, quality) {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, (maxWidth || 900) / img.naturalWidth);
    if (scale >= 1) return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality || 0.7);
  }

  /* ---------- tesseract ---------- */
  /** Returns {text, words:[{text, confidence, bbox}], lines:[string]} */
  async function recognise(dataUrl, opts) {
    const o = Object.assign({ lang: 'eng', psm: '3', onProgress: null }, opts || {});
    const Tesseract = await loadTesseract();
    const worker = await Tesseract.createWorker(o.lang, 1, {
      logger: (m) => {
        if (o.onProgress && m && m.status) o.onProgress({ status: m.status, progress: typeof m.progress === 'number' ? m.progress : 0 });
      },
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: String(o.psm) });
      const { data } = await worker.recognize(dataUrl, {}, { text: true, blocks: true });
      const words = [];
      for (const block of data.blocks || []) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const w of line.words || []) {
              if (!w.text || !w.text.trim()) continue;
              words.push({ text: w.text.trim(), confidence: w.confidence, bbox: w.bbox });
            }
          }
        }
      }
      return { text: data.text || '', words, lines: (data.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) };
    } finally {
      try {
        await worker.terminate();
      } catch (err) {
        /* worker already gone */
      }
    }
  }

  /* ---------- text utilities ---------- */
  const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function levenshtein(a, b) {
    a = String(a);
    b = String(b);
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    return prev[n];
  }
  const ratio = (a, b) => {
    if (!a || !b) return 0;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
  };

  function dayIndexFromWord(word) {
    const w = normalise(word);
    if (!w) return null;
    for (let i = 0; i < DAY_WORDS.length; i++) {
      for (const variant of DAY_WORDS[i]) {
        if (w === variant) return i + 1;
        if (w.length >= 3 && ratio(w.slice(0, variant.length), variant) >= 0.8) return i + 1;
      }
    }
    return null;
  }

  /** Fuzzy-match a cell against the user's subjects; returns {subjectId, score, reason} or null. */
  function fuzzyMatch(text, subjects) {
    const cell = normalise(text);
    if (!cell) return null;
    let best = null;
    for (const s of subjects || []) {
      const name = normalise(s.name);
      const code = normalise(s.code);
      const faculty = normalise(s.faculty);
      let score = 0;
      let reason = '';
      if (code && cell.replace(/ /g, '').indexOf(code.replace(/ /g, '')) >= 0 && code.replace(/ /g, '').length >= 3) {
        score = 0.97;
        reason = `code ${s.code}`;
      } else {
        const r = ratio(cell, name);
        if (r > score) {
          score = r * 0.9;
          reason = 'name similarity';
        }
      }
      // distinctive word overlap (e.g. "Compiler Design" inside "COMPILER DESIGN LAB 2")
      const words = name.split(' ').filter((w) => w.length >= 4);
      if (words.length) {
        const overlap = words.filter((w) => cell.indexOf(w) >= 0).length / words.length;
        const wordScore = 0.72 + 0.22 * overlap;
        if (overlap > 0 && wordScore > score) {
          score = wordScore;
          reason = `matched "${words.filter((w) => cell.indexOf(w) >= 0).join(' ')}"`;
        }
      }
      if (faculty && faculty.length >= 4 && cell.indexOf(faculty) >= 0) {
        score = Math.max(score, 0.8);
        reason = 'faculty name';
      }
      if (!best || score > best.score) best = { subjectId: s.id, score, reason, subject: s };
    }
    if (!best) return null;
    best.matched = best.score >= 0.72;
    best.confidence = best.score >= 0.72 ? 'good' : best.score >= 0.5 ? 'low' : 'none';
    return best;
  }

  /* ---------- timetable grid ---------- */
  /**
   * Turn word boxes into grid cells.
   * Detects the orientation from the day headers: a timetable can list days across the top
   * (days = columns) or down the side (days = rows); both are common in college hand-outs.
   */
  function gridFromWords(words) {
    const dayWords = [];
    const headerWordIds = new Set();
    for (const w of words) {
      const di = dayIndexFromWord(w.text);
      if (di) {
        dayWords.push({ index: di, word: w, cx: (w.bbox.x0 + w.bbox.x1) / 2, cy: (w.bbox.y0 + w.bbox.y1) / 2, confidence: w.confidence });
        headerWordIds.add(w);
      }
    }
    if (dayWords.length < 2) return { ok: false, reason: 'Could not find at least two day names (Mon…Sat) in the image.' };

    // pick the best word per weekday (highest confidence), then decide orientation
    const bestPerDay = new Map();
    for (const d of dayWords) {
      const cur = bestPerDay.get(d.index);
      if (!cur || d.confidence > cur.confidence) bestPerDay.set(d.index, d);
    }
    const picks = [...bestPerDay.values()];
    const spreadY = Math.max.apply(null, picks.map((p) => p.cy)) - Math.min.apply(null, picks.map((p) => p.cy));
    const spreadX = Math.max.apply(null, picks.map((p) => p.cx)) - Math.min.apply(null, picks.map((p) => p.cx));
    const daysAreColumns = spreadX >= spreadY;

    // time tokens: single ("09:00") or grouped ("9:00 - 10:00")
    const byLine = new Map();
    for (const w of words) {
      const key = Math.round(((w.bbox.y0 + w.bbox.y1) / 2) / 8);
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(w);
    }
    const single = /^\d{1,2}\s*[:.]\s*\d{2}$/;
    const range = /^\d{1,2}\s*[:.]\s*\d{2}\s*[-–—]\s*\d{1,2}\s*[:.]\s*\d{2}$/;
    const dash = /^(?:[-–—.]{1,3}|to)$/i;
    // (kept as a comment for future tuning: OCR sometimes reads "9.00" and "9 00")
    const hm = (s) => {
      const m = String(s).match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
      const h = m ? parseInt(m[1], 10) : NaN;
      const mm = m ? parseInt(m[2], 10) : NaN;
      if (!(h <= 23) || !(mm <= 59)) return null;
      return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
    const times = [];
    const timeWordIds = new Set();
    for (const [, lineWords] of byLine) {
      const sorted = lineWords.slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
      for (let i = 0; i < sorted.length; i++) {
        const w = sorted[i];
        const text = w.text.trim();
        let group = null;
        if (range.test(text)) {
          const [a, b] = text.split(/[-–—]/);
          group = { words: [w], label: `${hm(a)}-${hm(b)}` };
        } else if (single.test(text)) {
          // "9:00 - 10:00" often arrives as three tokens; merge when the dash sits between them.
          const sep = sorted[i + 1];
          const nxt = sorted[i + 2];
          if (sep && nxt && dash.test(sep.text.trim()) && single.test(nxt.text.trim())) {
            group = { words: [w, nxt], label: `${hm(text)}-${hm(nxt.text)}`, skip: sep };
            i += 2;
          } else {
            group = { words: [w], label: hm(text) };
          }
        }
        if (!group || !group.label || /null/.test(group.label)) continue;
        const cx = group.words.reduce((n, x) => n + (x.bbox.x0 + x.bbox.x1) / 2, 0) / group.words.length;
        const cy = group.words.reduce((n, x) => n + (x.bbox.y0 + x.bbox.y1) / 2, 0) / group.words.length;
        times.push({ label: group.label, cx, cy });
        group.words.forEach((x) => timeWordIds.add(x));
        if (group.skip) timeWordIds.add(group.skip);
      }
    }
    if (!times.length) return { ok: false, reason: 'Could not find any time ranges (e.g. "9:00-10:00") in the image. Try the crop tool to cut off everything above the table.' };

    const axis = daysAreColumns
      ? { cellAxis: 'columns', labels: picks.map((p) => ({ day: p.index, pos: p.cx })), slots: times.map((t) => ({ label: t.label, pos: t.cy })) }
      : { cellAxis: 'rows', labels: picks.map((p) => ({ day: p.index, pos: p.cy })), slots: times.map((t) => ({ label: t.label, pos: t.cx })) };

    const sortedLabels = axis.labels.slice().sort((a, b) => a.pos - b.pos);
    const sortedSlots = axis.slots.slice().sort((a, b) => a.pos - b.pos);
    const gap = (arr) => {
      const gaps = [];
      for (let i = 1; i < arr.length; i++) gaps.push(arr[i].pos - arr[i - 1].pos);
      gaps.sort((a, b) => a - b);
      return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 120;
    };
    const labelGap = gap(sortedLabels);
    const slotGap = gap(sortedSlots);
    const nearest = (arr, pos) => {
      let best = null;
      for (const item of arr) {
        const d = Math.abs(item.pos - pos);
        if (!best || d < best.d) best = { item, d };
      }
      return best;
    };

    const cells = new Map();
    for (const w of words) {
      if (headerWordIds.has(w) || timeWordIds.has(w)) continue;
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const labelPick = nearest(sortedLabels, daysAreColumns ? cx : cy);
      const slotPick = nearest(sortedSlots, daysAreColumns ? cy : cx);
      if (!labelPick || labelPick.d > labelGap * 0.75) continue;
      if (!slotPick || slotPick.d > slotGap * 0.75) continue;
      const key = `${labelPick.item.day}|${slotPick.item.label}`;
      const cell = cells.get(key) || { day: labelPick.item.day, time: slotPick.item.label, words: [] };
      cell.words.push(w);
      cells.set(key, cell);
    }

    const out = [];
    for (const cell of cells.values()) {
      const words2 = cell.words.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
      const text = words2.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      const confidence = words2.reduce((n, w) => n + (w.confidence || 0), 0) / (words2.length || 1);
      out.push({
        day: cell.day,
        time: cell.time,
        text,
        confidence,
        lab: /\blab\b|laboratory|practical|lab\./i.test(text),
      });
    }
    out.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
    return {
      ok: true,
      orientation: daysAreColumns ? 'days-as-columns' : 'days-as-rows',
      days: sortedLabels.map((l) => l.day),
      times: sortedSlots.map((s) => s.label),
      cells: out,
    };
  }

  /** Grid + subject matching in one step, ready for the Review & Fix screen. */
  function parseTimetable(words, subjects) {
    const grid = gridFromWords(words);
    if (!grid.ok) return grid;
    const rows = grid.cells.map((cell) => {
      const match = fuzzyMatch(cell.text, subjects);
      // Pre-fill the subject only when the match is confident; anything else is left for the
      // Review & Fix screen to decide, and unmatched cells are never guessed at.
      const subjectId = match && match.matched ? match.subjectId : null;
      return Object.assign({}, cell, { match, subjectId, state: !match || match.confidence === 'none' ? 'unmatched' : match.matched ? 'matched' : 'low' });
    });
    return Object.assign({}, grid, { rows });
  }

  /* ---------- academic-calendar dates ---------- */
  /**
   * Pull date ranges out of OCR text. Returns candidate rows for review — always editable, never
   * applied directly. `year` is the semester's starting year; early months roll into the next year.
   */
  function parseDates(lines, opts) {
    const o = Object.assign({ year: new Date().getFullYear(), firstMonth: 7 }, opts || {});
    const out = [];
    const seen = new Set();
    const monthIndex = (word) => {
      const w = normalise(word).slice(0, 3);
      const i = MONTHS.findIndex((m) => m.slice(0, 3) === w);
      return i >= 0 ? i + 1 : null;
    };
    const yFor = (month, explicitYear) => {
      if (explicitYear) return Number(explicitYear.length === 2 ? `20${explicitYear}` : explicitYear);
      return month <= 6 && o.firstMonth >= 7 ? o.year + 1 : o.year;
    };
    const classify = (text) => {
      const t = normalise(text);
      if (/suspend|no class|classes suspended|cancelled/.test(t)) return 'suspended';
      if (/exam|mte|ete|test|assessment|sessional/.test(t)) return 'exam';
      if (/(monday|tuesday|wednesday|thursday|friday|saturday) timetable/.test(t)) return 'working-swap';
      return 'holiday';
    };
    const push = (title, start, end, type) => {
      if (!start) return;
      const t = type || classify(title);
      const key = `${t}|${start}|${end || start}`;
      if (seen.has(key)) return;
      seen.add(key);
      let swapDay = null;
      if (t === 'working-swap') {
        const words = normalise(title).split(' ');
        for (const w of words) {
          const d = dayIndexFromWord(w);
          if (d) {
            swapDay = d;
            break;
          }
        }
      }
      out.push({ type: t, start, end: end && end >= start ? end : start, title: (title || '').replace(/\s+/g, ' ').trim().slice(0, 80), swapDay });
    };
    const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    for (const line of lines || []) {
      const text = normalise(line);
      if (!text) continue;

      // "15 August 2026" / "15 Aug - 20 Aug 2026" / "August 15-20, 2026"
      let m = line.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s*[-–—to]{1,3}\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*(\d{2,4})?/);
      if (m) {
        const mo = monthIndex(m[3]);
        if (mo) {
          const y = yFor(mo, m[4]);
          push(line, iso(y, mo, +m[1]), iso(y, mo, +m[2]));
          continue;
        }
      }
      m = line.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(?:[-–—to]{1,3})\s*(\d{1,2})\s+([A-Za-z]{3,9})\.?\s*(\d{2,4})?/);
      if (m) {
        const mo1 = monthIndex(m[2]);
        const mo2 = monthIndex(m[4]);
        if (mo1 && mo2) {
          const y1 = yFor(mo1, m[5]);
          const y2 = yFor(mo2, m[5]);
          push(line, iso(y1, mo1, +m[1]), iso(y2, mo2, +m[3]));
          continue;
        }
      }
      m = line.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(?:[-–—to]{1,3})\s*(\d{1,2})[,\s]*(\d{2,4})?/);
      if (m) {
        const mo = monthIndex(m[1]);
        if (mo) {
          const y = yFor(mo, m[4]);
          push(line, iso(y, mo, +m[2]), iso(y, mo, +m[3]));
          continue;
        }
      }
      m = line.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:\s*,?\s*(\d{2,4}))?/);
      if (m) {
        const mo = monthIndex(m[2]);
        if (mo) {
          push(line, iso(yFor(mo, m[3]), mo, +m[1]));
          continue;
        }
      }
      m = line.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
      if (m) {
        const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
        push(line, iso(y, +m[2], +m[1]));
        continue;
      }
      m = line.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})[,\s]+(\d{2,4})/);
      if (m) {
        const mo = monthIndex(m[1]);
        if (mo) push(line, iso(yFor(mo, m[3]), mo, +m[2]));
      }
    }
    return out;
  }

  const api = { CDN, loadTesseract, readAsDataURL, loadImage, preprocess, compressForStorage, recognise, gridFromWords, parseTimetable, parseDates, fuzzyMatch, normalise, levenshtein, ratio, dayIndexFromWord };
  global.AD = global.AD || {};
  global.AD.Ocr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

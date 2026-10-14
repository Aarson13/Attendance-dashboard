/* ocr.js — in-browser OCR for academic-calendar notices, plus the fuzzy subject matcher
 * the timetable quick-add uses.
 *
 * Privacy: images are read with FileReader, preprocessed on a <canvas> and sent to a Tesseract
 * worker that runs in this browser. Nothing is uploaded; the only network traffic is the one-time
 * download of tesseract.js + its english model from a CDN.
 *
 * The date parser never guesses silently: every row keeps its source text so the Review screen can
 * be fixed before anything is saved. Nothing is written to the calendar until the user presses
 * Confirm (the UI enforces that; this module only produces candidates).
 */
(function (global) {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  // Subresource Integrity for that exact file (tesseract.js 6.0.1, dist/tesseract.min.js, 62961 bytes).
  // Pinning the version decides *which* file arrives; this decides that the bytes are the published
  // ones — the script runs in the app's origin, where the sync token may be. Recompute it when the
  // version is bumped, or the loader refuses to run (which is the honest failure for a changed file):
  //   curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A
  const CDN_SRI = 'sha384-r1ru3tcf6FhnCFR4B7pIFG+BhFF9LlFtz/P1y4pblWn3AGs9y3lBx5SKLNf4+rED';
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
      if (!src) {
        // The integrity hash only matches the pinned copy, so it is only applied when that is what
        // is being loaded. CORS is required for SRI to check a cross-origin script at all.
        s.integrity = CDN_SRI;
        s.crossOrigin = 'anonymous';
      }
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
   * The rectangle of the *un-rotated* image that the user's crop selects in the rotated preview.
   * The crop sliders are read off the preview, so they are authored in rotated space; a quarter
   * turn maps that rectangle back to the source with swapped axes. Canvas rotation is clockwise
   * for positive angles, which is what the four cases below assume.
   * Pure arithmetic — exported so the unit tests can pin down all four rotations.
   */
  function sourceRect(nw, nh, rot, crop) {
    const r = ((rot % 360) + 360) % 360;
    const rw = r % 180 === 0 ? nw : nh; // dimensions of the rotated preview
    const rh = r % 180 === 0 ? nh : nw;
    const x = crop[0] * rw;
    const y = crop[1] * rh;
    const w = Math.max(1, (crop[2] - crop[0]) * rw);
    const h = Math.max(1, (crop[3] - crop[1]) * rh);
    if (r === 90) return { x: y + (nw - rh) / 2, y: (rw + nh) / 2 - x - w, w: h, h: w };
    if (r === 180) return { x: rw - x - w, y: rh - y - h, w, h };
    if (r === 270) return { x: (nw + rh) / 2 - y - h, y: x + (nh - rw) / 2, w: h, h: w };
    return { x, y, w, h };
  }

  /**
   * Canvas preprocessing for better OCR: grayscale, contrast stretch, upscale small scans,
   * optional invert (dark timetable photos) and rotation, plus percentage crop.
   * Returns a JPEG data URL (also used, compressed, for the stored reference image).
   */
  async function preprocess(dataUrl, opts) {
    const o = Object.assign({ grayscale: true, contrast: true, upscale: true, invert: false, rotate: 0, crop: [0, 0, 1, 1], maxWidth: 1600, quality: 0.8 }, opts || {});
    const img = await loadImage(dataUrl);
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const rot = ((o.rotate % 360) + 360) % 360;
    const src = sourceRect(nw, nh, rot, o.crop || [0, 0, 1, 1]);
    // Size of the crop as the user sees it (rotated): a quarter turn swaps the axes.
    const cw = Math.max(1, Math.round(rot % 180 === 0 ? src.w : src.h));
    const ch = Math.max(1, Math.round(rot % 180 === 0 ? src.h : src.w));
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
    // The destination rect is given in the pre-rotation frame, so it is the source crop's own size.
    const dw = src.w * scale;
    const dh = src.h * scale;
    ctx.drawImage(img, src.x, src.y, src.w, src.h, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();

    const data = ctx.getImageData(0, 0, outW, outH);
    const px = data.data;
    if (o.grayscale || o.contrast || o.invert) {
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

  const api = { readAsDataURL, preprocess, sourceRect, recognise, parseDates, fuzzyMatch };
  global.AD = global.AD || {};
  global.AD.Ocr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

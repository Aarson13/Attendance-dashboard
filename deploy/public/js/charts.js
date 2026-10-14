/* charts.js — tiny SVG chart renderers (bar, trend line, month heatmap).
 * Hand-rolled SVG keeps the app dependency-free so it works offline from the first load.
 */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, children) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] != null && attrs[k] !== '') node.setAttribute(k, attrs[k]);
    for (const c of children || []) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }
  const pctText = (v, digits) => (v == null ? 'N/A' : `${(v * 100).toFixed(digits == null ? 1 : digits)}%`);
  const colourFor = (v, p) => (v == null ? 'var(--muted)' : v >= p + 0.05 ? 'var(--ok)' : v >= p ? 'var(--warn)' : 'var(--bad)');

  /**
   * Horizontal bars: one row per subject, with the threshold drawn as a marker line.
   * items: [{label, value, note}]
   */
  function bars(host, items, opts) {
    clear(host);
    const p = (opts && opts.threshold) || 0.75;
    if (!items.length) {
      host.innerHTML = '<p class="empty">No subjects yet — add a subject and mark some attendance.</p>';
      return;
    }
    const rowH = 34;
    const width = 100;
    const svg = el('svg', {
      viewBox: `0 0 100 ${items.length * rowH + 6}`,
      class: 'chart chart-bars',
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': items.map((i) => `${i.label}: ${pctText(i.value)}`).join('; '),
    });
    items.forEach((item, i) => {
      const y = i * rowH + 4;
      const g = el('g', { transform: `translate(0 ${y})` });
      g.appendChild(el('text', { x: 0, y: 10, class: 'chart-label' }, [item.label.slice(0, 22)]));
      const barW = item.value == null ? 0 : Math.max(1, Math.min(1, item.value) * width);
      g.appendChild(el('rect', { x: 0, y: 15, width: 100, height: 9, rx: 2, class: 'chart-track' }));
      g.appendChild(el('rect', { x: 0, y: 15, width: barW, height: 9, rx: 2, fill: colourFor(item.value, p), class: 'chart-fill' }));
      g.appendChild(el('line', { x1: p * 100, x2: p * 100, y1: 13, y2: 26, class: 'chart-threshold' }));
      g.appendChild(el('text', { x: 100, y: 10, class: 'chart-value', 'text-anchor': 'end' }, [item.note || pctText(item.value)]));
      svg.appendChild(g);
    });
    host.appendChild(svg);
    host.insertAdjacentHTML('beforeend', `<p class="chart-caption">Marker line = your ${(p * 100).toFixed(0)}% threshold.</p>`);
  }

  /** Trend line of cumulative attendance %. points: [{date, pct}] */
  function line(host, points, opts) {
    clear(host);
    const p = (opts && opts.threshold) || 0.75;
    const data = points.filter((pt) => pt.pct != null);
    if (data.length < 2) {
      host.innerHTML = '<p class="empty">Not enough marked days yet for a trend.</p>';
      return;
    }
    const W = 100;
    const H = 40;
    const min = Math.max(0, Math.min.apply(null, data.map((d) => d.pct)) - 0.05);
    const max = Math.min(1, Math.max.apply(null, data.map((d) => d.pct)) + 0.05);
    const x = (i) => (i / (data.length - 1)) * W;
    const y = (v) => H - ((v - min) / (max - min || 1)) * H;
    const svg = el('svg', { viewBox: `0 0 100 ${H}`, class: 'chart chart-line', preserveAspectRatio: 'none', role: 'img', 'aria-label': `Attendance trend from ${data[0].date} (${pctText(data[0].pct)}) to ${data[data.length - 1].date} (${pctText(data[data.length - 1].pct)})` });
    const areaPts = data.map((d, i) => `${x(i)},${y(d.pct)}`).join(' ');
    if (p >= min && p <= max) svg.appendChild(el('line', { x1: 0, x2: W, y1: y(p), y2: y(p), class: 'chart-threshold' }));
    svg.appendChild(el('polyline', { points: `${areaPts} ${W},${H} 0,${H}`, class: 'chart-area' }));
    svg.appendChild(el('polyline', { points: areaPts, class: 'chart-line-path' }));
    svg.appendChild(el('circle', { cx: x(data.length - 1), cy: y(data[data.length - 1].pct), r: 1.4, class: 'chart-dot' }));
    host.appendChild(svg);
    host.insertAdjacentHTML(
      'beforeend',
      `<p class="chart-caption"><span>${data[0].date}</span><span class="now">now ${pctText(data[data.length - 1].pct)}</span><span>${data[data.length - 1].date}</span></p>`,
    );
  }

  /**
   * Month heatmap. days: [{date, kind, title}] where kind ∈ present | absent | cancelled | off | unmarked | none.
   * Clicking a day calls opts.onPick(date).
   */
  function heatmap(host, { month, days, today, onPick }) {
    clear(host);
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const firstWeekday = ((new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7) + 1; // 1 = Monday
    const grid = el('div', { class: 'heatmap', role: 'grid', 'aria-label': `Attendance in ${month}` });
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => grid.appendChild(el('div', { class: 'heatmap-dow' }, [d])));
    for (let i = 1; i < firstWeekday; i++) grid.appendChild(el('div', { class: 'heatmap-day blank' }));
    const byDate = new Map((days || []).map((d) => [d.date, d]));
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, '0')}`;
      const info = byDate.get(date);
      const kind = info ? info.kind : 'none';
      const cell = el('button', {
        class: `heatmap-day k-${kind}${date === today ? ' is-today' : ''}`,
        type: 'button',
        'data-date': date,
        title: info ? `${date} — ${info.title}` : date,
        'aria-label': info ? `${date}: ${info.title}` : `${date}: no classes`,
      }, [String(d)]);
      if (onPick) cell.addEventListener('click', () => onPick(date));
      grid.appendChild(cell);
    }
    host.appendChild(grid);
    host.insertAdjacentHTML(
      'beforeend',
      '<p class="chart-caption heat-key"><span class="swatch k-present"></span> present<span class="swatch k-absent"></span> absent<span class="swatch k-cancelled"></span> cancelled<span class="swatch k-off"></span> holiday / off<span class="swatch k-unmarked"></span> not marked</p>',
    );
  }

  const api = { bars, line, heatmap };
  global.AD = global.AD || {};
  global.AD.Charts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

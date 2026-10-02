// The heat map as one self-contained HTML page: a zoomable treemap of the
// project, colored by the metric picked, with the hottest files beside it.
// No network: the data and the script are inline, so it opens from disk.

import type { HeatNode } from '../types'
import { METRIC_LABELS, METRIC_UNITS } from './heat.ts'

export type PageData = {
  project: string
  tree: HeatNode
  turns: number
  since: number
  made: number
}

export function heatPage(data: PageData): string {
  // `<` escaped so no file name can close the script element.
  const json = JSON.stringify({ ...data, labels: METRIC_LABELS, units: METRIC_UNITS }).replace(/</g, '\\u003c')
  const name = escapeHtml(data.project.split('/').pop() || data.project)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · heat map</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="title"><b>⏱ ${name}</b> <span id="meta" class="dim"></span></div>
  <nav id="metrics"></nav>
</header>
<div id="crumbs"></div>
<main>
  <section id="map" aria-label="Treemap"></section>
  <aside>
    <input id="filter" type="search" placeholder="Filter files…" autocomplete="off">
    <ol id="list"></ol>
  </aside>
</main>
<div id="tip" hidden></div>
<footer class="dim"><span id="legend"></span> · size: lines changed by anyone · click a folder to zoom, Backspace or a crumb to go up</footer>
<script>const DATA = ${json};
${SCRIPT}</script>
</body>
</html>
`
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)
}

const STYLE = `
:root { --bg: #f7f7f5; --fg: #1d1d1f; --dim: #6b6b70; --line: #ddd; --card: #fff; --accent: #d97757; }
@media (prefers-color-scheme: dark) { :root { --bg: #16171b; --fg: #e9e9ec; --dim: #8b8b93; --line: #2b2c33; --card: #1e1f24; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
.dim { color: var(--dim); }
nav button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); padding: 4px 10px; border-radius: 6px; cursor: pointer; }
nav button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
#crumbs { padding: 4px 16px 8px; font-family: ui-monospace, monospace; }
#crumbs a { color: var(--accent); cursor: pointer; text-decoration: none; }
main { flex: 1; display: flex; gap: 12px; padding: 0 16px; min-height: 0; }
#map { flex: 1; position: relative; min-width: 0; border-radius: 8px; overflow: hidden; background: var(--card); }
.cell { position: absolute; overflow: hidden; border: 1px solid var(--bg); border-radius: 4px; padding: 3px 5px; font: 12px ui-monospace, monospace; cursor: default; transition: filter .1s; }
.cell.dir { cursor: zoom-in; }
.cell:hover { filter: brightness(1.15); }
.cell small { display: block; opacity: .8; }
aside { width: 340px; display: flex; flex-direction: column; min-height: 0; }
#filter { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
#list { margin: 8px 0 0; padding: 0; list-style: none; overflow: auto; font: 12px ui-monospace, monospace; }
#list li { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
#list li:hover { background: var(--card); }
#list .sw { width: 12px; height: 12px; border-radius: 3px; }
#list .p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
#tip { position: fixed; pointer-events: none; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: 12px ui-monospace, monospace; max-width: 420px; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
footer { padding: 8px 16px 12px; font-size: 12px; }
@media (max-width: 760px) { main { flex-direction: column; } aside { width: auto; height: 40vh; } #map { min-height: 50vh; } }
`

const SCRIPT = `
const $ = id => document.getElementById(id);
const METRICS = ['churn', 'rework', 'undo', 'owner'];
let metric = 'churn';
let path = '';
const params = new URLSearchParams(location.hash.slice(1));
if (METRICS.includes(params.get('m'))) metric = params.get('m');
if (params.get('p')) path = params.get('p');

const size = n => n.claude + n.human + n.undos;
const value = (n, m) => m === 'churn' ? n.claude : m === 'rework' ? n.rework : m === 'undo' ? n.undos
  : (n.claude + n.human === 0 ? 0 : n.claude / (n.claude + n.human));
const STOPS = { heat: [[44,52,72],[120,40,60],[200,60,40],[240,150,40],[250,225,90]], owner: [[56,116,203],[120,120,130],[230,126,34]] };
function color(t, m) {
  const s = m === 'owner' ? STOPS.owner : STOPS.heat;
  const x = Math.min(1, Math.max(0, t)) * (s.length - 1), i = Math.min(s.length - 2, Math.floor(x)), f = x - i;
  const c = s[i].map((a, k) => Math.round(a + (s[i + 1][k] - a) * f));
  return { css: 'rgb(' + c + ')', light: c[0] * .299 + c[1] * .587 + c[2] * .114 > 140 };
}
const label = (n, m) => m === 'owner' ? Math.round(value(n, m) * 100) + '% Claude' : value(n, m) + ' ' + DATA.units[m];
const heat = (n, m, max) => m === 'owner' ? value(n, m) : (value(n, m) <= 0 || max <= 0 ? 0 : Math.log1p(value(n, m)) / Math.log1p(max));

function squarify(ws, r) {
  const out = ws.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return out;
  const areas = ws.map(w => w * r.w * r.h / total);
  const worst = (row, side) => { const s = row.reduce((a, b) => a + b, 0); return Math.max(side * side * Math.max(...row) / (s * s), s * s / (side * side * Math.min(...row))); };
  let free = { ...r }, start = 0;
  while (start < areas.length && areas[start] > 0) {
    const side = Math.min(free.w, free.h);
    let end = start + 1, best = worst(areas.slice(start, end), side);
    while (end < areas.length && areas[end] > 0) { const n = worst(areas.slice(start, end + 1), side); if (n > best) break; best = n; end++; }
    const row = areas.slice(start, end), sum = row.reduce((a, b) => a + b, 0);
    if (free.w >= free.h) { const w = sum / free.h; let y = free.y; row.forEach((a, k) => { out[start + k] = { x: free.x, y, w, h: a / w }; y += a / w; }); free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h }; }
    else { const h = sum / free.w; let x = free.x; row.forEach((a, k) => { out[start + k] = { x, y: free.y, w: a / h, h }; x += a / h; }); free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h }; }
    start = end;
  }
  return out;
}

function nodeAt(p) {
  let n = DATA.tree;
  if (p) for (const part of p.split('/')) { n = (n.children || []).find(c => c.name === part); if (!n) return DATA.tree; }
  return n;
}
function describe(n) {
  const parts = [n.claude + ' lines by Claude in ' + n.edits + (n.edits === 1 ? ' edit' : ' edits')];
  if (n.rework) parts.push(n.rework + ' reworked');
  if (n.undos) parts.push(n.undos + (n.undos === 1 ? ' undo' : ' undos'));
  if (n.human) parts.push(n.human + ' by you');
  if (n.isDir) parts.push(n.files + (n.files === 1 ? ' file' : ' files'));
  return parts.join(' · ');
}
function leaves(n, out = []) { if (!n.children) out.push(n); else n.children.forEach(c => leaves(c, out)); return out; }

function go(p) { path = p; location.hash = 'm=' + metric + (p ? '&p=' + encodeURIComponent(p) : ''); render(); }

function render() {
  $('tip').hidden = true;
  const at = nodeAt(path);
  // Crumbs
  const crumbs = $('crumbs'); crumbs.textContent = '';
  const parts = path ? path.split('/') : [];
  [['', DATA.project.split('/').pop() || '/'], ...parts.map((p, i) => [parts.slice(0, i + 1).join('/'), p])].forEach(([p, label], i, all) => {
    if (i) crumbs.append(' / ');
    if (i === all.length - 1) { const b = document.createElement('b'); b.textContent = label; crumbs.append(b); }
    else { const a = document.createElement('a'); a.textContent = label; a.onclick = () => go(p); crumbs.append(a); }
  });
  // Metric buttons
  const nav = $('metrics'); nav.textContent = '';
  for (const m of METRICS) {
    const b = document.createElement('button'); b.textContent = DATA.labels[m];
    b.setAttribute('aria-pressed', String(m === metric)); b.onclick = () => { metric = m; go(path); }; nav.append(b);
  }
  $('legend').textContent = metric === 'owner' ? 'color: blue = you, orange = Claude' : 'color: ' + DATA.labels[metric] + ', dark = none, yellow = most';
  // Map
  const map = $('map'); map.textContent = '';
  const kids = (at.children || [at]).filter(n => size(n) > 0);
  const W = map.clientWidth, H = map.clientHeight;
  const max = Math.max(0, ...kids.map(n => value(n, metric)));
  squarify(kids.map(size), { x: 0, y: 0, w: W, h: H }).forEach((r, i) => {
    const n = kids[i];
    if (r.w < 2 || r.h < 2) return;
    const c = color(heat(n, metric, max), metric);
    const el = document.createElement('div');
    el.className = 'cell' + (n.children ? ' dir' : '');
    Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', background: c.css, color: c.light ? '#111' : '#f2f2f2' });
    if (r.w > 50 && r.h > 18) {
      el.textContent = n.name + (n.children ? '/' : '');
      if (r.h > 36) { const s = document.createElement('small'); s.textContent = label(n, metric); el.append(s); }
    }
    el.onmousemove = ev => tip(ev, n);
    el.onmouseleave = () => { $('tip').hidden = true; };
    if (n.children) el.onclick = () => go(n.path);
    map.append(el);
  });
  // List
  const q = $('filter').value.toLowerCase();
  const files = leaves(at).filter(n => n.path.toLowerCase().includes(q) && value(n, metric) > 0)
    .sort((a, b) => value(b, metric) - value(a, metric) || b.claude - a.claude).slice(0, 200);
  const fmax = Math.max(0, ...files.map(n => value(n, metric)));
  const list = $('list'); list.textContent = '';
  for (const n of files) {
    const li = document.createElement('li');
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = color(heat(n, metric, fmax), metric).css;
    const p = document.createElement('span'); p.className = 'p'; p.textContent = n.path; p.title = n.path;
    const v = document.createElement('span'); v.className = 'dim'; v.textContent = label(n, metric);
    li.append(sw, p, v);
    li.onmousemove = ev => tip(ev, n); li.onmouseleave = () => { $('tip').hidden = true; };
    li.onclick = () => go(n.path.split('/').slice(0, -1).join('/'));
    list.append(li);
  }
  if (!files.length) { const li = document.createElement('li'); li.className = 'dim'; li.textContent = 'Nothing here for this metric.'; list.append(li); }
}

function tip(ev, n) {
  const t = $('tip'); t.hidden = false;
  t.textContent = ''; const b = document.createElement('b'); b.textContent = n.path || '/'; t.append(b, document.createElement('br'), describe(n));
  t.style.left = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8) + 'px';
  t.style.top = Math.min(ev.clientY + 14, innerHeight - t.offsetHeight - 8) + 'px';
}

const since = new Date(DATA.since), made = new Date(DATA.made);
$('meta').textContent = DATA.turns + ' Claude turns since ' + since.toLocaleDateString() + ' · ' + DATA.tree.files + ' files · made ' + made.toLocaleString();
$('filter').oninput = render;
addEventListener('resize', render);
addEventListener('keydown', e => { if (e.key === 'Backspace' && document.activeElement !== $('filter') && path) go(path.split('/').slice(0, -1).join('/')); });
render();
`

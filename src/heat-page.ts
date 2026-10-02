// The heat map as one self-contained HTML page: a zoomable treemap colored by
// the metric picked, with the hottest files beside it. The layout, colors and
// labels are the pane's own functions, embedded by their source; no network.

import type { HeatNode } from '../types'
import { METRICS, METRIC_LABELS, METRIC_UNITS, describe, size, value, valueLabel } from './heat.ts'
import { heatColor, hex, intensity, isLight, maxValue, squarify } from './treemap.ts'

export type PageData = {
  project: string
  tree: HeatNode
  turns: number
  since: number
  made: number
}

/** The shared functions and constants, as page script. */
export function pageLibrary(): string {
  const functions = [size, value, valueLabel, describe, squarify, heatColor, hex, isLight, intensity, maxValue]
  const constants = { METRICS, METRIC_LABELS, METRIC_UNITS }
  return [
    ...Object.entries(constants).map(([name, data]) => `const ${name} = ${json(data)};`),
    ...functions.map(String),
  ].join('\n')
}

export function heatPage(data: PageData): string {
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
  <div><b>⏱ ${name}</b> <span id="meta" class="dim"></span></div>
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
<footer class="dim"><span id="legend"></span> · size: lines changed by anyone · click a folder to zoom in, a crumb or Backspace to go up</footer>
<script>
const DATA = ${json(data)};
${pageLibrary()}
${SCRIPT}
</script>
</body>
</html>
`
}

/** JSON safe inside a script element: no file name can close it. */
function json(data: unknown): string {
  return JSON.stringify(data).replace(
    /[<\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"']/g, char => `&#${char.charCodeAt(0)};`)
}

const STYLE = `
:root { --bg: #f7f7f5; --fg: #1d1d1f; --dim: #6b6b70; --line: #ddd; --card: #fff; --accent: #c4613f; }
@media (prefers-color-scheme: dark) { :root { --bg: #16171b; --fg: #e9e9ec; --dim: #8b8b93; --line: #2b2c33; --card: #1e1f24; --accent: #e08a6b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; display: flex; flex-direction: column; height: 100vh; }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; padding: 12px 16px 4px; }
.dim { color: var(--dim); }
nav button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); padding: 4px 10px; border-radius: 6px; cursor: pointer; }
nav button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
#crumbs { padding: 4px 16px 8px; font-family: ui-monospace, monospace; }
#crumbs button { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; }
main { flex: 1; display: flex; gap: 12px; padding: 0 16px; min-height: 0; }
#map { flex: 1; position: relative; min-width: 0; border-radius: 8px; overflow: hidden; background: var(--card); }
.cell { position: absolute; overflow: hidden; border: 1px solid var(--bg); border-radius: 4px; padding: 3px 5px; font: 12px ui-monospace, monospace; }
.cell.dir { cursor: zoom-in; }
.cell:hover { filter: brightness(1.15); }
.cell small { display: block; opacity: .8; }
aside { width: 340px; display: flex; flex-direction: column; min-height: 0; }
#filter { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
#list { margin: 8px 0 0; padding: 0; list-style: none; overflow: auto; font: 12px ui-monospace, monospace; }
#list li { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: center; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
#list li:hover { background: var(--card); }
#list .swatch { width: 12px; height: 12px; border-radius: 3px; }
#list .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
#tip { position: fixed; pointer-events: none; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font: 12px ui-monospace, monospace; max-width: 420px; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
footer { padding: 8px 16px 12px; font-size: 12px; }
@media (max-width: 760px) { main { flex-direction: column; } aside { width: auto; height: 40vh; } #map { min-height: 50vh; } }
`

const SCRIPT = `
const $ = id => document.getElementById(id);
const hash = new URLSearchParams(location.hash.slice(1));
let metric = METRICS.includes(hash.get('m')) ? hash.get('m') : 'churn';
let path = hash.get('p') || '';

function nodeAt(p) {
  let node = DATA.tree;
  for (const part of p ? p.split('/') : []) {
    node = (node.children || []).find(child => child.name === part);
    if (!node) return DATA.tree;
  }
  return node;
}
function leaves(node, out = []) {
  if (node.children) node.children.forEach(child => leaves(child, out));
  else out.push(node);
  return out;
}
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
function go(p) {
  path = p;
  history.replaceState(null, '', '#m=' + metric + (p ? '&p=' + encodeURIComponent(p) : ''));
  render();
}
function hover(node, target) {
  target.onmousemove = event => {
    const tip = $('tip');
    tip.replaceChildren(el('b', { textContent: node.path || '/' }), el('br'), describe(node));
    tip.hidden = false;
    tip.style.left = Math.min(event.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.min(event.clientY + 14, innerHeight - tip.offsetHeight - 8) + 'px';
  };
  target.onmouseleave = () => { $('tip').hidden = true; };
}

function renderCrumbs() {
  const parts = path ? path.split('/') : [];
  const trail = [['', DATA.project.split('/').pop() || '/'], ...parts.map((part, i) => [parts.slice(0, i + 1).join('/'), part])];
  $('crumbs').replaceChildren(...trail.flatMap(([p, label], i) => [
    i ? ' / ' : '',
    i === trail.length - 1 ? el('b', { textContent: label }) : el('button', { textContent: label, onclick: () => go(p) }),
  ]));
}
function renderMetrics() {
  $('metrics').replaceChildren(...METRICS.map(m => {
    const button = el('button', { textContent: METRIC_LABELS[m], onclick: () => { metric = m; go(path); } });
    button.setAttribute('aria-pressed', String(m === metric));
    return button;
  }));
  $('legend').textContent = metric === 'owner'
    ? 'color: blue others · grey both · orange Claude'
    : 'color: ' + METRIC_LABELS[metric] + ', dark none → yellow most';
}
function renderMap(at) {
  const map = $('map');
  const nodes = (at.children || [at]).filter(node => size(node) > 0);
  const max = maxValue(nodes, metric);
  const rects = squarify(nodes.map(size), { x: 0, y: 0, w: map.clientWidth, h: map.clientHeight });
  map.replaceChildren(...nodes.flatMap((node, i) => {
    const r = rects[i];
    if (r.w < 2 || r.h < 2) return [];
    const back = heatColor(intensity(node, metric, max), metric);
    const cell = el('div', { className: 'cell' + (node.children ? ' dir' : '') });
    Object.assign(cell.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', background: hex(back), color: isLight(back) ? '#111' : '#f2f2f2' });
    if (r.w > 50 && r.h > 18) cell.append(node.name + (node.children ? '/' : ''));
    if (r.w > 50 && r.h > 36) cell.append(el('small', { textContent: valueLabel(node, metric, METRIC_UNITS) }));
    if (node.children) cell.onclick = () => go(node.path);
    hover(node, cell);
    return [cell];
  }));
}
function renderList(at) {
  const query = $('filter').value.toLowerCase();
  const files = leaves(at)
    .filter(node => value(node, metric) > 0 && node.path.toLowerCase().includes(query))
    .sort((a, b) => value(b, metric) - value(a, metric) || b.claude - a.claude)
    .slice(0, 200);
  const max = maxValue(files, metric);
  $('list').replaceChildren(...(files.length ? files.map(node => {
    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = hex(heatColor(intensity(node, metric, max), metric));
    const row = el('li', { onclick: () => go(node.path.split('/').slice(0, -1).join('/')) },
      swatch,
      el('span', { className: 'path', textContent: node.path, title: node.path }),
      el('span', { className: 'dim', textContent: valueLabel(node, metric, METRIC_UNITS) }));
    hover(node, row);
    return row;
  }) : [el('li', { className: 'dim', textContent: 'Nothing here for this metric.' })]));
}
function render() {
  $('tip').hidden = true;
  const at = nodeAt(path);
  renderCrumbs();
  renderMetrics();
  renderMap(at);
  renderList(at);
}

$('meta').textContent = DATA.turns + ' Claude turns since ' + new Date(DATA.since).toLocaleDateString()
  + ' · ' + DATA.tree.files + ' files · made ' + new Date(DATA.made).toLocaleString();
$('filter').oninput = render;
addEventListener('resize', render);
addEventListener('keydown', event => {
  if (event.key === 'Backspace' && document.activeElement !== $('filter') && path) go(path.split('/').slice(0, -1).join('/'));
});
render();
`

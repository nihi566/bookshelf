// 線・面・立体の専用ページ（一覧）。点の一覧は「全ての点」（#/search）、1 件の詳細は knowledge.js と point.js
import { html, raw, esc } from '../html.js';
import { layoutKnowledgeMap } from '../../core/knowledge-map.js';
import { truncate } from '../../core/text.js';
import { libraryStats } from '../../core/model.js';

// 面の一覧で見せる要約の長さ（全文は面の詳細ページで見る）
const PLANE_SUMMARY_MAX = 80;

const notYet = (name) => html`<div class="page-head"><h1>${name}</h1></div>
  <p class="empty">まだ分析していません。<a href="#/knowledge">知識の画面で分析する</a>と、${name}ができます。</p>`;

/** 知識の画面と線・面・立体のページの上に出す、点・線・面・立体の行き来（今いるページは印を付ける） */
export function layerNav(state, current = '') {
  const a = state.analysis;
  const item = (key, href, count, label) =>
    html`<a class="stat ${key}" href="${href}" ${key === current ? html`aria-current="page"` : ''}><b>${count}</b><span>${label}</span></a>`;
  return html`<nav class="stats layer-nav" aria-label="点・線・面・立体">
    ${item('point', '#/search', libraryStats(state.library).points, '全ての点')}
    ${item('line', '#/lines', a ? a.lines.length : '–', '線(グループ)')}
    ${item('plane', '#/planes', a ? a.planes.length : '–', '面')}
    ${item('solid', '#/solid', a ? 1 : '–', '立体')}
  </nav>`;
}

export const linesView = {
  render({ state }) {
    const a = state.analysis;
    if (!a) return html`<a class="back" href="#/knowledge">‹ 知識</a>${notYet('線(グループ)')}`;
    const planeOf = new Map(a.planes.flatMap((p) => p.lineIds.map((id) => [id, p])));
    const lines = [...a.lines].sort((x, y) => y.highlightIds.length - x.highlightIds.length);
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      ${layerNav(state, 'line')}
      <div class="page-head"><div><h1>線(グループ)</h1><div class="sub">点をつなぐ概念 ${lines.length} 本（点の多い順）</div></div></div>
      <div class="lines-of-plane">${lines.map((l) => {
        const p = planeOf.get(l.id);
        return html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}${p ? ` ・ ${p.name}` : ''}</em></a>`;
      })}</div>`;
  },
};

export const planesView = {
  render({ state }) {
    const a = state.analysis;
    if (!a) return html`<a class="back" href="#/knowledge">‹ 知識</a>${notYet('面')}`;
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      ${layerNav(state, 'plane')}
      <div class="page-head"><div><h1>面</h1><div class="sub">線(グループ)を束ねたテーマ ${a.planes.length}（押すと全文と線が見られます）</div></div></div>
      <div class="plane-list">${a.planes.map((p) => html`<a class="plane-row" href="#/knowledge/plane/${p.id}">
        <b>${p.name}</b>
        <span>${truncate(p.summary, PLANE_SUMMARY_MAX)}</span>
        <em>線 ${p.lineIds.length}</em>
      </a>`)}</div>`;
  },
};

export const solidView = {
  render({ state }) {
    const a = state.analysis;
    if (!a) return html`<a class="back" href="#/knowledge">‹ 知識</a>${notYet('立体')}`;
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      ${layerNav(state, 'solid')}
      <div class="page-head"><div><h1>立体</h1><div class="sub">面どうしの関係から組み立てた、知識の全体像</div></div></div>
      <section class="card solid-card stack">
        <div class="layer-label solid">立体 ・ 知識の核</div>
        <h2>${a.solid.title}</h2>
        <p class="core">${a.solid.core}</p>
        ${a.solid.principles?.length ? html`<div><h3 class="small">行動の原則</h3><ul class="plain">${a.solid.principles.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
      </section>
      <div class="section"><h2>知識マップ</h2><span class="small muted">面と線(グループ)をタップ</span></div>
      ${mapSvg(a)}`;
  },
};

/** 立体を放射状の図にする（中心=核、内側=面、外側=線） */
function mapSvg(a) {
  const { nodes, edges } = layoutKnowledgeMap(a);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // ラベルの幅も含めて表示範囲を決める（全角 1 文字 ≒ フォントサイズ）
  const extent = (n) => {
    if (n.kind !== 'line') {
      const half = (Math.min([...n.label].length, 13) * (n.kind === 'core' ? 96 : 84)) / 2;
      return [n.x - half, n.x + half];
    }
    const width = Math.min([...n.label].length, 10) * 66 + 60;
    return n.x < -1 ? [n.x - width, n.x] : n.x > 1 ? [n.x, n.x + width] : [n.x - width / 2, n.x + width / 2];
  };
  const xs = nodes.flatMap(extent);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - 40;
  const minY = Math.min(...ys) - 120;
  const w = Math.max(...xs) - minX + 40;
  const h = Math.max(...ys) - minY + 200;
  const edgeSvg = edges
    .map((e) => {
      const f = byId.get(e.from);
      const t = byId.get(e.to);
      if (!f || !t) return '';
      if (e.kind === 'relation') {
        const mx = (f.x + t.x) / 2 * 0.55;
        const my = (f.y + t.y) / 2 * 0.55;
        return `<path class="edge-relation" d="M${f.x},${f.y} Q${mx},${my} ${t.x},${t.y}"><title>${esc(e.label)}</title></path>`;
      }
      return `<line class="edge-${e.kind === 'core' ? 'core' : 'plane'}" x1="${+f.x}" y1="${+f.y}" x2="${+t.x}" y2="${+t.y}"/>`;
    })
    .join('');
  // 面の名前は横に並ぶので、隣の面と重ならない字数までにする（全角 1 文字 ≒ フォントサイズ 84）
  const planes = nodes.filter((n) => n.kind === 'plane');
  const planeChars = (n) => {
    const gaps = planes.filter((o) => o !== n && Math.abs(o.y - n.y) < 160).map((o) => Math.abs(o.x - n.x));
    return gaps.length ? Math.max(4, Math.min(12, Math.floor(Math.min(...gaps) / 84) - 1)) : 12;
  };
  const nodeSvg = nodes
    .map((n) => {
      const r = n.kind === 'core' ? 70 : n.kind === 'plane' ? 48 : Math.min(36, 16 + (n.weight || 1) * 2);
      const label = esc(truncate(n.label, n.kind === 'line' ? 9 : n.kind === 'plane' ? planeChars(n) : 12));
      const anchor = n.kind === 'line' ? (n.x < -1 ? 'end' : n.x > 1 ? 'start' : 'middle') : 'middle';
      const tx = n.kind === 'line' ? n.x + (anchor === 'end' ? -r - 16 : anchor === 'start' ? r + 16 : 0) : n.x;
      const ty = n.kind === 'line' ? n.y + 22 : n.y + r + 92;
      const href = n.kind === 'plane' ? `#/knowledge/plane/${encodeURIComponent(n.ref)}` : n.kind === 'line' ? `#/knowledge/line/${encodeURIComponent(n.ref)}` : '#/solid';
      return `<a href="${esc(href)}" class="n-${n.kind}"><circle cx="${+n.x}" cy="${+n.y}" r="${+r}"/><text x="${+tx}" y="${+ty}" text-anchor="${anchor}">${label}</text><title>${esc(n.label)}</title></a>`;
    })
    .join('');
  return html`<div class="map-wrap" id="map-wrap">
    <div class="map-tools"><button type="button" data-action="map-zoom" data-dir="1" aria-label="拡大">＋</button><button type="button" data-action="map-zoom" data-dir="-1" aria-label="縮小" disabled>－</button></div>
    <svg id="knowledge-map" viewBox="${minX} ${minY} ${w} ${h}" width="100%" role="img" aria-label="知識マップ">${raw(edgeSvg)}${raw(nodeSvg)}</svg>
  </div>`;
}

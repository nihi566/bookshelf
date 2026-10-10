// 線・面・立体の専用ページ（一覧）。点の一覧は「全ての点」（#/search）、1 件の詳細は knowledge.js と point.js
import { html } from '../html.js';
import { truncate } from '../../core/text.js';
import { libraryStats } from '../../core/model.js';
import { isLineStarred } from '../../core/line-stars.js';

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
        return html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>${isLineStarred(state.library, l.id) ? '★ ' : ''}${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}${p ? ` ・ ${p.name}` : ''}</em></a>`;
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
      <div class="section"><h2>知識マップ</h2><span class="small muted">面を押すとその画面へ。点・線は押すと中身が出て、もう 1 回（または出た札）でその画面へ。点の札から、遠いつながり・リンクの相手へたどれる</span></div>
      ${mapFrame()}`;
  },
  mount(root, { state }) {
    const wrap = root.querySelector('#map-wrap');
    if (!wrap) return;
    import('../knowledge-map-view.js').then(
      (m) => m.mountKnowledgeMap(wrap, state.analysis, state.library),
      () => {
        const canvas = wrap.querySelector('#knowledge-map');
        wrap.querySelector('.map-tools').hidden = true;
        if (canvas) canvas.innerHTML = '<p class="notice err">知識マップを読み込めませんでした。通信できるときに開き直してください。面と線は上の「面」「線(グループ)」から見られます。</p>';
      },
    );
  },
};

/** 知識マップの枠。図は mount で描く（web/js/knowledge-map-view.js） */
function mapFrame() {
  return html`<div class="map-wrap" id="map-wrap">
    <div class="map-tools">
      <button type="button" data-map="zoom" data-dir="1" aria-label="拡大">＋</button><button type="button" data-map="zoom" data-dir="-1" aria-label="縮小">－</button>
      <button type="button" class="map-fit" data-map="fit">全体</button>
    </div>
    <div id="knowledge-map" class="map-canvas" role="img" aria-label="知識マップ。面を中心に、線(グループ)と点が塊になって並びます。面を押すとその画面へ移ります。点・線を押すと中身が札で出て、もう 1 回押すかその札を押すとその画面へ移ります。点の札には遠いつながり・リンクでつながる点が並び、押すとその点へ札が移ります。キーボードでは上の「面」「線(グループ)」「全ての点」から一覧を開けます"></div>
    <div class="map-peek" aria-live="polite" hidden></div>
  </div>
  <p class="small muted map-legend">塊の中心が面、中くらいの点が線(グループ)、小さな点が点です。<span style="color:var(--layer-solid)">紫の線</span>は遠いつながり、濃い線は自分のリンク、点線は関わる点。周りに散らばる灰色の点は、まだつながらない点です。</p>`;
}

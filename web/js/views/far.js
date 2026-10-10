// 遠いつながりの画面: 知識の画面の「遠いつながり」（新しい順に 3 件）と、すべての遠いつながり（#/knowledge/far）
import { html } from '../html.js';
import { truncate } from '../../core/text.js';
import { analysisPointById, pointLabel } from '../../core/points.js';
import { FAR_MAX_PAIRS } from '../../core/analysis/far.js';
import { FAR_REACTIONS, farReactionsOf, visibleFarConnections } from '../../core/far-reactions.js';
import { lineIndex } from '../ui.js';

// 知識の画面に並べる数（残りは「すべての遠いつながり」で見る）
const ON_KNOWLEDGE = 3;
const HOW = `分析のたびに、別の本・別の面にあって意味の近さが低めの点の組を ${FAR_MAX_PAIRS} 組まで AI が読み、根っこで共通する考えがあるものだけを残します。`;

/** 画面に出す遠いつながり（両側の点が今も見られるものだけ。消した・捨てた点の組は出さない） */
function shownFar(state) {
  return visibleFarConnections(state.analysis, state.library).filter((f) => analysisPointById(state.library, f.a) && analysisPointById(state.library, f.b));
}

/** 遠いつながりの片側の点（文・書名・入っている線）。mark は AI に見せたときの印（説明が A・B で指すことがある） */
function farSide(state, id, idx, mark) {
  const p = analysisPointById(state.library, id);
  if (!p) return html`<div class="far-side"><p class="small muted">${mark} ・ この点は消えました。</p></div>`;
  const line = (idx.get(id) || [])[0];
  return html`<div class="far-side">
    <p class="far-text">${truncate(p.text.replace(/\s+/g, ' '), 140)}</p>
    <span class="small muted">${mark} ・ ${pointLabel(state.library, p)} ・ ${line ? html`<a href="#/knowledge/line/${line.id}">線(グループ)「${line.name}」</a>` : 'まだつながっていない点'}</span>
  </div>`;
}

/** 遠いつながり 1 件（共通する考え・なぜつながるか・両側の点・反応） */
export function farCard(state, f, idx = lineIndex(state.analysis)) {
  return html`<article class="card far-card stack">
    <div class="layer-label far">遠いつながり${f.status === 'interesting' ? ' ・ 面白い' : ''}</div>
    <h3>${f.idea || '共通する考え'}</h3>
    ${f.explanation ? html`<p class="small">${f.explanation}</p>` : ''}
    <div class="far-pair">${farSide(state, f.a, idx, 'A')}${farSide(state, f.b, idx, 'B')}</div>
    <div class="chips far-react" role="group" aria-label="「${f.idea || '共通する考え'}」への反応">
      ${Object.entries(FAR_REACTIONS).map(([status, label]) => html`<button type="button" class="chip" data-action="far-react" data-id="${f.id}" data-status="${status}" aria-pressed="${String(f.status === status)}">${label}</button>`)}
    </div>
  </article>`;
}

/** 知識の画面の「遠いつながり」 */
export function farBlock(state) {
  const a = state.analysis;
  const all = shownFar(state);
  const idx = lineIndex(a);
  return html`<div class="section"><h2>遠いつながり</h2><span class="small muted">${all.length}</span></div>
    <p class="help">${HOW}「面白い」とした組は残り続け、「ちがう」とした組はもう出しません。</p>
    ${a?.farNote ? html`<p class="notice">${a.farNote}</p>` : ''}
    ${all.length
      ? html`${all.slice(0, ON_KNOWLEDGE).map((f) => farCard(state, f, idx))}
        ${all.length > ON_KNOWLEDGE ? html`<a class="btn small" href="#/knowledge/far">すべて見る（${all.length}）</a>` : ''}`
      : html`<p class="card small muted">${a?.stats?.far ? `前回の分析では ${a.stats.far.calls} 組を読み、共通する考えのある組は見つかりませんでした。点が増えるたびに別の組を試します。` : 'まだ遠いつながりはありません。分析し直すと探します。'}</p>`}`;
}

export const farView = {
  render({ state }) {
    const all = shownFar(state);
    const idx = lineIndex(state.analysis);
    // 「ちがう」とした組（取り消せるように、ここにだけ出す）
    const wrong = Object.values(farReactionsOf(state.library)).filter((r) => r?.status === 'wrong');
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>遠いつながり</h1><div class="sub">${all.length} 件</div></div></div>
      <p class="help">${HOW}</p>
      ${all.length ? all.map((f) => farCard(state, f, idx)) : html`<p class="empty">まだ遠いつながりはありません。</p>`}
      ${wrong.length
        ? html`<div class="section"><h2>「ちがう」とした組</h2><span class="small muted">${wrong.length}</span></div>
          <p class="help">もう出さない組です。押し間違えたときは取り消せます。</p>
          <ul class="card plain far-wrong">${wrong.map((r) => html`<li><span>${r.idea || '共通する考え'}</span> <button type="button" class="btn small" data-action="far-react" data-id="${r.id}" data-status="wrong" aria-label="「${r.idea || '共通する考え'}」の「ちがう」を取り消す">取り消す</button></li>`)}</ul>`
        : ''}`;
  },
};

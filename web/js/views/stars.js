// ★の画面（#/stars）: ★をつけた線(グループ)と点を見返す
import { html } from '../html.js';
import { searchPoints } from '../../core/points.js';
import { starredLines } from '../../core/line-stars.js';
import { lineIndex, pointCard } from '../ui.js';

export const starsView = {
  render({ state }) {
    const { present, missing, waiting } = starredLines(state.library, state.analysis);
    const points = searchPoints(state.library, '', { favorite: true });
    const idx = lineIndex(state.analysis);
    const head = html`<a class="back" href="#/">‹ ホーム</a>
      <div class="page-head"><div><h1>★</h1><div class="sub">★をつけた線(グループ)と点を見返す</div></div></div>`;
    if (!present.length && !missing.length && !waiting && !points.length) {
      return html`${head}
        <p class="empty">まだ★はありません。点のカードの ☆ を押すか、線(グループ)の画面の「☆ ★をつける」で付けられます。</p>`;
    }
    return html`${head}
      <div class="section"><h2>★の線(グループ)</h2><span class="small muted">${present.length}</span></div>
      ${present.length
        ? html`<div class="lines-of-plane">${present.map((l) => html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>★ ${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}</em></a>`)}</div>`
        : waiting
          ? html`<p class="small muted">★をつけた線(グループ)が ${waiting} あります。この端末に分析の結果が届くと出ます（PC と同期してください）。</p>`
          : html`<p class="small muted">線(グループ)の画面の「☆ ★をつける」で付けられます。</p>`}
      ${missing.length
        ? html`<div class="card stack" style="margin-top:8px">
            <p class="small">分析し直して無くなった線(グループ) ${missing.length}（★は新しい線(グループ)には引き継ぎません）</p>
            <ul class="plain small">${missing.map((m) => html`<li class="row spread"><span>${m.name || '（名前なし）'}</span><button type="button" class="btn small" data-action="line-star" data-id="${m.id}" aria-pressed="true">★を外す</button></li>`)}</ul>
          </div>`
        : ''}
      <div class="section"><h2>★の点</h2><span class="small muted">${points.length}</span></div>
      ${points.length ? points.map((p) => pointCard(p, { library: state.library, lines: idx.get(p.id) || [] })) : html`<p class="small muted">点のカードの ☆ を押すと付けられます。</p>`}`;
  },
};

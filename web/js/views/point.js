// 点の画面（#/point/<id>）: 点 1 つと、入っている線・関わる線、リンク、意味の近い点、それを根拠にしている永久ノート
import { html } from '../html.js';
import { currentPointId, isThought, pointById, pointLabel } from '../../core/points.js';
import { lineIndex, pointCard } from '../ui.js';
import { citingNotesBlock } from './notes.js';
import { linksBlock, neighborsBlock } from './links.js';

/** その点を「関わる点」にしている線（2 番目に近い線にも十分近い点。G4-3） */
export function relatedLinesOf(analysis, id) {
  return (analysis?.lines || []).filter((l) => l.relatedIds?.includes(id));
}

export const pointView = {
  render({ state, params }) {
    // Kindle で伸ばしたハイライトは、置き換わった先の点を出す
    const id = currentPointId(state.library, params.id);
    const p = pointById(state.library, id);
    if (!p) return html`<a class="back" href="#/">‹ ホーム</a><p class="empty">この点は見つかりません（消した可能性があります）。</p>`;
    const idx = lineIndex(state.analysis);
    const books = state.library.books || {};
    const book = !isThought(p) && Object.hasOwn(books, p.bookId) ? books[p.bookId] : null;
    const back = book ? [`#/book/${book.id}`, book.title] : isThought(p) ? ['#/thoughts', 'メモ（思いつき）'] : ['#/books', '読んだ本'];
    const related = relatedLinesOf(state.analysis, id);
    return html`<a class="back" href="${back[0]}">‹ ${back[1]}</a>
      <div class="page-head"><div><h1>点</h1><div class="sub">${pointLabel(state.library, p)}</div></div></div>
      ${pointCard(p, { library: state.library, lines: idx.get(id) || [] })}
      ${related.length
        ? html`<div class="section"><h2>関わる線</h2><span class="small muted">${related.length}</span></div>
          <p class="help">入っている線のほかに、近い線です（その線の点と同じくらい、線の中心に近い）。</p>
          <div class="hl-lines">${related.map((l) => html`<a class="line-chip" href="#/knowledge/line/${l.id}">${l.name}</a>`)}</div>`
        : ''}
      ${linksBlock(state, id)}
      ${neighborsBlock(state, id)}
      ${citingNotesBlock(state.library, new Set([id]), 'この点を根拠にしている永久ノート')}
      <div class="row" style="margin-top:12px">
        <button class="btn small" data-action="new-note" data-point="${id}">この点を根拠に永久ノートを書く</button>
        <button class="btn small" data-action="cite-point" data-id="${id}">ほかの永久ノートの根拠にする</button>
      </div>`;
  },
};

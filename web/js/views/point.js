// 点の画面（#/point/<id>）: 点 1 つと、それを根拠にしている永久ノート
import { html } from '../html.js';
import { currentPointId, isThought, pointById, pointLabel } from '../../core/points.js';
import { lineIndex, pointCard } from '../ui.js';
import { citingNotesBlock } from './notes.js';

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
    return html`<a class="back" href="${back[0]}">‹ ${back[1]}</a>
      <div class="page-head"><div><h1>点</h1><div class="sub">${pointLabel(state.library, p)}</div></div></div>
      ${pointCard(p, { library: state.library, lines: idx.get(id) || [] })}
      ${citingNotesBlock(state.library, new Set([id]), 'この点を根拠にしている永久ノート')}
      <div class="row" style="margin-top:12px">
        <button class="btn small" data-action="new-note" data-point="${id}">この点を根拠に永久ノートを書く</button>
        <button class="btn small" data-action="cite-point" data-id="${id}">ほかの永久ノートの根拠にする</button>
      </div>`;
  },
};

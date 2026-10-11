// 削除した点（#/trash）: 通知の「元に戻す」が消えた後でも、メモ・タグ・★ごと戻せる（NIH-95）。
// 本ごと削除した本も、本といっしょに削除した点ごと戻せる（NIH-139）
import { html } from '../html.js';
import { deletedBooks, deletedHighlights } from '../../core/model.js';
import { isoDate } from '../../core/text.js';
import { COLOR_VAR, locationText, sourceBadge } from '../ui.js';

function trashCard(h, library) {
  const book = library.books[h.bookId];
  return html`<article class="hl" style="--hl-color:${COLOR_VAR[h.color] || 'var(--hl-yellow)'}" data-hl="${h.id}">
    <p class="hl-text">${h.text}</p>
    ${h.note ? html`<div class="hl-note"><b>メモ</b>${h.note}</div>` : ''}
    ${h.userNote ? html`<div class="hl-note"><b>自分のメモ</b>${h.userNote}</div>` : ''}
    ${h.tags?.length ? html`<div class="hl-tags">${h.tags.map((t) => html`<span>#${t}</span>`)}</div>` : ''}
    <div class="hl-foot">
      <div class="hl-meta">
        ${h.favorite ? html`<span aria-label="お気に入り">★</span>` : ''}
        <a class="book-link" href="#/book/${book.id}">${book.title}</a>
        <span>${locationText(h)}</span>
        ${sourceBadge(h.source)}
        <span class="muted">削除: ${isoDate(h.userUpdatedAt || h.updatedAt)}</span>
      </div>
      <button type="button" class="btn small" data-action="restore-highlight" data-id="${h.id}">元に戻す</button>
    </div>
  </article>`;
}

// 削除した本は本の画面を開けないので、書名はリンクにしない
function bookCard({ book, count }) {
  return html`<article class="hl" data-book="${book.id}">
    <p class="hl-text">${book.title}</p>
    <div class="hl-foot">
      <div class="hl-meta">
        ${book.author ? html`<span>${book.author}</span>` : ''}
        <span>点 ${count} 件</span>
        <span class="muted">削除: ${isoDate(book.userUpdatedAt || book.updatedAt)}</span>
      </div>
      <button type="button" class="btn small" data-action="restore-book" data-id="${book.id}">元に戻す</button>
    </div>
  </article>`;
}

export const trashView = {
  render({ state }) {
    const list = deletedHighlights(state.library);
    const books = deletedBooks(state.library);
    const head = html`<a class="back" href="#/settings">‹ 設定</a>
      <div class="page-head"><div><h1>削除した点</h1><div class="sub">新しく削除した順。「元に戻す」で自分のメモ・タグ・★ごと戻り、同期でほかの端末にも戻ります</div></div></div>`;
    if (!list.length && !books.length) return html`${head}<p class="empty">削除した点はありません。</p>`;
    return html`${head}
      ${books.length
        ? html`<div class="section"><h2>削除した本</h2><span class="small muted">${books.length}</span></div>
            <p class="help">本を戻すと、本といっしょに削除した点も戻ります</p>
            ${books.map(bookCard)}`
        : ''}
      ${list.length
        ? html`<div class="section"><h2>削除した点</h2><span class="small muted">${list.length}</span></div>
            ${list.map((h) => trashCard(h, state.library))}`
        : ''}`;
  },
};

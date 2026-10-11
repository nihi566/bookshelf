// 前回の分析のあとに消えた点（#/knowledge/removed）: 知識の画面・ホームの「減った点 N 件」から（NIH-152）。
// 意図せず技術書にした・削除した点に、分析し直す前に気づいて戻せるよう、点ごとに理由と戻す画面への入口を出す
import { html } from '../html.js';
import { removedPointList } from '../../core/auto-analysis.js';
import { THOUGHT_LABEL } from '../../core/thoughts.js';
import { locationText } from '../ui.js';

// 理由ごとの見出し・説明・戻す画面への入口（入口が無いものは null）
const REASONS = {
  technical: { label: '技術書にした本の点', help: '本を技術書にしたため、点に数えていません', back: (x) => (x.book ? { href: `#/book/${x.book.id}`, text: '本の情報を編集' } : null) },
  deleted: { label: '削除した点', help: '点を削除しました', back: () => ({ href: '#/trash', text: '削除した点（元に戻す）' }) },
  'book-deleted': { label: '削除した本の点', help: '本ごと削除しました', back: () => ({ href: '#/trash', text: '削除した点（本を元に戻す）' }) },
  discarded: { label: '捨てた思いつき', help: 'メモを捨てました', back: () => ({ href: '#/thoughts?status=discarded', text: '捨てたメモ' }) },
  replaced: { label: '置き換わった点', help: '取り込みで長い文に置き換わったか、次の点とくっつけました。置き換え先の点が次の分析に入ります', back: (x) => ({ href: `#/point/${x.replacedBy}`, text: '置き換え先の点' }) },
  'thought-deleted': { label: '削除したメモ', help: 'メモを削除しました（戻せません）', back: () => null },
  missing: { label: 'この端末に無い点', help: 'この端末に届いていない点です。同期すると理由が分かることがあります', back: () => null },
};

function removedCard(x) {
  const r = REASONS[x.reason];
  const back = r.back(x);
  const p = x.point;
  const where = x.book ? x.book.title : p ? THOUGHT_LABEL : '';
  return html`<article class="hl" data-removed="${x.id}">
    ${p?.text ? html`<p class="hl-text">${p.text}</p>` : html`<p class="hl-text muted">（文はこの端末に残っていません）</p>`}
    <div class="hl-foot">
      <div class="hl-meta">
        <span class="badge">${r.label}</span>
        ${where ? html`<span>${where}</span>` : ''}
        ${p && x.book ? html`<span>${locationText(p)}</span>` : ''}
      </div>
      ${back ? html`<a class="btn small" href="${back.href}">${back.text}</a>` : ''}
    </div>
  </article>`;
}

export const removedView = {
  render({ state }) {
    const head = html`<a class="back" href="#/knowledge">‹ 知識</a><div class="page-head"><h1>前回の分析のあとに消えた点</h1></div>`;
    if (!state.analysis) return html`${head}<p class="card small muted">まだ分析していません。</p>`;
    const list = removedPointList(state.library, state.analysis);
    if (!list.length) return html`${head}<p class="card small muted">前回の分析のあとに消えた点はありません。</p>`;
    const groups = Object.keys(REASONS).map((reason) => [reason, list.filter((x) => x.reason === reason)]).filter(([, xs]) => xs.length);
    return html`${head}
      <p class="help">${list.length} 件。前回の分析には入っていましたが、今は点に数えていません。次の分析で線から外れます。意図しないものは、分析し直す前に戻せます。</p>
      ${groups.map(([reason, xs]) => html`<div class="section"><h2>${REASONS[reason].label}</h2><span class="small muted">${xs.length}</span></div>
        <p class="help">${REASONS[reason].help}</p>
        ${xs.map(removedCard)}`)}`;
  },
};

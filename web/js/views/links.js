// リンクの画面: 点・メモ・永久ノートの画面に出す「リンク」（どちら向きに張ったものも）・「意味の近い点」・
// リンクを張る相手を選ぶ画面（#/link/<id>）
import { html } from '../html.js';
import { truncate } from '../../core/text.js';
import { analysisPointById, isThought, pointById, pointLabel, searchPoints } from '../../core/points.js';
import { currentPointId } from '../../core/point-ids.js';
import { isNoteId, notesOf, searchNotes } from '../../core/notes.js';
import { LINK_REASON_MAX, linksFor } from '../../core/links.js';
import { farLinksFor } from '../../core/far-reactions.js';
import { NEIGHBORS_MAX } from '../../core/analysis/neighbors.js';

// 相手を選ぶ画面に並べる数（多すぎると選びにくい）
const PICK_MAX = 30;
// 1 つの画面に出すリンクの数（新しい順。同期で大量に届いても画面を重くしない）
const LINKS_SHOWN = 50;

/**
 * リンクの端（点・メモ・永久ノート）の見え方。消えたものは「消えた」と出す（画面を壊さない）
 * @returns {{ href: string, title: string, sub: string, gone: boolean }}
 */
export function endView(library, id) {
  if (isNoteId(id)) {
    const all = notesOf(library);
    const n = Object.hasOwn(all, id) ? all[id] : null;
    if (!n || n.deleted) return { href: '', title: '（消えたノート）', sub: '', gone: true };
    return { href: `#/note/${id}`, title: n.title || '（題なし）', sub: '永久ノート', gone: false };
  }
  // 捨てたメモは消えていない（受け箱の「捨てた」から戻せる）ので、そのまま出す（永久ノートの根拠と同じ）
  const cur = currentPointId(library, id);
  const p = pointById(library, cur);
  if (!p) return { href: '', title: '（消えた点）', sub: '', gone: true };
  const sub = !isThought(p) ? pointLabel(library, p) : p.status === 'discarded' ? 'メモ（思いつき・捨てた）' : 'メモ（思いつき）';
  return { href: `#/point/${cur}`, title: truncate(p.text.replace(/\s+/g, ' '), 60), sub, gone: false };
}

function endRow(library, id, { reason = '', actions = '' } = {}) {
  const v = endView(library, id);
  const inner = html`<span class="link-title">${v.title}</span>${v.sub ? html`<span class="link-sub">${v.sub}</span>` : ''}${reason ? html`<span class="link-reason">理由: ${reason}</span>` : ''}`;
  return html`<li class="link-row ${v.gone ? 'gone' : ''}">${v.href ? html`<a class="link-target" href="${v.href}">${inner}</a>` : html`<span class="link-target">${inner}</span>`}${actions ? html`<span class="row link-actions">${actions}</span>` : ''}</li>`;
}

/**
 * 点・メモ・永久ノートの画面の「リンク」（張ったリンクと、点なら「面白い」とした遠いつながり）。
 * 相手を押すと相手の画面へ行け、そこからさらにリンクをたどれる
 */
export function linksBlock(state, id) {
  const links = linksFor(state.library, id);
  // 遠いつながりは、相手の点が見える組だけ（消した点の組は、遠いつながりの画面と同じく出さない。出すと外せない行が残る）
  const far = isNoteId(id) ? [] : farLinksFor(state.analysis, state.library, id).filter((f) => analysisPointById(state.library, f.other) && !links.some((l) => l.other === f.other));
  const rows = [
    ...links.map(({ link, other }) => () => {
      const title = endView(state.library, other).title;
      return endRow(state.library, other, { reason: link.reason, actions: html`<button type="button" class="btn small" data-action="link-reason" data-id="${link.id}" aria-label="「${title}」へのリンクの理由を書く">理由</button><button type="button" class="btn small" data-action="link-remove" data-id="${link.id}" aria-label="「${title}」へのリンクを外す">外す</button>` });
    }),
    ...far.map((f) => () => endRow(state.library, f.other, { reason: `遠いつながり（面白い）・${f.reason}` })),
  ];
  const hidden = rows.length - LINKS_SHOWN;
  return html`<div class="section"><h2>リンク</h2><span class="small muted">${rows.length}</span></div>
    ${rows.length
      ? html`<ul class="link-list">${rows.slice(0, LINKS_SHOWN).map((row) => row())}</ul>
        ${hidden > 0 ? html`<p class="small muted">ほか ${hidden} 件（新しい順に ${LINKS_SHOWN} 件まで出しています。外すと続きが出ます）</p>` : ''}`
      : html`<p class="small muted">まだリンクはありません。下の「リンクを張る」か「意味の近い点」から張れます。</p>`}
    <div class="row" style="margin-top:8px"><a class="btn small" href="#/link/${id}">リンクを張る</a></div>`;
}

/** 点の画面の「意味の近い点（別の本から）」（分析で選んだ最大 5 件。1 回の操作でリンクにできる） */
export function neighborsBlock(state, pointId) {
  if (!state.analysis) return '';
  const all = state.analysis.neighbors;
  // 分析が前の版（意味の近い点を作る前）なら、分析し直すと出る
  if (!all || typeof all !== 'object') {
    return html`<div class="section"><h2>意味の近い点（別の本から）</h2><span class="small muted">0</span></div>
      <p class="small muted">分析し直すと、意味の近い点（別の本から）が出ます。</p>`;
  }
  const list = Object.hasOwn(all, pointId) && Array.isArray(all[pointId]) ? all[pointId] : [];
  const ids = list.filter((x) => typeof x === 'string' && analysisPointById(state.library, x)).slice(0, NEIGHBORS_MAX);
  const linked = new Set(linksFor(state.library, pointId).map((e) => e.other));
  return html`<div class="section"><h2>意味の近い点（別の本から）</h2><span class="small muted">${ids.length}</span></div>
    ${ids.length
      ? html`<ul class="link-list">${ids.map((x) =>
          endRow(state.library, x, {
            actions: linked.has(currentPointId(state.library, x))
              ? html`<span class="small muted">リンク済み</span>`
              : html`<button type="button" class="btn small" data-action="link-quick" data-from="${pointId}" data-to="${x}" aria-label="「${endView(state.library, x).title}」とリンクする">リンクする</button>`,
          }),
        )}</ul>`
      : html`<p class="small muted">この点には、まだ意味の近い点がありません（別の本の点が無いか、前回の分析のあとに増えた点です）。</p>`}`;
}

/** 理由を書くシートの中身 */
export function linkReasonSheet(library, from, to, reason = '') {
  return html`<h2>リンクの理由</h2>
    <p class="quote">${endView(library, from).title}<br>⇄ ${endView(library, to).title}</p>
    <label class="field"><span>理由（1 行。書かなくてもよい）</span><input type="text" name="reason" maxlength="${LINK_REASON_MAX}" value="${reason}" placeholder="なぜ結びつくか" autofocus></label>
    <div class="row spread"><span></span><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

/** リンクを張る相手を選ぶ画面（#/link/<id>?q=…）。永久ノートと点を探して選ぶ */
export const linkPickerView = {
  render({ state, params, query }) {
    const from = params.id;
    const self = endView(state.library, from);
    const back = self.href || '#/';
    if (self.gone) return html`<a class="back" href="#/">‹ ホーム</a><p class="empty">リンクを張る元が見つかりません（消した可能性があります）。</p>`;
    const q = query.get('q') || '';
    const linked = new Set(linksFor(state.library, from).map((e) => e.other));
    const fromCur = currentPointId(state.library, from);
    const usable = (id) => id !== fromCur && !linked.has(id);
    const notes = q ? searchNotes(state.library, q).filter((n) => usable(n.id)).slice(0, PICK_MAX) : [];
    const points = q ? searchPoints(state.library, q).filter((p) => usable(p.id)).slice(0, PICK_MAX) : [];
    const pick = (id) => endRow(state.library, id, { actions: html`<button type="button" class="btn small" data-action="link-to" data-from="${from}" data-to="${id}" aria-label="「${endView(state.library, id).title}」とリンクする">リンクする</button>` });
    return html`<a class="back" href="${back}">‹ もどる</a>
      <div class="page-head"><div><h1>リンクを張る</h1><div class="sub">${self.title}</div></div></div>
      <form class="search-box" data-form="link-search" data-from="${from}" role="search"><input type="search" name="q" value="${q}" placeholder="相手を探す（点・メモ・永久ノート。空白で AND）" aria-label="リンクの相手を探す" ${q ? '' : 'autofocus'}></form>
      ${!q ? html`<p class="help">言葉で探して、リンクする相手を選びます。理由は 1 行添えられます（書かなくてもよい）。</p>` : ''}
      ${notes.length ? html`<div class="section"><h2>永久ノート</h2><span class="small muted">${notes.length}</span></div><ul class="link-list">${notes.map((n) => pick(n.id))}</ul>` : ''}
      ${points.length ? html`<div class="section"><h2>点・メモ</h2><span class="small muted">${points.length}</span></div><ul class="link-list">${points.map((p) => pick(p.id))}</ul>` : ''}
      ${q && !notes.length && !points.length ? html`<p class="empty">見つかりませんでした（もうリンクしている相手は出しません）</p>` : ''}`;
  },
};

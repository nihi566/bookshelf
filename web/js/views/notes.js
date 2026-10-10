// 永久ノートの画面: ノートの一覧（#/notes）・ノート 1 つ（#/note/<id>）・書くシート・
// 点・線・面の画面に出す「これを根拠にしている永久ノート」
import { html } from '../html.js';
import { isoDate, truncate } from '../../core/text.js';
import { NOTE_BODY_MAX, NOTE_TITLE_MAX, citesPoint, notesOf, searchNotes } from '../../core/notes.js';
import { missingEvidence, noteEvidence, notesCiting } from '../../core/note-evidence.js';
import { lineIndex, pointCard } from '../ui.js';
import { linksBlock } from './links.js';

// 知識の画面に並べる数（残りは一覧で見る）
const ON_KNOWLEDGE = 3;

/** ノートの 1 行（題・本文の頭・根拠の点の数・直した日） */
export function noteRow(library, n) {
  const missing = missingEvidence(library, n);
  return html`<li><a class="note-item" href="#/note/${n.id}">
    <span class="note-title">${n.title || '（題なし）'}</span>
    ${n.body ? html`<span class="note-excerpt">${truncate(n.body.replace(/\s+/g, ' '), 80)}</span>` : ''}
    <span class="note-meta">根拠の点 ${n.pointIds.length}${missing ? html` ・ <span class="warn-text">消えた点 ${missing}</span>` : ''} ・ ${isoDate(n.updatedAt)}</span>
  </a></li>`;
}

/** 点・線・面の画面に出す「これを根拠にしている永久ノート」（無ければ何も出さない） */
export function citingNotesBlock(library, ids, title) {
  const notes = notesCiting(library, ids);
  if (!notes.length) return '';
  return html`<div class="section"><h2>${title}</h2><span class="small muted">${notes.length}</span></div>
    <ul class="note-list">${notes.map((n) => noteRow(library, n))}</ul>`;
}

/** 知識の画面の「永久ノート」 */
export function notesSummaryBlock(state) {
  const notes = searchNotes(state.library, '');
  return html`<div class="section"><h2>永久ノート</h2>${notes.length ? html`<a class="small" href="#/notes">すべて見る（${notes.length}）</a>` : html`<a class="small" href="#/notes">ノートの一覧へ</a>`}</div>
    ${notes.length
      ? html`<ul class="note-list">${notes.slice(0, ON_KNOWLEDGE).map((n) => noteRow(state.library, n))}</ul>`
      : html`<p class="card small muted">自分の言葉で「1 ノート = 1 アイデア」を書いて残す場所です。線(グループ)を開いて「この線を永久ノートにする」と、AI の線を下書きにできます。分析し直しても変わりません。</p>`}`;
}

/**
 * 書くシートの中身（新しいノート・直す）。根拠の点は、外すときにチェックを外す（足すのは点のページから）
 * @param {object|null} note 直すノート（新しく書くときは null）
 * @param {string[]} [pointIds] 新しく書くときの根拠の点
 * @param {string} [draftTitle] 新しく書くときの題の下書き（リンクの理由など）
 */
export function noteSheet(library, note = null, pointIds = [], draftTitle = '') {
  const ids = note ? note.pointIds : pointIds;
  const ev = noteEvidence(library, { pointIds: ids });
  return html`<h2>${note ? '永久ノートを編集' : '永久ノートを書く'}</h2>
    <label class="field"><span>題（1 ノート = 1 アイデア）</span><input type="text" name="title" maxlength="${NOTE_TITLE_MAX}" value="${(note ? note.title : draftTitle) || ''}" placeholder="この考えを一言で" ${note ? '' : 'autofocus'}></label>
    <label class="field"><span>本文（自分の言葉で）</span><textarea name="body" rows="8" maxlength="${NOTE_BODY_MAX}" placeholder="なぜそう考えるか・どこで使えるか">${note?.body || ''}</textarea></label>
    ${ev.length
      ? html`<fieldset class="note-evidence-edit"><legend>根拠の点（外すときはチェックを外す）</legend>
          ${ev.map((e, i) => html`<label class="check"><input type="checkbox" name="point" value="${ids[i]}" checked> <span>${e.point ? truncate(e.point.text.replace(/\s+/g, ' '), 60) : '（消えた点）'}</span></label>`)}
        </fieldset>`
      : ''}
    <div class="row spread">${note ? html`<button class="btn danger" value="delete">このノートを削除</button>` : html`<span></span>`}<span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

/** 点を、どのノートの根拠にするかを選ぶシートの中身 */
export function citeSheet(library, point) {
  // もう根拠にしているノートは出さない（伸ばす前の点の ID で根拠にしていても同じ点とみなす）
  const notes = searchNotes(library, '').filter((n) => !citesPoint(library, n, point.id));
  return html`<h2>永久ノートの根拠にする</h2>
    <p class="quote">${truncate(point.text.replace(/\s+/g, ' '), 120)}</p>
    ${notes.length
      ? html`<fieldset class="cite-notes"><legend>どのノートの根拠にしますか</legend>
          ${notes.map((n, i) => html`<label class="check"><input type="radio" name="note" value="${n.id}" ${i === 0 ? 'checked' : ''}> <span>${n.title || '（題なし）'}</span></label>`)}
        </fieldset>`
      : html`<p class="small muted">根拠にできるノートがありません。「新しいノートを書く」で、この点を根拠にしたノートを書けます。</p>`}
    <div class="row spread"><button class="btn" value="new">新しいノートを書く</button><span class="row"><button class="btn" value="cancel">やめる</button>${notes.length ? html`<button class="btn primary" value="save">根拠にする</button>` : ''}</span></div>`;
}

export const notesView = {
  render({ state, query }) {
    const q = query.get('q') || '';
    const list = searchNotes(state.library, q);
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>永久ノート</h1><div class="sub">1 ノート = 1 アイデア。自分の言葉で書き、点を根拠にして育てます</div></div><button class="btn small primary" data-action="new-note">＋ ノート</button></div>
      <form class="search-box" data-form="note-filter" role="search"><input type="search" name="q" value="${q}" placeholder="ノートを探す（題・本文。空白で AND）" aria-label="永久ノートを探す"></form>
      <p class="small muted" style="margin-top:8px">${list.length} 件</p>
      ${list.length
        ? html`<ul class="note-list">${list.map((n) => noteRow(state.library, n))}</ul>`
        : html`<p class="empty">${q ? '見つかりませんでした' : 'まだ永久ノートはありません。知識の画面で線(グループ)を開いて「この線を永久ノートにする」か、受け箱のメモの「永久ノートにする」、上の「＋ ノート」から作れます。'}</p>`}`;
  },
};

/** 何から作ったか（線は今の分析にあればリンクにする） */
function fromLabel(state, n) {
  if (n.from?.kind === 'line') {
    const line = (state.analysis?.lines || []).find((l) => l.id === n.from.id);
    return line ? html`<a href="#/knowledge/line/${line.id}">線(グループ)「${line.name}」</a>から作成` : html`線(グループ)「${n.from.name || ''}」から作成`;
  }
  if (n.from?.kind === 'thought') return '受け箱のメモから作成';
  return '';
}

export const noteView = {
  render({ state, params }) {
    const all = notesOf(state.library);
    const n = Object.hasOwn(all, params.id) ? all[params.id] : null;
    if (!n || n.deleted) return html`<a class="back" href="#/notes">‹ 永久ノート</a><p class="empty">このノートは見つかりません（消した可能性があります）。<a href="#/notes">ノートの一覧へ</a></p>`;
    const ev = noteEvidence(state.library, n);
    const missing = ev.filter((e) => !e.point).length;
    const idx = lineIndex(state.analysis);
    const from = fromLabel(state, n);
    return html`<a class="back" href="#/notes">‹ 永久ノート</a>
      <div class="layer-label note">永久ノート</div>
      <h1 class="note-h1">${n.title || '（題なし）'}</h1>
      <p class="small muted">${isoDate(n.createdAt)} に作成 ・ ${isoDate(n.updatedAt)} に更新${from ? html` ・ ${from}` : ''}</p>
      <section class="card note-body">${n.body ? html`<p>${n.body}</p>` : html`<p class="muted">（本文なし）</p>`}</section>
      <div class="row" style="margin-top:12px"><button class="btn small" data-action="edit-note" data-id="${n.id}">編集</button><a class="btn small" href="#/outline/new?note=${n.id}">文章の骨組みを作る</a></div>
      ${missing ? html`<p class="notice">根拠の点が ${missing} 件消えました（本や点を消したため）。ノートはそのまま残っています。</p>` : ''}
      <div class="section"><h2>根拠の点</h2><span class="small muted">${ev.length}</span></div>
      ${ev.length
        ? ev.map((e) => (e.point ? pointCard(e.point, { library: state.library, lines: idx.get(e.id) }) : html`<p class="card small muted">この点は消えました。</p>`))
        : html`<p class="empty">根拠の点はまだありません。点のページの「永久ノートの根拠にする」で足せます。</p>`}
      ${linksBlock(state, n.id)}`;
  },
};

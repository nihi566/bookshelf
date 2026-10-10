// 思いつき（フリートノート）の画面: 受け箱（ホーム）・メモの一覧・書くシート
import { html } from '../html.js';
import { THOUGHT_MAX_LENGTH, THOUGHT_STATUS, inboxThoughts, searchThoughts, thoughtCounts } from '../../core/thoughts.js';
import { lineIndex, thoughtCard } from '../ui.js';

// ホームの受け箱に並べる件数（残りはメモの一覧で見る）
const INBOX_ON_HOME = 3;

/** 思いつきを書くシートの中身（どの画面からも上のバーの「メモ」で開く） */
export function newThoughtSheet() {
  return html`<h2>思いつきをメモ</h2>
    <label class="field"><span>メモ（本に関係なくてよい）</span><textarea name="text" rows="5" maxlength="${THOUGHT_MAX_LENGTH}" autofocus placeholder="思いついたこと・気づいたことを 1 つ"></textarea></label>
    <p class="help">受け箱に入り、次の分析から点になります。整理はあとで。</p>
    <div class="row spread"><span></span><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

/** 思いつきを直すシートの中身 */
export function editThoughtSheet(t) {
  return html`<h2>メモを編集</h2>
    <label class="field"><span>メモ</span><textarea name="text" rows="5" maxlength="${THOUGHT_MAX_LENGTH}">${t.text}</textarea></label>
    ${t.answerTo ? html`<p class="small muted">問いへの答え: ${t.answerTo.question}</p>` : ''}
    <div class="row spread"><button class="btn danger" value="delete">このメモを削除</button><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

/** ホームの受け箱（未整理の思いつき）。無ければ何も出さない */
export function inboxBlock(state) {
  const inbox = inboxThoughts(state.library);
  if (!inbox.length) return '';
  const idx = lineIndex(state.analysis);
  return html`<section class="inbox" aria-labelledby="inbox-title">
    <div class="section"><h2 id="inbox-title">受け箱 <span class="count">${inbox.length}</span></h2><a class="small" href="#/thoughts">メモをすべて見る</a></div>
    <p class="help">まだ整理していない思いつき ${inbox.length} 件。整理しなくても分析の点になります。</p>
    ${inbox.slice(0, INBOX_ON_HOME).map((t) => thoughtCard(t, { lines: idx.get(t.id), moves: true }))}
    ${inbox.length > INBOX_ON_HOME ? html`<p class="small"><a href="#/thoughts">ほか ${inbox.length - INBOX_ON_HOME} 件を見る</a></p>` : ''}
  </section>`;
}

const EMPTY = {
  inbox: '受け箱は空です。上の「メモ」から、本に関係ない思いつきを書き留められます。',
  done: '整理済みのメモはまだありません。',
  discarded: '捨てたメモはありません。',
};

export const thoughtsView = {
  render({ state, query }) {
    const status = Object.hasOwn(THOUGHT_STATUS, query.get('status')) ? query.get('status') : 'inbox';
    const q = query.get('q') || '';
    const counts = thoughtCounts(state.library);
    const list = searchThoughts(state.library, q, { status });
    const idx = lineIndex(state.analysis);
    const chip = (s) => {
      const p = new URLSearchParams(query);
      p.set('status', s);
      const on = s === status;
      return html`<a class="chip ${on ? 'on' : ''}" href="#/thoughts?${p}" ${on ? html`aria-current="true"` : ''}>${THOUGHT_STATUS[s]} ${counts[s]}</a>`;
    };
    return html`<a class="back" href="#/">‹ ホーム</a>
      <div class="page-head"><div><h1>メモ（思いつき）</h1><div class="sub">本に関係しない思いつき。書いたらそのまま分析の点になります</div></div><button class="btn small primary" data-action="new-thought">＋ メモ</button></div>
      <form class="search-box" data-form="thought-filter" role="search"><input type="search" name="q" value="${q}" placeholder="メモを探す（空白で AND）" aria-label="メモを探す"></form>
      <div class="chips" role="group" aria-label="状態で絞り込む">${Object.keys(THOUGHT_STATUS).map(chip)}</div>
      <p class="small muted" style="margin-top:8px">${list.length} 件${status === 'discarded' ? '（捨てたメモは分析・今日の点・検索に出ません）' : ''}</p>
      ${list.map((t) => thoughtCard(t, { lines: idx.get(t.id), query: q, moves: true }))}
      ${!list.length ? html`<p class="empty">${q ? '見つかりませんでした' : EMPTY[status]}</p>` : ''}`;
  },
};

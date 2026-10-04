// 知識と対話する画面（G8）: 問いかける（#/ask）と、検索の画面の「意味で探す」の結果
// 意味で探す・問いかけるは PC（bh serve）の埋め込みモデルとローカル LLM を使う（スマホからも PC を通す）
import { html } from '../html.js';
import { truncate } from '../../core/text.js';
import { analysisPointById, pointArrived, pointById, pointLabel } from '../../core/points.js';
import { notesOf } from '../../core/notes.js';
import { isTechnicalBook } from '../../core/model.js';
import { NO_ANSWER, QUESTION_MAX, placeText } from '../../core/ask.js';
import { lineIndex, pointCard } from '../ui.js';
import { noteRow } from './notes.js';

/**
 * 意味で探す・問いかけるを使えるか（PC とつながっているか）。埋め込みモデルがあるかは PC が答える
 * （画面が持つ PC の状態は古いことがある。PC で設定し直したあとも押せないままにしない）
 * @returns {'ok'|'no-pc'}
 */
export function semanticAvailability(state) {
  return state.settings.ai.mode === 'companion' && (state.servedByCompanion || state.settings.ai.companionUrl) ? 'ok' : 'no-pc';
}

const UNAVAILABLE = {
  'no-pc': '意味で探す・問いかけるは、PC（bh serve）とつながっているときに使えます（PC の AI を使うため）。',
  'no-embed': 'PC に埋め込みモデルが設定されていないので、意味で探す・問いかけるは使えません（PC で bh config embed bge-m3 を実行してください）。',
};

/** 使えないときの説明（検索の画面では、このあとに言葉の一致の結果を出す） */
export function unavailableNotice(reason, error = '') {
  const text = UNAVAILABLE[reason] || (error ? `意味で探せませんでした（${error}）。` : '意味で探せませんでした。');
  return html`<p class="notice">${text}言葉の一致で探した結果を出します。</p>`;
}

/**
 * 意味で探した結果（PC が返した近い順の ID）。消えた点・ノートは飛ばす
 * @param {{ id: string, kind: 'point'|'note' }[]} results
 */
export function meaningResults(state, results) {
  const notes = notesOf(state.library);
  const idx = lineIndex(state.analysis);
  const rows = results
    .map((r) => {
      if (r.kind === 'note') {
        const n = Object.hasOwn(notes, r.id) ? notes[r.id] : null;
        return n && !n.deleted ? html`<ul class="note-list">${noteRow(state.library, n)}</ul>` : null;
      }
      const p = analysisPointById(state.library, r.id);
      return p ? pointCard(p, { library: state.library, lines: idx.get(p.id) }) : null;
    })
    .filter(Boolean);
  // 意味で探す相手は分析の点（技術書の線は入らない。言葉で探すでは出る）
  const technical = Object.values(state.library.books || {}).some((b) => !b.deleted && isTechnicalBook(b));
  return html`<p class="small muted">意味の近い順に ${rows.length} 件（PC の AI で探しました${technical ? '。技術書の線は入りません。言葉で探すでは出ます' : ''}）</p>
    ${rows.length ? rows : html`<p class="empty">見つかりませんでした</p>`}`;
}

/** 根拠の点の 1 行（番号・点の文・書名と位置。押すとその点へ）。PC で取り込んだ直後の点は、この端末にまだ無いことがある */
function citationRow(library, { n, id }) {
  const p = pointById(library, id);
  if (!p) return html`<li class="link-row gone"><span class="link-target"><span class="link-title">[${n}] ${pointArrived(library, id) ? '（消えた点）' : '（この端末にまだ無い点。PC と同期すると出ます）'}</span></span></li>`;
  const where = [pointLabel(library, p), placeText(p)].filter(Boolean).join('・');
  return html`<li class="link-row"><a class="link-target" href="#/point/${p.id}"><span class="link-title">[${n}] ${truncate(p.text.replace(/\s+/g, ' '), 80)}</span>${where ? html`<span class="link-sub">${where}</span>` : ''}</a></li>`;
}

/** 問いかけた結果（state.ask = { question, status: 'pending'|'done'|'error', result?, error?, savedId? }） */
export function askResultBlock(state) {
  const a = state.ask;
  if (!a) return '';
  if (a.status === 'pending') return html`<p class="notice" role="status">PC の AI が、関係する点を集めて考えています（数十秒かかることがあります）。</p>`;
  if (a.status === 'error') return html`<p class="notice err" role="alert">${a.error}</p>`;
  const r = a.result;
  if (!r?.answerable) return html`<p class="notice" role="status">「${a.question}」: ${NO_ANSWER}</p><p class="small muted">点（ハイライト・メモ）が増えると答えられることがあります。言葉を変えて聞くこともできます。</p>`;
  return html`<section class="card stack answer" aria-live="polite">
      <div class="layer-label note">答え（あなたの点から）</div>
      <p class="small muted">問い: ${r.question}</p>
      <p class="answer-text">${r.answer}</p>
      <div class="row">${a.savedId
        ? html`<span class="small muted">受け箱のメモに保存しました（次の分析で点になります）</span>`
        : html`<button type="button" class="btn small" data-action="ask-save">メモとして保存</button>`}</div>
    </section>
    <div class="section"><h2>${r.cited === false ? 'AI に渡した点（答えに根拠の番号がありませんでした）' : '根拠の点'}</h2><span class="small muted">${r.citations.length}</span></div>
    <ul class="link-list">${r.citations.map((c) => citationRow(state.library, c))}</ul>`;
}

export const askView = {
  render({ state, query }) {
    const why = semanticAvailability(state);
    // 検索の画面などから渡された言葉を先に（無ければ前に聞いた質問）
    const q = query.get('q') ?? state.ask?.question ?? '';
    const pending = state.ask?.status === 'pending';
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>問いかける</h1><div class="sub">自分の点（ハイライト・メモ）を根拠に、PC の AI が答えます</div></div></div>
      ${why === 'ok' ? '' : html`<p class="notice">${UNAVAILABLE[why]}</p>`}
      <form class="stack" data-form="ask">
        <label class="field"><span>質問</span><textarea name="question" rows="3" maxlength="${QUESTION_MAX}" placeholder="例: 習慣を続けるにはどうすればいい？" ${why === 'ok' && !q ? 'autofocus' : ''}>${q}</textarea></label>
        <div class="row"><button class="btn primary" id="ask-submit" ${why === 'ok' && !pending ? '' : 'disabled'}>問いかける</button><span class="small muted">関係する点を最大 8 件集めて答えます。点に無いことは答えません</span></div>
      </form>
      <div id="ask-result">${askResultBlock(state)}</div>`;
  },
};

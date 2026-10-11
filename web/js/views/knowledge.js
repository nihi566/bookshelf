// 知識（AI 分析）の画面: 点 → 線 → 面 → 立体、おすすめの本
import { html, safeUrl } from '../html.js';
import { FEEDBACK_LABELS, feedbackByStatus, feedbackFor, libraryStats } from '../../core/model.js';
import { isoDate } from '../../core/text.js';
import { layerNav } from './layers.js';
import { TFIDF_HINT } from '../../core/analysis/pipeline.js';
import { hasChanges } from '../../core/analysis/changes.js';
import { RELATED_MAX } from '../../core/analysis/neighbors.js';
import { analysisPointById, analysisPoints, isThought } from '../../core/points.js';
import { pendingPointList } from '../../core/auto-analysis.js';
import { assignedThoughtIds } from '../../core/line-assignments.js';
import { isLineStarred } from '../../core/line-stars.js';
import { lineIndex, pendingNudge, pointCard } from '../ui.js';
import { amazonKindleUrl, findWishlistBook, formatPrice } from '../../core/wishlist.js';
import { loadWishlist } from '../wishlist-data.js';
import { companion } from '../services.js';
import { farBlock } from './far.js';
import { citingNotesBlock, notesSummaryBlock } from './notes.js';
import { outlinesSummaryBlock } from './outlines.js';

const STAGES = [
  ['embed', '点'],
  ['lines', '線'],
  ['planes', '面'],
  ['solid', '立体'],
  ['far', '遠い組'],
  ['recommend', '本'],
];
const KIND = { deepen: '深める', broaden: '広げる', challenge: '揺さぶる' };

function aiSummary(settings, servedByCompanion) {
  const ai = settings.ai;
  if (ai.mode === 'direct') return ai.chatModel ? `ブラウザ → ${ai.baseUrl}（${ai.chatModel}${ai.embedModel ? ' / ' + ai.embedModel : ''}）` : '';
  return `PC のコンパニオン（${ai.companionUrl || (servedByCompanion ? 'このサーバ' : 'http://localhost:8787')}）`;
}

export function jobPanel(job) {
  if (!job) return '';
  const i = STAGES.findIndex(([k]) => k === job.stage);
  const pct = job.total ? Math.round((job.done / job.total) * 100) : job.running ? 5 : 100;
  return html`<div class="card stack" aria-live="polite">
    <div class="steps">${STAGES.map(([k, label], n) => html`<span class="${n < i || job.stage === 'done' ? 'done' : n === i ? 'now' : ''}">${label}</span>`)}</div>
    ${job.running ? html`<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    <p class="small">${job.message || ''}${job.running && job.where === 'pc' ? '（PC で実行中。画面を閉じても続きます）' : ''}</p>
    ${job.error ? html`<p class="notice err">${job.error}</p>` : ''}
    ${job.lost
      ? html`<p class="notice">PC との通信が途切れたため、分析の状況が分かりません。PC では分析が続いている可能性があります。PC につながる状態で確認してください。</p>
        <button class="btn small primary" data-action="check-pc-job">PC の状況を確認</button>`
      : ''}
    ${job.running && !job.reconnecting ? html`<button class="btn small" data-action="cancel-analysis">中止</button>` : ''}
  </div>`;
}

/** 日時を短く（例: 10/4 18:05） */
function when(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

/** 次の自動の分析がいつ・何を待って始まるか（オフのとき・分析の最中・古い PC で判断が届かないときは出さない。NIH-112） */
function nextLine(au) {
  const n = au.next;
  if (!au.enabled || au.running || !n?.reason) return '';
  const text = n.due ? `まもなく始めます（${n.reason}）` : `${n.reason}${n.nextAt ? `（始まる見込み: ${when(n.nextAt)}）` : ''}`;
  return html`<p class="small muted">次の自動の分析: ${text}</p>`;
}

/**
 * 自動の分析の状態（PC の bh serve が、点が増えたら人の操作なしに分析し直す）。
 * PC の情報（/api/info）を取り直したときに、この欄だけ差し替える（app.js の PC_INFO_BOXES）
 */
export function autoStatusBlock(state) {
  if (state.settings.ai.mode !== 'companion') return html`<p class="small muted">自動の分析は、PC のコンパニオン（bh serve）を使うときに動きます。</p>`;
  const au = state.pcInfo?.autoAnalysis;
  if (!au) return '';
  const rule = `前回の分析のあとに点が ${au.minPoints} 件増える・減るか、${au.maxHours} 時間たって点が 1 件以上増える・減るか永久ノートを書いた・直したとき、PC が分析し直します`;
  // bh analyze で分析したときは PC の記録が無いので、手元の分析結果の時刻（最後に成功した分析）で補う
  const okAt = au.lastSuccessAt || state.analysis?.createdAt;
  const cancelled = au.lastCancelledAt && (!au.lastSuccessAt || au.lastCancelledAt > au.lastSuccessAt);
  return html`<p class="small">自動の分析: ${au.enabled ? html`<b>オン</b> — ${rule}` : html`<b>オフ</b>（PC で <span class="code">bh config auto on</span> で入れられます）`}</p>
    <p class="small muted">最後に成功: ${when(okAt)}${au.lastTrigger === 'auto' && au.lastSuccessAt && !au.lastError && !cancelled ? '（自動）' : ''}</p>
    ${nextLine(au)}
    ${au.enabled && au.notesChanged ? html`<p class="small muted">前回の分析のあとに書いた・直した永久ノートがあります。次の分析で面・立体に入ります。</p>` : ''}
    ${cancelled ? html`<p class="small muted">${when(au.lastCancelledAt)} に分析を中止しました。少し時間をおいてから、PC が自動で始め直します。</p>` : ''}
    ${au.lastError ? html`<p class="notice err">${when(au.lastErrorAt)} の分析に失敗しました: ${au.lastError}。前回の結果はそのまま残っています。次の機会に PC がもう一度試します。</p>` : ''}`;
}

const REBUILT = {
  full: '「最初から作り直す」で、すべて作り直しました',
  grew: '前回作り直したときから点が大きく増えたので、最初から作り直しました',
  unraveled: '点が減って前回の線がすべてほどけたので、最初から作り直しました',
  format: '今回は最初から作り直しました',
};

/**
 * 前回からの変化（増えた線・大きくなった線・消えた線・新しくつながった点。伸ばしただけの点は件数だけ）。
 * links: 線の画面へのリンクを張るか（過去の分析では、今の分析に無い線を指すことがあるので張らない）
 */
function changesBlock(a, { links = true } = {}) {
  if (a.restoredFrom) return html`<div class="section"><h2>前回からの変化</h2></div><p class="card small">${when(a.restoredFrom)} の分析に戻しました（線 ${a.lines.length} 本・面 ${a.planes.length}）。次の分析は、この回から引き継ぎます。</p>`;
  const c = a.changes;
  if (!c) return '';
  const head = html`<div class="section"><h2>前回からの変化</h2><span class="small muted">${isoDate(c.previousAt)} から</span></div>`;
  if (c.rebuilt) return html`${head}<p class="card small">${REBUILT[c.reason] || REBUILT.format}（線 ${a.lines.length} 本・面 ${a.planes.length}）。次からは、変わったところだけを作り直します。</p>`;
  // Kindle で伸ばしただけの点は変化に数えないが、取り込みが届いたことは件数で分かるようにする（NIH-94。過去の分析には無い）
  const extended = c.extendedPoints > 0 ? `Kindle で伸ばした点 ${c.extendedPoints}（変化には数えていません）` : '';
  if (!hasChanges(c)) return html`${head}<p class="card small muted">線(グループ)の顔ぶれは変わりませんでした。${extended ? html`<br>${extended}` : ''}</p>`;
  const lineName = (id, fallback) => a.lines.find((l) => l.id === id)?.name || fallback;
  const chip = (id, label) => (links ? html`<a class="line-chip" href="#/knowledge/line/${id}">${label}</a>` : html`<span class="line-chip">${label}</span>`);
  const connected = new Map();
  for (const p of c.connectedPoints) connected.set(p.lineId, (connected.get(p.lineId) || 0) + 1);
  return html`${head}
    <section class="card stack changes">
      ${c.addedLines.length ? html`<div><h3 class="small">新しい線(グループ) ${c.addedLines.length}</h3><div class="hl-lines">${c.addedLines.map((l) => chip(l.id, lineName(l.id, l.name)))}</div></div>` : ''}
      ${c.grownLines.length ? html`<div><h3 class="small">大きくなった線(グループ) ${c.grownLines.length}</h3><div class="hl-lines">${c.grownLines.map((l) => chip(l.id, html`${lineName(l.id, l.name)} <span class="nowrap">＋${l.added}</span>`))}</div></div>` : ''}
      ${c.removedLines.length ? html`<div><h3 class="small">消えた線(グループ) ${c.removedLines.length}</h3><p class="small muted">${c.removedLines.map((l) => l.name).join('、')}</p></div>` : ''}
      ${c.connectedPoints.length ? html`<div><h3 class="small">新しくつながった点 ${c.connectedPoints.length}</h3><div class="hl-lines">${[...connected].map(([id, n]) => chip(id, html`${lineName(id, '線')}に <span class="nowrap">${n} 点</span>`))}</div></div>` : ''}
      ${extended ? html`<p class="small muted">${extended}</p>` : ''}
    </section>`;
}

/** 分析を始めるボタン（知識の画面と増えた点の一覧で同じもの。分析中・点 4 件未満は押せない） */
function runAnalysisButton(state) {
  const disabled = state.job?.running || libraryStats(state.library).points < 4;
  return html`<button class="btn primary" data-action="run-analysis" ${disabled ? 'disabled' : ''}>${state.analysis ? '分析し直す' : '点をつないで分析する'}</button>`;
}

export const knowledge = {
  render({ state }) {
    const a = state.analysis;
    const s = libraryStats(state.library);
    const job = state.job;
    const summary = aiSummary(state.settings, state.servedByCompanion);
    const runBtn = runAnalysisButton(state);
    const head = html`<div class="page-head"><div><h1>知識</h1><div class="sub">点 ${s.points} → 線 ${a?.lines.length ?? '–'} → 面 ${a?.planes.length ?? '–'} → 立体</div></div><a class="btn small" href="#/ask">問いかける</a></div>
      <div class="card stack">
        <p class="small">AI: ${summary || html`<b>未設定</b> — <a href="#/settings">AI の接続を設定する</a>`}</p>
        ${s.points < 4 ? html`<p class="notice">分析には 4 件以上の点が必要です。<a href="#/import">取り込む</a>か、上の「メモ」で思いつきを書いてください。</p>` : ''}
        <div class="row">${runBtn}${a ? html`<button class="btn" data-action="rerun-recommend" ${job?.running ? 'disabled' : ''}>おすすめを選び直す</button>` : ''}</div>
        ${a ? html`<p class="small muted">前回の分析: ${isoDate(a.createdAt)}・${a.model?.chat}${a.model?.embed ? ' / ' + a.model.embed : ''}・点 ${a.stats.points}${a.stats.calls ? `・AI を呼んだ回数 ${a.stats.calls.chat + a.stats.calls.embed}` : ''}${a.stats.far ? `（ほかに遠い組の判定 ${a.stats.far.calls}）` : ''}</p>
          ${pendingNudge(state)}` : ''}
        <div id="auto-status">${autoStatusBlock(state)}</div>
        ${a ? html`<p class="small"><button type="button" class="btn small" data-action="run-analysis-full" ${job?.running ? 'disabled' : ''}>最初から作り直す</button> <span class="muted">線(グループ)・面を前回から引き継がず、すべて作り直します（時間がかかります）</span></p>` : ''}
        ${a?.model?.embed === 'tfidf' ? html`<p class="notice">${TFIDF_HINT}</p>` : ''}
      </div>
      ${jobPanel(job)}`;
    if (!a) {
      return html`${head}
        <div class="section"><h2>点・線(グループ)・面・立体</h2></div>
        ${layerNav(state)}
        <div class="section"><h2>分析のしくみ</h2></div>
        <ol class="card help stack" style="padding-left:2em">
          <li><b style="color:var(--layer-point)">点</b> — ハイライトを埋め込みベクトルにします（埋め込みモデルが無ければ文字の特徴で代用）。</li>
          <li><b style="color:var(--layer-line)">線(グループ)</b> — 意味の近い点を束ね、LLM が共通する考えを一段抽象化した「概念」にします。本をまたいだつながりが見つかります。</li>
          <li><b style="color:var(--layer-plane)">面</b> — 近い線を束ね、LLM がテーマとしてまとめます。</li>
          <li><b style="color:var(--layer-solid)">立体</b> — 面どうしの関係から、知識の核・行動の原則を組み立てます。</li>
          <li><b>本</b> — 立体と「問い」から次に読む本を選び、書誌データベースで実在を確認します。</li>
        </ol>
        ${notesSummaryBlock(state)}
        ${outlinesSummaryBlock(state)}`;
    }
    const recs = a.recommendations || [];
    return html`${head}
      <div class="section"><h2>点・線(グループ)・面・立体</h2><span class="small muted">押すとそれぞれのページへ</span></div>
      ${layerNav(state)}
      <a class="solid-link" href="#/solid"><span class="layer-label solid">立体 ・ 知識の核</span><b>${a.solid.title}</b></a>

      ${changesBlock(a)}

      ${notesSummaryBlock(state)}

      ${outlinesSummaryBlock(state)}

      ${farBlock(state)}

      ${recs.length || a.recommendationNote
        ? html`<div class="section"><h2>おすすめの本</h2><span class="small muted">${isoDate(a.recommendedAt || a.createdAt)}</span></div>
          ${a.recommendationNote ? html`<p class="notice">${a.recommendationNote}</p>` : ''}
          ${recs.map((r, i) => recCard(a, r, i, state.library))}
          ${recs.length ? html`<p class="small muted">AI は書誌データベース（Google Books）で見つけた実在の本から選びます。検索できないときは AI が挙げた書名を Google Books・国立国会図書館サーチで確認します（✓ が確認済み）。</p>` : ''}`
        : ''}

      ${wantList(state.library)}

      ${a.isolated?.length ? html`<div class="section"><h2>まだつながっていない点</h2><span class="small muted">${a.isolated.length}</span></div>
        <p class="help">どの線(グループ)にも入らなかった点です。読書を重ねると、いつか線になるかもしれません。</p>
        <a class="btn small" href="#/knowledge/isolated">見る</a>` : ''}

      ${pcConfigured(state) ? html`<div class="section"><h2>分析の履歴 <span class="small muted pin-count" id="history-pin-count"></span></h2><span class="small muted">PC に直近 12 回分（「残す」の回は消えない）</span></div><div id="analysis-history"><p class="small muted">PC に問い合わせています…</p></div>` : ''}`;
  },
  mount(root, ctx) {
    if (ctx?.state && pcConfigured(ctx.state)) renderHistoryList(root.querySelector('#analysis-history'), root.querySelector('#history-pin-count'), ctx.state);
    // おすすめの本がすでに欲しい本（web/wishlist-site/wishlist.json）に入っていれば印を付ける。読めなければ何もしない
    const cards = [...root.querySelectorAll('.rec[data-title]')];
    if (!cards.length) return;
    loadWishlist()
      .then((w) => {
        for (const card of cards) {
          const found = findWishlistBook(w.books, [card.dataset.title, card.dataset.vtitle]);
          const slot = card.querySelector('.rec-wish');
          if (!found || !slot?.isConnected) continue;
          const b = found.book;
          // 前方一致は続編・派生本のこともあるので言い切らず、欲しい本側の書名を見せる
          const label = found.exact ? (b.purchased ? '購入済み' : '欲しい本に登録済み') : `欲しい本に似た書名: ${b.title}`;
          slot.innerHTML = String(html`<a class="badge wish ${found.exact ? '' : 'similar'}" href="#/wishlist?q=${encodeURIComponent(b.asin || b.title)}">${label}</a>`);
          // 書名が一致した欲しい本の ASIN が分かれば、検索ではなく商品ページを開く
          const amazon = card.querySelector('.rec-amazon');
          const dp = found.exact && b.asin ? amazonKindleUrl({ asin: b.asin }) : '';
          if (amazon && dp) {
            amazon.href = dp;
            amazon.textContent = 'Amazon で開く（Kindle 版）';
          }
        }
      })
      .catch(() => {});
  },
};

/** 変化の要約（履歴の一覧の 1 行）。restoredFrom: 履歴から戻した回なら、元の回の時刻 */
export function changeSummary(c, restoredFrom = null) {
  if (restoredFrom) return `${when(restoredFrom)} の分析に戻した`;
  if (!c) return '最初の分析';
  if (c.rebuilt) return '最初から作り直した';
  const parts = [c.addedLines ? `新しい線(グループ) ${c.addedLines}` : '', c.grownLines ? `大きくなった線(グループ) ${c.grownLines}` : '', c.removedLines ? `消えた線(グループ) ${c.removedLines}` : '', c.connectedPoints ? `つながった点 ${c.connectedPoints}` : ''].filter(Boolean);
  return parts.join('・') || '線(グループ)の顔ぶれは変わらず';
}

/** PC（コンパニオン）を使う設定で、PC の場所が分かっているか（GitHub Pages で開いただけなら localhost に問い合わせない） */
const pcConfigured = (state) => state.settings.ai.mode === 'companion' && Boolean(state.servedByCompanion || state.settings.ai.companionUrl);

/** 履歴の一覧（「この回を残す」の印が付いた回には「残す」と出す。NIH-102） */
export function historyListHtml(items, state) {
  return items.length
    ? html`<ul class="card plain history-list">${items.map((h) => html`<li><a href="#/knowledge/history/${h.id}">${when(h.createdAt)}</a> ${h.pinned === true ? html`<span class="pin-mark">残す</span> ` : ''}<span class="small muted"><span class="nowrap">点 ${h.stats?.points ?? '–'}</span>・<span class="nowrap">線 ${h.stats?.lines ?? '–'}</span>・<span class="nowrap">面 ${h.stats?.planes ?? '–'}</span>${h.createdAt === state?.analysis?.createdAt ? '（いま表示している分析）' : ''}</span><br><span class="small">${changeSummary(h.changes, h.restoredFrom).split('・').map((part, i) => html`${i ? '・' : ''}<span class="nowrap">${part}</span>`)}</span></li>`)}</ul>`
    : html`<p class="small muted">まだ履歴がありません（PC で分析すると残ります）。</p>`;
}

/** 「残す」の印の数と上限（履歴の見出しの横に出す。NIH-127）。pinMax: 上限（古い PC で分からなければ null で、数だけ出す） */
export function pinCountText(items, pinMax) {
  const n = items.filter((h) => h.pinned === true).length;
  return Number.isInteger(pinMax) ? `残す ${n} / ${pinMax} 回` : `残す ${n} 回`;
}

/**
 * 分析の履歴（PC にだけある）。前に取った一覧をすぐ出し（描き直しで位置がずれないように）、PC から取り直して差し替える。
 * 見出しの横には「残す」の印の数と上限を出す。PC とつながらなければその旨を出す
 */
let historyToken = 0;
let lastHistory = null;
function renderHistoryList(box, count, state) {
  if (!box) return;
  const show = ({ items, pinMax }) => {
    box.innerHTML = String(historyListHtml(items, state));
    if (count) count.textContent = pinCountText(items, pinMax);
  };
  const token = ++historyToken;
  if (lastHistory) show(lastHistory);
  companion.history().then(
    (h) => {
      lastHistory = h;
      if (token === historyToken && box.isConnected) show(h);
    },
    (e) => {
      if (token === historyToken && box.isConnected && !lastHistory) box.innerHTML = String(html`<p class="small muted">履歴は PC にあります。PC とつながっていないので出せません（${e.message}）。</p>`);
    },
  );
}

/** 履歴の ID（PC の cli/store.js の historyId と同じ作り方: 分析した時刻の数字と T・Z） */
const historyIdOf = (a) => String(a?.createdAt || '').replace(/[^0-9TZ]/g, '');

/**
 * 過去の分析 1 回分の中身。線・面の画面は今の分析のものなので、リンクは張らない。
 * current: いま表示している分析か（そうでなければ「この分析に戻す」を出す）。
 * pinned: 「この回を残す」の印が付いているか（NIH-102。PC の一覧が読めず分からないときは undefined で、付け外しを出さない）。
 * pinCount / pinMax: 印の付いた回の数と上限。この回に印が無く上限に達していれば、ほかの回の印を外すよう案内する（NIH-127）
 */
export function historyBody(a, { current, pinned, pinCount, pinMax }) {
  const full = pinned === false && Number.isInteger(pinMax) && pinCount >= pinMax;
  const id = historyIdOf(a);
  return html`<section class="card stack">${current
      ? html`<p class="small muted">いま表示している分析です。</p>`
      : html`<div class="row"><button type="button" class="btn small primary" data-action="restore-analysis" data-id="${id}">この分析に戻す</button><span class="small muted">知識の画面の線(グループ)・面・立体がこの回のものになり、次の分析はこの回から引き継ぎます</span></div>`}
      ${typeof pinned === 'boolean'
        ? html`<div class="row"><button type="button" class="btn small" data-action="pin-history" data-id="${id}" data-pinned="${String(pinned)}" aria-pressed="${String(pinned)}">${pinned ? '残すのをやめる' : 'この回を残す'}</button><span class="small muted">${pinned ? html`<span class="pin-mark">残す</span> 印が付いています。直近 12 回を過ぎても消えません` : full ? html`残せるのは ${pinMax} 回までで、いま ${pinCount} 回に印が付いています。<a href="#/knowledge">知識の画面の分析の履歴</a>から「残す」の回を開き、ほかの回の「残すのをやめる」を押すと、この回を残せます` : '履歴は直近 12 回分だけ残ります。印を付けた回は、それを過ぎても消えません'}</span></div>`
        : ''}</section>
    ${changesBlock(a, { links: false })}
    <div class="section"><h2>立体</h2></div>
    <section class="card solid-card stack">
      <h2>${a.solid?.title || ''}</h2>
      <p class="core">${a.solid?.core || ''}</p>
      ${a.solid?.principles?.length ? html`<div><h3 class="small">行動の原則</h3><ul class="plain">${a.solid.principles.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
    </section>
    <div class="section"><h2>面と線(グループ)</h2></div>
    ${a.planes.map((p) => html`<section class="card plane-card"><div class="layer-label plane">面</div><h3>${p.name}</h3><p class="small">${p.summary}</p>
      <ul class="plain small">${p.lineIds.map((id) => a.lines.find((l) => l.id === id)).filter(Boolean).map((l) => html`<li><b>${l.name}</b> <span class="muted">点 ${l.highlightIds.length}</span></li>`)}</ul></section>`)}`;
}

/** 過去の分析を 1 回分見る（戻すときは「この分析に戻す」） */
export const historyView = {
  render() {
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>過去の分析</h1><div class="sub" id="history-sub">PC から読み込んでいます…</div></div></div>
      <div id="history-body"><p class="loading">読み込み中…</p></div>`;
  },
  mount(root, { params, state }) {
    const body = root.querySelector('#history-body');
    const sub = root.querySelector('#history-sub');
    // 印（「この回を残す」）は一覧にだけある。一覧が読めなくても、中身は出す
    const pinOf = companion.history().then(
      ({ items, pinMax }) => ({ pinned: items.find((h) => h.id === params.id)?.pinned === true, pinCount: items.filter((h) => h.pinned === true).length, pinMax }),
      () => ({}),
    );
    Promise.all([companion.historyEntry(params.id), pinOf]).then(
      ([a, pins]) => {
        if (!body.isConnected) return;
        sub.textContent = `${when(a.createdAt)}・${a.model?.chat || ''}${a.model?.embed ? ' / ' + a.model.embed : ''}・点 ${a.stats?.points ?? '–'} → 線 ${a.lines.length} → 面 ${a.planes.length}`;
        body.innerHTML = String(historyBody(a, { current: a.createdAt === state?.analysis?.createdAt, ...pins }));
      },
      (e) => {
        if (body.isConnected) body.innerHTML = String(html`<p class="notice err">過去の分析を読めませんでした: ${e.message}</p>`);
      },
    );
  },
};

function recCard(a, r, i, library) {
  const plane = a.planes.find((p) => p.id === r.planeId);
  const v = r.verified;
  const link = safeUrl(v?.link);
  const thumb = safeUrl(v?.thumbnail);
  const reaction = feedbackFor(library, r.title)?.status || '';
  return html`<article class="card rec ${reaction === 'no' ? 'rec-dismissed' : ''}" data-title="${r.title}" data-vtitle="${v?.title || ''}">
    ${thumb ? html`<img src="${thumb}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <div class="grow">
      <div class="kind kind-${r.kind}">${KIND[r.kind] || r.kind}${plane ? html` ・ <a href="#/knowledge/plane/${plane.id}">${plane.name}</a>` : ''}</div>
      <h3>${r.title}</h3>
      <div class="rec-wish"></div>
      <div class="small muted">${r.author}</div>
      <p class="small">${r.reason}</p>
      ${r.query ? html`<p class="small muted">「${r.query}」で探した本</p>` : ''}
      ${v ? html`<a class="small" href="${link || '#'}" target="_blank" rel="noopener noreferrer">✓ ${v.source || '書誌データベース'}: ${v.title}${v.publishedDate ? `（${String(v.publishedDate).slice(0, 4)}）` : ''}</a>` : r.verified === false ? html`<p class="small" style="color:var(--warn)">⚠ 書誌データベースで見つかりませんでした</p>` : r.wishlist ? '' : html`<p class="small muted">未確認</p>`}
      ${r.wishlist ? html`<p class="small muted">欲しい本の中から選んだ本・${formatPrice({ ku: r.wishlist.ku === true, price: Number.isInteger(r.wishlist.price) ? r.wishlist.price : null })}</p>` : ''}
      ${amazonLink(v?.title || r.title, r.wishlist?.asin)}
      <div class="chips rec-feedback" role="group" aria-label="この本への反応（次のおすすめに使います）">
        ${Object.entries(FEEDBACK_LABELS).map(([status, label]) => html`<button type="button" class="chip" data-action="rec-feedback" data-i="${i}" data-status="${status}" aria-pressed="${String(reaction === status)}">${label}</button>`)}
      </div>
    </div>
  </article>`;
}

function amazonLink(title, asin) {
  const url = amazonKindleUrl({ title, asin });
  const label = url.includes('/dp/') ? 'Amazon で開く（Kindle 版）' : 'Amazon で探す（Kindle 版）';
  return url ? html`<p class="small"><a class="rec-amazon" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a></p>` : '';
}

export const lineView = {
  render({ state, params }) {
    const a = state.analysis;
    const l = a?.lines.find((x) => x.id === params.id);
    if (!l) return html`<p class="empty">線(グループ)が見つかりません（分析し直して無くなった可能性があります）。<a href="#/lines">線(グループ)の一覧へ</a></p>`;
    const plane = a.planes.find((p) => p.lineIds.includes(l.id));
    // 線の点（本に引いた線と思いつき）と、自分で入れた思いつき（AI の線にすでに入っているものは重ねない）
    const starred = isLineStarred(state.library, l.id);
    const aiIds = new Set(l.highlightIds);
    const manual = assignedThoughtIds(state.library, l.id).filter((id) => !aiIds.has(id));
    const hs = [...l.highlightIds, ...manual].map((id) => analysisPointById(state.library, id)).filter(Boolean);
    // 2 番目に近い線がこの線で、十分近い点（G4-3。ほかの端末から届いた分析でも、重ねず上限まで）
    const related = [...new Set(l.relatedIds || [])].slice(0, RELATED_MAX).map((id) => analysisPointById(state.library, id)).filter(Boolean);
    const idx = lineIndex(a);
    const books = new Set(hs.filter((h) => !isThought(h)).map((h) => h.bookId));
    const thoughts = hs.filter(isThought).length;
    const siblings = plane ? plane.lineIds.filter((id) => id !== l.id).map((id) => a.lines.find((x) => x.id === id)).filter(Boolean) : [];
    return html`<a class="back" href="${plane ? `#/knowledge/plane/${plane.id}` : '#/lines'}">‹ ${plane ? plane.name : '線(グループ)'}</a>
      <div class="layer-label line">線(グループ) ・ ${books.size} 冊の本${thoughts ? `と思いつき ${thoughts} 件` : ''}をつなぐ</div>
      <h1 style="margin:4px 0 12px">${l.name}</h1>
      <section class="card stack">
        <p style="font-family:var(--serif);line-height:1.9">${l.summary}</p>
        ${l.keywords?.length ? html`<div class="chips">${l.keywords.map((k) => html`<a class="chip" href="#/search?q=${encodeURIComponent(k)}">${k}</a>`)}</div>` : ''}
        <div class="row"><button type="button" class="btn small" data-action="line-star" data-id="${l.id}" aria-pressed="${String(starred)}">${starred ? '★ ★を外す' : '☆ ★をつける'}</button><a class="small" href="#/stars">★の一覧</a></div>
        <div class="row"><button type="button" class="btn small primary" data-action="line-to-note" data-id="${l.id}">この線を永久ノートにする</button><span class="small muted">AI の線を下書きにして、自分の言葉に直せます</span></div>
        <div class="row"><a class="btn small" href="#/outline/new?line=${l.id}">文章の骨組みを作る</a></div>
      </section>
      ${citingNotesBlock(state.library, new Set([...l.highlightIds, ...manual]), 'この線の点を根拠にしている永久ノート')}
      <div class="section"><h2>つながっている点</h2><span class="small muted">${hs.length}</span></div>
      ${hs.map((h) => pointCard(h, { library: state.library, lines: (idx.get(h.id) || []).filter((x) => x.id !== l.id), assigned: manual.includes(h.id) ? { id: l.id, name: l.name, missing: false } : null }))}
      ${related.length
        ? html`<div class="section"><h2>関わる点（ほかの線(グループ)から）</h2><span class="small muted">${related.length}</span></div>
          <p class="help">ほかの線(グループ)に入っている点のうち、この線の点と同じくらい、この線の中心に近い点です。</p>
          ${related.map((h) => pointCard(h, { library: state.library, lines: idx.get(h.id) || [] }))}`
        : ''}
      ${siblings.length ? html`<div class="section"><h2>同じ面の線(グループ)</h2></div><div class="lines-of-plane">${siblings.map((s) => html`<a class="line-row" href="#/knowledge/line/${s.id}"><b>${s.name}</b><span>${s.summary}</span></a>`)}</div>` : ''}`;
  },
};

export const planeView = {
  render({ state, params }) {
    const a = state.analysis;
    const p = a?.planes.find((x) => x.id === params.id);
    if (!p) return html`<p class="empty">面が見つかりません（分析し直して無くなった可能性があります）。<a href="#/planes">面の一覧へ</a></p>`;
    const rels = (a.solid.relations || []).filter((r) => r.from === p.id || r.to === p.id);
    const lines = p.lineIds.map((id) => a.lines.find((l) => l.id === id)).filter(Boolean);
    const bookIds = [...new Set(lines.flatMap((l) => l.highlightIds.map((id) => state.library.highlights[id]?.bookId)).filter(Boolean))];
    return html`<a class="back" href="#/planes">‹ 面</a>
      <div class="layer-label plane">面</div>
      <h1 style="margin:4px 0 12px">${p.name}</h1>
      <section class="card stack"><p style="font-family:var(--serif);line-height:1.9">${p.summary}</p>
        <div class="row"><a class="btn small" href="#/outline/new?plane=${p.id}">文章の骨組みを作る</a><span class="small muted">この面から、人に読ませる文章の見出し・要点・引用を作ります</span></div>
      </section>
      <div class="section"><h2>線(グループ)</h2><span class="small muted">${lines.length}</span></div>
      <div class="lines-of-plane">${lines.map((l) => html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}</em></a>`)}</div>
      ${citingNotesBlock(state.library, new Set(lines.flatMap((l) => l.highlightIds)), 'この面の点を根拠にしている永久ノート')}
      ${rels.length ? html`<div class="section"><h2>他の面との関係</h2></div><ul class="card plain">${rels.map((r) => {
        const other = a.planes.find((x) => x.id === (r.from === p.id ? r.to : r.from));
        return other ? html`<li><b>${r.type}</b> <a href="#/knowledge/plane/${other.id}">${other.name}</a> — ${r.description}</li>` : '';
      })}</ul>` : ''}
      <div class="section"><h2>関わる本</h2></div>
      <div class="chips">${bookIds.map((id) => html`<a class="chip" href="#/book/${id}">${state.library.books[id]?.title}</a>`)}</div>`;
  },
};

export const isolatedView = {
  render({ state }) {
    const hs = (state.analysis?.isolated || []).map((id) => analysisPointById(state.library, id)).filter(Boolean);
    return html`<a class="back" href="#/knowledge">‹ 知識</a><div class="page-head"><h1>まだつながっていない点</h1></div>
      ${hs.map((h) => pointCard(h, { library: state.library }))}`;
  },
};

/** 前回の分析のあとに増えた点（知識の画面・ホームの「増えた点 N 件」から。数え方は pendingPoints と同じ） */
export const pendingView = {
  render({ state }) {
    const head = html`<a class="back" href="#/knowledge">‹ 知識</a><div class="page-head"><h1>前回の分析のあとに増えた点</h1></div>`;
    if (!state.analysis) return html`${head}<p class="card small muted">まだ分析していません。</p>`;
    const hs = pendingPointList(analysisPoints(state.library), state.analysis);
    // 分析し直して増えた点が無くなっても、終わったこと（失敗ならその理由）が見えるように進み具合は残す
    if (!hs.length) return html`${head}<p class="card small muted">前回の分析のあとに増えた点はありません。</p>${jobPanel(state.job)}`;
    // NIH-121: メモ・タグ・★を付け終えたら、知識の画面へ戻らずに分析し直せる
    return html`${head}
      <p class="help">${hs.length} 件。まだどの線(グループ)にも入っていません。分析し直す前に、自分のメモ・タグ・★を付けておくと、次の分析の線に反映されます。</p>
      ${hs.map((h) => pointCard(h, { library: state.library }))}
      <div class="row">${runAnalysisButton(state)}</div>
      ${jobPanel(state.job)}`;
  },
};

/** おすすめで「読みたい」を付けた本の一覧 */
function wantList(library) {
  const want = feedbackByStatus(library).want;
  if (!want.length) return '';
  return html`<div class="section"><h2>読みたい本</h2><span class="small muted">${want.length}</span></div>
    <ul class="card plain">${want.map((f) => html`<li>${f.title}${f.author ? html` <span class="small muted">— ${f.author}</span>` : ''}</li>`)}</ul>`;
}


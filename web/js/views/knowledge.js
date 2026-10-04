// 知識（AI 分析）の画面: 点 → 線 → 面 → 立体、おすすめの本
import { html, raw, esc, safeUrl } from '../html.js';
import { FEEDBACK_LABELS, feedbackByStatus, feedbackFor, libraryStats } from '../../core/model.js';
import { layoutKnowledgeMap } from '../../core/knowledge-map.js';
import { isoDate, truncate } from '../../core/text.js';
import { TFIDF_HINT } from '../../core/analysis/pipeline.js';
import { hasChanges } from '../../core/analysis/changes.js';
import { pendingPoints } from '../../core/auto-analysis.js';
import { analysisPointById, analysisPoints, isThought } from '../../core/points.js';
import { lineIndex, pointCard } from '../ui.js';
import { amazonKindleUrl, findWishlistBook, formatPrice } from '../../core/wishlist.js';
import { loadWishlist } from '../wishlist-data.js';
import { companion } from '../services.js';
import { answerBlock } from './thoughts.js';

const STAGES = [
  ['embed', '点'],
  ['lines', '線'],
  ['planes', '面'],
  ['solid', '立体'],
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

/**
 * 自動の分析の状態（PC の bh serve が、点が増えたら人の操作なしに分析し直す）。
 * PC の情報（/api/info）を取り直したときに、この欄だけ差し替える（app.js の PC_INFO_BOXES）
 */
export function autoStatusBlock(state) {
  if (state.settings.ai.mode !== 'companion') return html`<p class="small muted">自動の分析は、PC のコンパニオン（bh serve）を使うときに動きます。</p>`;
  const au = state.pcInfo?.autoAnalysis;
  if (!au) return '';
  const rule = `前回の分析のあとに点が ${au.minPoints} 件増えるか、${au.maxHours} 時間たって 1 件以上増えると、PC が分析し直します`;
  // bh analyze で分析したときは PC の記録が無いので、手元の分析結果の時刻（最後に成功した分析）で補う
  const okAt = au.lastSuccessAt || state.analysis?.createdAt;
  const cancelled = au.lastCancelledAt && (!au.lastSuccessAt || au.lastCancelledAt > au.lastSuccessAt);
  return html`<p class="small">自動の分析: ${au.enabled ? html`<b>オン</b> — ${rule}` : html`<b>オフ</b>（PC で <span class="code">bh config auto on</span> で入れられます）`}</p>
    <p class="small muted">最後に成功: ${when(okAt)}${au.lastTrigger === 'auto' && au.lastSuccessAt && !au.lastError && !cancelled ? '（自動）' : ''}</p>
    ${cancelled ? html`<p class="small muted">${when(au.lastCancelledAt)} に分析を中止しました。少し時間をおいてから、PC が自動で始め直します。</p>` : ''}
    ${au.lastError ? html`<p class="notice err">${when(au.lastErrorAt)} の分析に失敗しました: ${au.lastError}。前回の結果はそのまま残っています。次の機会に PC がもう一度試します。</p>` : ''}`;
}

const REBUILT = {
  full: '「最初から作り直す」で、すべて作り直しました',
  grew: '前回作り直したときから点が大きく増えたので、最初から作り直しました',
  format: '今回は最初から作り直しました',
};

/**
 * 前回からの変化（増えた線・大きくなった線・消えた線・新しくつながった点）。
 * links: 線の画面へのリンクを張るか（過去の分析では、今の分析に無い線を指すことがあるので張らない）
 */
function changesBlock(a, { links = true } = {}) {
  const c = a.changes;
  if (!c) return '';
  const head = html`<div class="section"><h2>前回からの変化</h2><span class="small muted">${isoDate(c.previousAt)} から</span></div>`;
  if (c.rebuilt) return html`${head}<p class="card small">${REBUILT[c.reason] || REBUILT.format}（線 ${a.lines.length} 本・面 ${a.planes.length}）。次からは、変わったところだけを作り直します。</p>`;
  if (!hasChanges(c)) return html`${head}<p class="card small muted">線の顔ぶれは変わりませんでした。</p>`;
  const lineName = (id, fallback) => a.lines.find((l) => l.id === id)?.name || fallback;
  const chip = (id, label) => (links ? html`<a class="line-chip" href="#/knowledge/line/${id}">${label}</a>` : html`<span class="line-chip">${label}</span>`);
  const connected = new Map();
  for (const p of c.connectedPoints) connected.set(p.lineId, (connected.get(p.lineId) || 0) + 1);
  return html`${head}
    <section class="card stack changes">
      ${c.addedLines.length ? html`<div><h3 class="small">新しい線 ${c.addedLines.length}</h3><div class="hl-lines">${c.addedLines.map((l) => chip(l.id, lineName(l.id, l.name)))}</div></div>` : ''}
      ${c.grownLines.length ? html`<div><h3 class="small">大きくなった線 ${c.grownLines.length}</h3><div class="hl-lines">${c.grownLines.map((l) => chip(l.id, `${lineName(l.id, l.name)} ＋${l.added}`))}</div></div>` : ''}
      ${c.removedLines.length ? html`<div><h3 class="small">消えた線 ${c.removedLines.length}</h3><p class="small muted">${c.removedLines.map((l) => l.name).join('、')}</p></div>` : ''}
      ${c.connectedPoints.length ? html`<div><h3 class="small">新しくつながった点 ${c.connectedPoints.length}</h3><div class="hl-lines">${[...connected].map(([id, n]) => chip(id, `${lineName(id, '線')}に ${n} 点`))}</div></div>` : ''}
    </section>`;
}

export const knowledge = {
  render({ state }) {
    const a = state.analysis;
    const s = libraryStats(state.library);
    const job = state.job;
    const summary = aiSummary(state.settings, state.servedByCompanion);
    const pending = a ? pendingPoints(analysisPoints(state.library), a) : 0;
    const runBtn = html`<button class="btn primary" data-action="run-analysis" ${job?.running || s.points < 4 ? 'disabled' : ''}>${a ? '分析し直す' : '点をつないで分析する'}</button>`;
    const head = html`<div class="page-head"><div><h1>知識</h1><div class="sub">点 ${s.points} → 線 ${a?.lines.length ?? '–'} → 面 ${a?.planes.length ?? '–'} → 立体</div></div></div>
      <div class="card stack">
        <p class="small">AI: ${summary || html`<b>未設定</b> — <a href="#/settings">AI の接続を設定する</a>`}</p>
        ${s.points < 4 ? html`<p class="notice">分析には 4 件以上の点が必要です。<a href="#/import">取り込む</a>か、上の「メモ」で思いつきを書いてください。</p>` : ''}
        <div class="row">${runBtn}${a ? html`<button class="btn" data-action="rerun-recommend" ${job?.running ? 'disabled' : ''}>おすすめを選び直す</button>` : ''}</div>
        ${a ? html`<p class="small muted">前回の分析: ${isoDate(a.createdAt)}・${a.model?.chat}${a.model?.embed ? ' / ' + a.model.embed : ''}・点 ${a.stats.points}${a.stats.calls ? `・AI を呼んだ回数 ${a.stats.calls.chat + a.stats.calls.embed}` : ''}</p>
          <p class="small">前回の分析のあとに増えた点: <b>${pending}</b> 件${pending ? '（「分析し直す」で、変わったところだけ作り直します）' : ''}</p>` : ''}
        <div id="auto-status">${autoStatusBlock(state)}</div>
        ${a ? html`<p class="small"><button type="button" class="btn small" data-action="run-analysis-full" ${job?.running ? 'disabled' : ''}>最初から作り直す</button> <span class="muted">線・面を前回から引き継がず、すべて作り直します（時間がかかります）</span></p>` : ''}
        ${a?.model?.embed === 'tfidf' ? html`<p class="notice">${TFIDF_HINT}</p>` : ''}
      </div>
      ${jobPanel(job)}`;
    if (!a) {
      return html`${head}
        <div class="section"><h2>分析のしくみ</h2></div>
        <ol class="card help stack" style="padding-left:2em">
          <li><b style="color:var(--layer-point)">点</b> — ハイライトを埋め込みベクトルにします（埋め込みモデルが無ければ文字の特徴で代用）。</li>
          <li><b style="color:var(--layer-line)">線</b> — 意味の近い点を束ね、LLM が共通する考えを一段抽象化した「概念」にします。本をまたいだつながりが見つかります。</li>
          <li><b style="color:var(--layer-plane)">面</b> — 近い線を束ね、LLM がテーマとしてまとめます。</li>
          <li><b style="color:var(--layer-solid)">立体</b> — 面どうしの関係から、知識の核・行動の原則・まだ答えの無い問いを組み立てます。</li>
          <li><b>本</b> — 立体と「問い」から次に読む本を選び、書誌データベースで実在を確認します。</li>
        </ol>`;
    }
    const recs = a.recommendations || [];
    return html`${head}
      ${changesBlock(a)}
      <div class="section"><h2>立体</h2></div>
      <section class="card solid-card stack">
        <div class="layer-label solid">立体 ・ 知識の核</div>
        <h2>${a.solid.title}</h2>
        <p class="core">${a.solid.core}</p>
        ${a.solid.principles?.length ? html`<div><h3 class="small">行動の原則</h3><ul class="plain">${a.solid.principles.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
        ${a.solid.questions?.length ? html`<div><h3 class="small">これからの問い（知識の空白）</h3><p class="small muted">答え（考えたこと・やってみたこと）は思いつきとして、次の分析から点になります。</p><ul class="plain questions">${a.solid.questions.map((q) => html`<li>${q}${answerBlock(state.library, { question: q, kind: 'solid' })}</li>`)}</ul></div>` : ''}
      </section>

      <div class="section"><h2>知識マップ</h2><span class="small muted">面と線をタップ</span></div>
      ${mapSvg(a)}

      <div class="section"><h2>面（テーマ）</h2><span class="small muted">${a.planes.length}</span></div>
      ${a.planes.map((p) => planeCard(a, p))}

      ${recs.length || a.recommendationNote
        ? html`<div class="section"><h2>おすすめの本</h2><span class="small muted">${isoDate(a.recommendedAt || a.createdAt)}</span></div>
          ${a.recommendationNote ? html`<p class="notice">${a.recommendationNote}</p>` : ''}
          ${recs.map((r, i) => recCard(a, r, i, state.library))}
          ${recs.length ? html`<p class="small muted">AI は書誌データベース（Google Books）で見つけた実在の本から選びます。検索できないときは AI が挙げた書名を Google Books・国立国会図書館サーチで確認します（✓ が確認済み）。</p>` : ''}`
        : ''}

      ${wantList(state.library)}

      ${a.isolated?.length ? html`<div class="section"><h2>まだつながっていない点</h2><span class="small muted">${a.isolated.length}</span></div>
        <p class="help">どの線にも入らなかった点です。読書を重ねると、いつか線になるかもしれません。</p>
        <a class="btn small" href="#/knowledge/isolated">見る</a>` : ''}

      ${pcConfigured(state) ? html`<div class="section"><h2>分析の履歴</h2><span class="small muted">PC に直近 12 回分</span></div><div id="analysis-history"><p class="small muted">PC に問い合わせています…</p></div>` : ''}`;
  },
  mount(root, ctx) {
    if (ctx?.state && pcConfigured(ctx.state)) renderHistoryList(root.querySelector('#analysis-history'), ctx.state);
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

/** 変化の要約（履歴の一覧の 1 行） */
function changeSummary(c) {
  if (!c) return '最初の分析';
  if (c.rebuilt) return '最初から作り直した';
  const parts = [c.addedLines ? `新しい線 ${c.addedLines}` : '', c.grownLines ? `大きくなった線 ${c.grownLines}` : '', c.removedLines ? `消えた線 ${c.removedLines}` : '', c.connectedPoints ? `つながった点 ${c.connectedPoints}` : ''].filter(Boolean);
  return parts.join('・') || '線の顔ぶれは変わらず';
}

/** PC（コンパニオン）を使う設定で、PC の場所が分かっているか（GitHub Pages で開いただけなら localhost に問い合わせない） */
const pcConfigured = (state) => state.settings.ai.mode === 'companion' && Boolean(state.servedByCompanion || state.settings.ai.companionUrl);

function historyListHtml(items, state) {
  return items.length
    ? html`<ul class="card plain history-list">${items.map((h) => html`<li><a href="#/knowledge/history/${h.id}">${when(h.createdAt)}</a> <span class="small muted">点 ${h.stats?.points ?? '–'}・線 ${h.stats?.lines ?? '–'}・面 ${h.stats?.planes ?? '–'}${h.createdAt === state?.analysis?.createdAt ? '（いま表示している分析）' : ''}</span><br><span class="small">${changeSummary(h.changes)}</span></li>`)}</ul>`
    : html`<p class="small muted">まだ履歴がありません（PC で分析すると残ります）。</p>`;
}

/**
 * 分析の履歴（PC にだけある）。前に取った一覧をすぐ出し（描き直しで位置がずれないように）、PC から取り直して差し替える。
 * PC とつながらなければその旨を出す
 */
let historyToken = 0;
let lastHistory = null;
function renderHistoryList(box, state) {
  if (!box) return;
  const token = ++historyToken;
  if (lastHistory) box.innerHTML = String(historyListHtml(lastHistory, state));
  companion.history().then(
    (items) => {
      lastHistory = items;
      if (token === historyToken && box.isConnected) box.innerHTML = String(historyListHtml(items, state));
    },
    (e) => {
      if (token === historyToken && box.isConnected && !lastHistory) box.innerHTML = String(html`<p class="small muted">履歴は PC にあります。PC とつながっていないので出せません（${e.message}）。</p>`);
    },
  );
}

/** 過去の分析を 1 回分見る（読むだけ。線・面の画面は今の分析のものなので、リンクは張らない） */
export const historyView = {
  render() {
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>過去の分析</h1><div class="sub" id="history-sub">PC から読み込んでいます…</div></div></div>
      <div id="history-body"><p class="loading">読み込み中…</p></div>`;
  },
  mount(root, { params }) {
    const body = root.querySelector('#history-body');
    const sub = root.querySelector('#history-sub');
    companion.historyEntry(params.id).then(
      (a) => {
        if (!body.isConnected) return;
        sub.textContent = `${when(a.createdAt)}・${a.model?.chat || ''}${a.model?.embed ? ' / ' + a.model.embed : ''}・点 ${a.stats?.points ?? '–'} → 線 ${a.lines.length} → 面 ${a.planes.length}`;
        body.innerHTML = String(html`${changesBlock(a, { links: false })}
          <div class="section"><h2>立体</h2></div>
          <section class="card solid-card stack">
            <h2>${a.solid?.title || ''}</h2>
            <p class="core">${a.solid?.core || ''}</p>
            ${a.solid?.principles?.length ? html`<div><h3 class="small">行動の原則</h3><ul class="plain">${a.solid.principles.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
            ${a.solid?.questions?.length ? html`<div><h3 class="small">問い</h3><ul class="plain">${a.solid.questions.map((q) => html`<li>${q}</li>`)}</ul></div>` : ''}
          </section>
          <div class="section"><h2>面と線</h2></div>
          ${a.planes.map((p) => html`<section class="card plane-card"><div class="layer-label plane">面</div><h3>${p.name}</h3><p class="small">${p.summary}</p>
            <ul class="plain small">${p.lineIds.map((id) => a.lines.find((l) => l.id === id)).filter(Boolean).map((l) => html`<li><b>${l.name}</b> <span class="muted">点 ${l.highlightIds.length}</span></li>`)}</ul></section>`)}`);
      },
      (e) => {
        if (body.isConnected) body.innerHTML = String(html`<p class="notice err">過去の分析を読めませんでした: ${e.message}</p>`);
      },
    );
  },
};

function planeCard(a, p) {
  const lines = p.lineIds.map((id) => a.lines.find((l) => l.id === id)).filter(Boolean);
  return html`<section class="card plane-card">
    <div class="layer-label plane">面</div>
    <h3><a href="#/knowledge/plane/${p.id}">${p.name}</a></h3>
    <p class="small">${p.summary}</p>
    <div class="lines-of-plane">${lines.map((l) => html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}</em></a>`)}</div>
  </section>`;
}

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

/** 立体を放射状の図にする（中心=核、内側=面、外側=線） */
function mapSvg(a) {
  const { nodes, edges } = layoutKnowledgeMap(a);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // ラベルの幅も含めて表示範囲を決める（全角 1 文字 ≒ フォントサイズ）
  const extent = (n) => {
    if (n.kind !== 'line') {
      const half = (Math.min([...n.label].length, 13) * (n.kind === 'core' ? 96 : 84)) / 2;
      return [n.x - half, n.x + half];
    }
    const width = Math.min([...n.label].length, 10) * 66 + 60;
    return n.x < -1 ? [n.x - width, n.x] : n.x > 1 ? [n.x, n.x + width] : [n.x - width / 2, n.x + width / 2];
  };
  const xs = nodes.flatMap(extent);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - 40;
  const minY = Math.min(...ys) - 120;
  const w = Math.max(...xs) - minX + 40;
  const h = Math.max(...ys) - minY + 200;
  const edgeSvg = edges
    .map((e) => {
      const f = byId.get(e.from);
      const t = byId.get(e.to);
      if (!f || !t) return '';
      if (e.kind === 'relation') {
        const mx = (f.x + t.x) / 2 * 0.55;
        const my = (f.y + t.y) / 2 * 0.55;
        return `<path class="edge-relation" d="M${f.x},${f.y} Q${mx},${my} ${t.x},${t.y}"><title>${esc(e.label)}</title></path>`;
      }
      return `<line class="edge-${e.kind === 'core' ? 'core' : 'plane'}" x1="${+f.x}" y1="${+f.y}" x2="${+t.x}" y2="${+t.y}"/>`;
    })
    .join('');
  const nodeSvg = nodes
    .map((n) => {
      const r = n.kind === 'core' ? 70 : n.kind === 'plane' ? 48 : Math.min(36, 16 + (n.weight || 1) * 2);
      const label = esc(truncate(n.label, n.kind === 'line' ? 9 : 12));
      const anchor = n.kind === 'line' ? (n.x < -1 ? 'end' : n.x > 1 ? 'start' : 'middle') : 'middle';
      const tx = n.kind === 'line' ? n.x + (anchor === 'end' ? -r - 16 : anchor === 'start' ? r + 16 : 0) : n.x;
      const ty = n.kind === 'line' ? n.y + 22 : n.y + r + 92;
      const href = n.kind === 'plane' ? `#/knowledge/plane/${encodeURIComponent(n.ref)}` : n.kind === 'line' ? `#/knowledge/line/${encodeURIComponent(n.ref)}` : '#/knowledge';
      return `<a href="${esc(href)}" class="n-${n.kind}"><circle cx="${+n.x}" cy="${+n.y}" r="${+r}"/><text x="${+tx}" y="${+ty}" text-anchor="${anchor}">${label}</text><title>${esc(n.label)}</title></a>`;
    })
    .join('');
  return html`<div class="map-wrap" id="map-wrap">
    <div class="map-tools"><button type="button" data-action="map-zoom" data-dir="1" aria-label="拡大">＋</button><button type="button" data-action="map-zoom" data-dir="-1" aria-label="縮小">－</button></div>
    <svg id="knowledge-map" viewBox="${minX} ${minY} ${w} ${h}" width="100%" role="img" aria-label="知識マップ">${raw(edgeSvg)}${raw(nodeSvg)}</svg>
  </div>`;
}

export const lineView = {
  render({ state, params }) {
    const a = state.analysis;
    const l = a?.lines.find((x) => x.id === params.id);
    if (!l) return html`<p class="empty">線が見つかりません。<a href="#/knowledge">知識へ</a></p>`;
    const plane = a.planes.find((p) => p.lineIds.includes(l.id));
    // 線の点（本に引いた線と思いつき）
    const hs = l.highlightIds.map((id) => analysisPointById(state.library, id)).filter(Boolean);
    const idx = lineIndex(a);
    const books = new Set(hs.filter((h) => !isThought(h)).map((h) => h.bookId));
    const thoughts = hs.filter(isThought).length;
    const siblings = plane ? plane.lineIds.filter((id) => id !== l.id).map((id) => a.lines.find((x) => x.id === id)).filter(Boolean) : [];
    return html`<a class="back" href="${plane ? `#/knowledge/plane/${plane.id}` : '#/knowledge'}">‹ ${plane ? plane.name : '知識'}</a>
      <div class="layer-label line">線 ・ ${books.size} 冊の本${thoughts ? `と思いつき ${thoughts} 件` : ''}をつなぐ</div>
      <h1 style="margin:4px 0 12px">${l.name}</h1>
      <section class="card stack">
        <p style="font-family:var(--serif);line-height:1.9">${l.summary}</p>
        ${l.insight ? html`<p class="notice ok">問い: ${l.insight}</p>${answerBlock(state.library, { question: l.insight, kind: 'line', ref: l.id })}` : ''}
        ${l.keywords?.length ? html`<div class="chips">${l.keywords.map((k) => html`<a class="chip" href="#/search?q=${encodeURIComponent(k)}">${k}</a>`)}</div>` : ''}
      </section>
      <div class="section"><h2>つながっている点</h2><span class="small muted">${hs.length}</span></div>
      ${hs.map((h) => pointCard(h, { library: state.library, lines: (idx.get(h.id) || []).filter((x) => x.id !== l.id) }))}
      ${siblings.length ? html`<div class="section"><h2>同じ面の線</h2></div><div class="lines-of-plane">${siblings.map((s) => html`<a class="line-row" href="#/knowledge/line/${s.id}"><b>${s.name}</b><span>${s.summary}</span></a>`)}</div>` : ''}`;
  },
};

export const planeView = {
  render({ state, params }) {
    const a = state.analysis;
    const p = a?.planes.find((x) => x.id === params.id);
    if (!p) return html`<p class="empty">面が見つかりません。<a href="#/knowledge">知識へ</a></p>`;
    const rels = (a.solid.relations || []).filter((r) => r.from === p.id || r.to === p.id);
    const lines = p.lineIds.map((id) => a.lines.find((l) => l.id === id)).filter(Boolean);
    const bookIds = [...new Set(lines.flatMap((l) => l.highlightIds.map((id) => state.library.highlights[id]?.bookId)).filter(Boolean))];
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="layer-label plane">面</div>
      <h1 style="margin:4px 0 12px">${p.name}</h1>
      <section class="card"><p style="font-family:var(--serif);line-height:1.9">${p.summary}</p></section>
      <div class="section"><h2>線</h2><span class="small muted">${lines.length}</span></div>
      <div class="lines-of-plane">${lines.map((l) => html`<a class="line-row" href="#/knowledge/line/${l.id}"><b>${l.name}</b><span>${l.summary}</span><em>点 ${l.highlightIds.length}</em></a>`)}</div>
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

/** おすすめで「読みたい」を付けた本の一覧 */
function wantList(library) {
  const want = feedbackByStatus(library).want;
  if (!want.length) return '';
  return html`<div class="section"><h2>読みたい本</h2><span class="small muted">${want.length}</span></div>
    <ul class="card plain">${want.map((f) => html`<li>${f.title}${f.author ? html` <span class="small muted">— ${f.author}</span>` : ''}</li>`)}</ul>`;
}


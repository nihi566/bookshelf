// 画面の部品（ハイライト・思いつきのカード、本の行、トースト、シート）
import { html, mark } from './html.js';
import { isTextEdited, listBooks, SOURCES } from '../core/model.js';
import { hash, isoDate, truncate } from '../core/text.js';
import { kindleSyncState } from '../core/kindle-status.js';
import { bookCoverUrl } from '../core/covers.js';
import { analysisPoints, isThought } from '../core/points.js';
import { pendingPoints } from '../core/auto-analysis.js';
import { serveVersionCheck } from '../core/serve-version.js';
import { THOUGHT_LABEL, THOUGHT_STATUS, isThoughtUnsynced } from '../core/thoughts.js';

export const COLOR_VAR = {
  yellow: 'var(--hl-yellow)',
  blue: 'var(--hl-blue)',
  green: 'var(--hl-green)',
  pink: 'var(--hl-pink)',
  orange: 'var(--hl-orange)',
  red: 'var(--hl-red)',
  purple: 'var(--hl-purple)',
};

export const sourceBadge = (s) => html`<span class="badge ${s}">${SOURCES[s] || s}</span>`;

export function spineColor(title) {
  const h = parseInt(hash(title).slice(0, 4), 36) % 360;
  return `hsl(${h} 32% 42%)`;
}

/** 本の表紙。画像が無い・読めないときは背表紙の色と書名の 1 文字目（画像は読めなければ app.js が外す） */
export function bookSpine(b, cls = 'book-spine') {
  const url = bookCoverUrl(b);
  return html`<span class="${cls}" style="background:${spineColor(b.title)}" aria-hidden="true">${[...b.title][0] || ''}${url ? html`<img src="${url}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-cover>` : ''}</span>`;
}

/** ハイライト ID → それを含む線 の対応表 */
export function lineIndex(analysis) {
  const map = new Map();
  for (const l of analysis?.lines || []) {
    for (const id of l.highlightIds) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(l);
    }
  }
  return map;
}

function locationParts(h) {
  return [h.location != null ? `位置 ${h.location}` : '', h.page ? `p.${h.page}` : '', isoDate(h.createdAt)].filter(Boolean);
}

export function locationText(h) {
  return locationParts(h).join(' · ');
}

export function highlightCard(h, { library, lines = [], query = '', showBook = true } = {}) {
  const book = library.books[h.bookId];
  return html`<article class="hl" style="--hl-color:${COLOR_VAR[h.color] || 'var(--hl-yellow)'}" data-hl="${h.id}">
    <p class="hl-text">${query ? mark(h.text, query) : h.text}</p>
    ${h.note ? html`<div class="hl-note"><b>${h.kind === 'note' ? 'メモ（単独）' : 'メモ'}</b>${query ? mark(h.note, query) : h.note}</div>` : ''}
    ${h.userNote ? html`<div class="hl-note"><b>自分のメモ</b>${h.userNote}</div>` : ''}
    ${h.tags?.length ? html`<div class="hl-tags">${h.tags.map((t) => html`<a href="#/search?q=${encodeURIComponent('#' + t)}">#${t}</a>`)}</div>` : ''}
    ${lines.length ? html`<div class="hl-lines">${lines.map((l) => html`<a class="line-chip" href="#/knowledge/line/${l.id}">${l.name}</a>`)}</div>` : ''}
    <div class="hl-foot">
      <div class="hl-meta">
        ${showBook && book ? html`<a class="book-link" href="#/book/${book.id}">${book.title}</a>` : ''}
        <span>${locationParts(h).map((p, i) => html`${i ? ' · ' : ''}<span class="nowrap">${p}</span>`)}</span>
        ${sourceBadge(h.source)}${isTextEdited(h) ? html` <span class="badge edited" title="取り込んだときの文から直しています（✎ で元に戻せます）">直した文</span>` : ''}
      </div>
      <div class="hl-actions">
        <button class="icon-btn ${h.favorite ? 'on' : ''}" data-action="fav" data-id="${h.id}" aria-pressed="${String(Boolean(h.favorite))}" aria-label="お気に入り">${h.favorite ? '★' : '☆'}</button>
        <button class="icon-btn" data-action="edit" data-id="${h.id}" aria-label="点を編集">✎</button>
        <button class="icon-btn" data-action="delete" data-id="${h.id}" aria-label="点を削除" title="点を削除">×</button>
        <button class="icon-btn" data-action="copy" data-id="${h.id}" aria-label="引用をコピー">⧉</button>
        <a class="icon-btn" href="#/point/${h.id}" aria-label="点のページを開く（永久ノート）">↗</a>
      </div>
    </div>
  </article>`;
}

// くっつける相手の文は、この点に接する側（前の点は終わり・次の点は始まり）を短く見せる
const JOIN_PREVIEW = 40;
function tail(s, n) {
  // 末尾だけを 1 文字ずつに分ける（同期で届いた長い文・文字列でない値でも重くならず、落ちない）
  const chars = Array.from(String(s ?? '').slice(-(2 * n + 2)));
  return chars.length > n ? '…' + chars.slice(-(n - 1)).join('') : chars.join('');
}

/** 同じ本の前・次の点とくっつけるボタン（ハイライトするときに 2 つに分かれてしまった文を 1 つに戻す） */
function joinRows({ prev, next }) {
  if (!prev && !next) return '';
  return html`<div class="join-rows">
    ${prev ? html`<div class="row spread"><p class="help">前の点: ${tail(prev.text, JOIN_PREVIEW)}</p><button class="btn small" value="join-prev">前の点とくっつける</button></div>` : ''}
    ${next ? html`<div class="row spread"><p class="help">次の点: ${truncate(next.text, JOIN_PREVIEW)}</p><button class="btn small" value="join-next">次の点とくっつける</button></div>` : ''}
  </div>`;
}

/**
 * 点の編集シート。文を直した点は取り込んだときの文と、それを文の欄に入れ直すボタン（保存はしない）を出す。
 * neighbors: 同じ本の前・次の点（highlightNeighbors）。渡すと、くっつけるボタンを出す
 */
export function highlightEditSheet(h, neighbors = {}) {
  return html`<h2>点を編集</h2>
    <label class="field"><span>線を引いた文</span><textarea name="text" rows="4">${h.text}</textarea></label>
    ${isTextEdited(h) ? html`<div class="row spread original-text"><p class="help">取り込んだときの文: ${h.originalText}</p><button type="button" class="btn small" data-action="restore-original-text" data-id="${h.id}">この文に戻す</button></div>` : ''}
    ${joinRows(neighbors)}
    <label class="field"><span>自分のメモ</span><textarea name="userNote">${h.userNote || ''}</textarea></label>
    <label class="field"><span>タグ（空白かカンマ区切り）</span><input type="text" name="tags" value="${(h.tags || []).join(' ')}" placeholder="例: 習慣 仕事"></label>
    <p class="help">自分のメモ・タグ・★は、AI が点をつなぐときに「読者自身の言葉」として使います（次の分析から）。</p>
    <div class="row spread"><button class="btn danger" value="delete">この点を削除</button><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

// 思いつきの状態を変えるボタン（いまの状態から行ける先）
const STATUS_MOVES = {
  inbox: [['done', '整理済みにする'], ['discarded', '捨てる']],
  done: [['inbox', '未整理に戻す'], ['discarded', '捨てる']],
  discarded: [['inbox', '未整理に戻す']],
};

/** 自分で入れた線(グループ)（assigned: { id, name, missing }。missing: 分析し直して無くなった） */
function assignedLineRow(assigned) {
  if (!assigned) return '';
  return assigned.missing
    ? html`<p class="small assigned-line missing">自分で入れた線(グループ)「${assigned.name}」は、分析し直して無くなりました。外して入れ直してください</p>`
    : html`<p class="small assigned-line">自分で入れた線(グループ): <a href="#/knowledge/line/${assigned.id}">${assigned.name}</a></p>`;
}

/**
 * 思いつきに「PC に未同期」の印を出すときに渡すもの（thoughtCard の pcSync）。PC を使わない画面では null。
 * PC に届かなかったまま（Tailscale がまだつながっていない等）の画面は、PC ではないと分かるまで PC を使う画面として扱う
 * @param {{ settings: { ai: { mode: string, companionUrl: string } }, servedByCompanion: boolean, companionOriginChecked?: boolean, lastSync: string | null }} state
 * @returns {{ lastSync: string | null } | null}
 */
export function pcSyncOf(state) {
  const ai = state.settings?.ai;
  if (ai?.mode !== 'companion') return null;
  if (!state.servedByCompanion && !(ai.companionUrl || '').trim() && state.companionOriginChecked) return null;
  return { lastSync: state.lastSync };
}

/**
 * 思いつきのカード。moves: 状態を変えるボタンを出す（受け箱・メモの一覧）。
 * assigned: 自分で入れた線(グループ)（受け箱では入れる・外すボタンも出す）。
 * pcSync: pcSyncOf(state)。最後の同期より後に書いた・直したメモに「PC に未同期」と出す
 */
export function thoughtCard(t, { lines = [], query = '', moves = false, assigned = null, pcSync = null } = {}) {
  const lineButton = assigned
    ? html`<button type="button" class="btn small" data-action="thought-unline" data-id="${t.id}">線(グループ)から外す</button>`
    : t.status === 'inbox'
      ? html`<button type="button" class="btn small" data-action="thought-to-line" data-id="${t.id}">線(グループ)に入れる</button>`
      : '';
  return html`<article class="hl thought" data-hl="${t.id}">
    <p class="hl-text">${query ? mark(t.text, query) : t.text}</p>
    ${t.answerTo ? html`<div class="hl-note"><b>問いへの答え</b>${t.answerTo.question}</div>` : ''}
    ${assignedLineRow(assigned)}
    ${lines.length ? html`<div class="hl-lines">${lines.map((l) => html`<a class="line-chip" href="#/knowledge/line/${l.id}">${l.name}</a>`)}</div>` : ''}
    <div class="hl-foot">
      <div class="hl-meta">
        <span class="badge thought">${THOUGHT_LABEL}</span>
        <span>${isoDate(t.createdAt)}</span>
        <span class="thought-status ${t.status}">${THOUGHT_STATUS[t.status] || ''}</span>
        ${pcSync && isThoughtUnsynced(t, pcSync.lastSync) ? html`<span class="badge unsynced" title="この端末にだけあります。PC と同期すると消えます">PC に未同期</span>` : ''}
      </div>
      <div class="hl-actions">
        <button class="icon-btn" data-action="edit-thought" data-id="${t.id}" aria-label="メモを編集">✎</button>
        <button class="icon-btn" data-action="copy" data-id="${t.id}" aria-label="メモをコピー">⧉</button>
        <a class="icon-btn" href="#/point/${t.id}" aria-label="点のページを開く（永久ノート）">↗</a>
      </div>
    </div>
    ${moves
      ? html`<div class="row thought-moves">${(STATUS_MOVES[t.status] || []).map(([status, label]) => html`<button type="button" class="btn small" data-action="thought-status" data-id="${t.id}" data-status="${status}">${label}</button>`)}${t.status === 'inbox' ? html`<button type="button" class="btn small" data-action="thought-to-note" data-id="${t.id}">永久ノートにする</button>` : ''}${lineButton}</div>`
      : ''}
  </article>`;
}

/** 点のカード（ハイライトか思いつきか） */
export function pointCard(p, opts = {}) {
  return isThought(p) ? thoughtCard(p, opts) : highlightCard(p, opts);
}

export function bookRow(b) {
  return html`<li><a class="book-item" href="#/book/${b.id}">
    ${bookSpine(b)}
    <span class="grow">
      <span class="title">${b.title}</span>
      <span class="meta">${b.author || '著者不明'} ${b.sources.map(sourceBadge)}${b.isTechnical ? html` <span class="badge tech">技術書</span>` : ''}</span>
    </span>
    <span class="count">${b.count}<span class="unit"> ${b.isTechnical ? '件' : '点'}</span><small>${isoDate(b.lastHighlightedAt) || '-'}</small></span>
  </a></li>`;
}

/**
 * 「読んだ本」の空表示。本が 1 冊も無く PC とつながっていない（PC を設定していない / 同期に失敗した）ときは、
 * PC に本があっても 0 冊に見えて迷うので、つなぎ方を添える。
 * @param {{ settings: { ai: { mode: string, companionUrl: string } }, servedByCompanion: boolean, pcSyncFailed?: boolean, library: object }} state
 */
export function emptyBooksBlock(state) {
  const plain = html`<p class="empty">本がありません。<a href="#/import">取り込む</a></p>`;
  if (state.settings.ai.mode !== 'companion' || listBooks(state.library).length) return plain;
  const pcSet = state.servedByCompanion || state.settings.ai.companionUrl;
  if (pcSet && !state.pcSyncFailed) return plain;
  const head = pcSet ? 'PC と同期できませんでした。' : 'PC とつながっていません。';
  return html`<div class="empty">
      <p class="notice">${head}PC に取り込んだ本は、PC とつなぐとここに出ます。</p>
      <p class="small">PC では <code>bh serve</code> を起動して http://localhost:8787 を開くのが簡単です。ほかの端末からは <a href="#/settings">設定</a> で PC の URL とトークンを入れてください（Chrome でローカルネットワークへのアクセスを聞かれたら許可します）。</p>
      <p>または <a href="#/import">ここで取り込む</a></p>
    </div>`;
}

let toastTimer;
/**
 * 画面の下に短い通知を出す。action を渡すと通知の中にボタンを 1 つ出す（「元に戻す」など）。
 * ボタンは 1 回押すか、通知が消えたら無くなる（見えない通知のボタンを押せるままにしない）
 * @param {string} message
 * @param {number} [ms]
 * @param {{ label: string, run: () => unknown }} [action]
 */
export function toast(message, ms = 2600, action) {
  const el = document.getElementById('toast');
  const hide = () => {
    el.classList.remove('show');
    el.querySelector('.toast-action')?.remove();
  };
  el.textContent = message;
  el.classList.toggle('has-action', Boolean(action));
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      hide();
      Promise.resolve()
        .then(action.run)
        .catch((e) => toast(e?.message || `${action.label}ことができませんでした`, 5000));
    });
    el.append(' ', btn);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, ms);
}

/** シートの入力が開いたときから変わったか。entries は [...new FormData(form)] の形 */
export function sheetDirty(before, after) {
  const key = (entries) => JSON.stringify(entries.map(([k, v]) => [k, String(v)]));
  return key(before) !== key(after);
}

// Enter を「保存」として扱う入力欄（1 行の入力欄と、チェックボックス・ラジオボタン）。
// ここに無い欄で Enter を押すと、ブラウザは並びの最初のボタン（「やめる」「削除」など）を押したことにしてしまう
const TEXT_INPUT = /^(text|search|url|email|tel|number|password|checkbox|radio)$/;

/**
 * 下から出るシート。content は html``、onSubmit(formData, action) を返す。
 * onSubmit が true を返すと開いたまま。例外を投げると、その文をシートの中に出して開いたままにする
 * （トーストはシートの下に隠れて見えないため）
 */
export function openSheet(content, onSubmit) {
  const dialog = document.getElementById('sheet');
  dialog.innerHTML = String(html`<form method="dialog">${content}<p class="notice err sheet-msg" role="alert" hidden></p></form>`);
  const form = dialog.querySelector('form');
  const msg = form.querySelector('.sheet-msg');
  // 保存が終わるまでは次の送信を受け付けない（連打・Enter の二重送信で同じ記録が 2 件できないように）
  let busy = false;
  const initial = [...new FormData(form)];
  // 外側のタップ・Esc で閉じるときは、書きかけがあれば確かめる（うっかり触れてメモを失わない）
  const tryClose = () => {
    if (!sheetDirty(initial, [...new FormData(form)]) || confirm('編集中の内容を破棄して閉じますか？')) dialog.close();
  };
  // 入力欄で Enter を押すと、ブラウザは並びの最初の送信ボタン（「この点を削除」など）を押したことにする。
  // 確認なしで消えないよう、Enter は「保存」ボタンを押したことにする
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT' || !TEXT_INPUT.test(e.target.type)) return;
    // 「保存」が無いシートでは何もしない（最初のボタンを押したことにしない）
    e.preventDefault();
    form.querySelector('button[value="save"]')?.click();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const action = e.submitter?.value || 'save';
    if (action === 'cancel') return dialog.close();
    if (busy) return;
    busy = true;
    msg.hidden = true;
    try {
      const keep = await onSubmit(new FormData(form), action);
      if (keep !== true) dialog.close();
    } catch (err) {
      msg.textContent = err?.message || String(err);
      msg.hidden = false;
    } finally {
      busy = false;
    }
  });
  // 開くたびに差し替える（前に開いたときの処理を残さない。シートの中を押しても外側のタップの処理は消えない）
  dialog.onclick = (e) => {
    if (e.target === dialog) tryClose();
  };
  dialog.oncancel = (e) => {
    e.preventDefault();
    tryClose();
  };
  // 開いただけで書く欄に入らない（スマホではキーボードが開き、閉じないと下のボタンが押せない。NIH-90）。
  // dialog に autofocus が無いと、showModal() は中の最初の欄に入る。開いてすぐ書くシートは、その欄に autofocus を付けてある
  const typeFirst = Boolean(form.querySelector('[autofocus]'));
  dialog.toggleAttribute('autofocus', !typeFirst);
  dialog.showModal();
  if (!typeFirst) dialog.focus({ preventScroll: true });
}

/** 時刻を短く（例: 9/27 18:05） */
function timeText(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * 設定 → 接続を確認 に出す、PC の bh serve の起動時刻と版（古いコードで動いていれば警告も）
 * @param {{ startedAt?: string, version?: string, diskVersion?: string } | undefined} server /api/info の server
 * @param {string} appVersion この画面の sw.js の版（読めなければ空）
 */
export function serveVersionBlock(server, appVersion) {
  const { startedAt, version, warning } = serveVersionCheck({ appVersion, server });
  const started = startedAt && !Number.isNaN(Date.parse(startedAt)) ? timeText(startedAt) : '不明';
  return html`<p class="small muted">PC の bh serve: 起動 ${started}・版 ${version || '不明'}${appVersion ? `（この画面の版 ${appVersion}）` : ''}</p>
    ${warning ? html`<p class="notice err">${warning}</p>` : ''}`;
}

/** 経過時間を短く（例: 50 分 / 2 時間 30 分 / 3 日） */
function elapsedText(fromIso, nowIso) {
  const min = Math.max(0, Math.floor((new Date(nowIso) - new Date(fromIso)) / 60000));
  if (min < 60) return `${min} 分`;
  if (min < 60 * 24) return min % 60 ? `${Math.floor(min / 60)} 時間 ${min % 60} 分` : `${Math.floor(min / 60)} 時間`;
  return `${Math.floor(min / 60 / 24)} 日`;
}

/** ブラウザ拡張（Kindle 自動取り込み）の状態を、画面に出す文の並びにする（HTML ではない。出すときはエスケープされる） */
export function kindleSyncLines(ks, now = new Date().toISOString()) {
  const state = kindleSyncState(ks, now);
  if (state === 'none') return ['自動取り込み: まだ拡張から連絡がありません（拡張機能を入れていない場合は、下の手順で設定できます）'];
  const last = ks.lastCheck;
  const checked = `最終確認 ${timeText(last.at)}`;
  const result = { ok: `正常（${checked}）`, login: `Amazon のログインが切れています（${checked}）`, error: `失敗（${checked}）${last.error ? `: ${last.error}` : ''}` };
  const lines = [];
  if (state === 'stale') {
    lines.push(`自動取り込み: 拡張から ${elapsedText(last.at, now)} 連絡がありません。PC のブラウザが閉じているか、PC に送れていない可能性があります`);
    lines.push(`最後の結果: ${result[last.needLogin ? 'login' : last.ok ? 'ok' : 'error']}`);
  } else if (state === 'ok') {
    lines.push(`自動取り込み: ${result.ok}。線がノートブックに反映されるまで数分かかることがあります`);
  } else if (state === 'login') {
    lines.push(`自動取り込み: ${result.login}。PC のブラウザで read.amazon.co.jp/notebook にログインしてください`);
  } else {
    lines.push(`自動取り込み: ${result.error}`);
  }
  lines.push(ks.lastNew?.at ? `最後に新しい点: ${timeText(ks.lastNew.at)}・${ks.lastNew.added} 件` : '最後に新しい点: まだ届いていません');
  return lines;
}

const ALERT_STATES = ['login', 'error', 'stale'];

/** ホームに出す自動取り込みの警告（1 行）。拡張を使っていない・正常なときは空文字 */
export function kindleSyncAlert(ks, now = new Date().toISOString()) {
  return ALERT_STATES.includes(kindleSyncState(ks, now)) ? kindleSyncLines(ks, now)[0] : '';
}

const ALERT_STYLE = 'display:block;margin-bottom:12px;text-decoration:none';

/** ホームに出す自動取り込みの警告。PC モードで PC の情報を取れているときだけ出す。押すと取り込み画面で詳しく見られる */
export function kindleAlertBlock(state) {
  const text = state.settings.ai.mode === 'companion' && state.pcInfo ? kindleSyncAlert(state.pcInfo.kindleSync) : '';
  return text ? html`<a class="notice err" href="#/import" style="${ALERT_STYLE}">${text}（詳しく）</a>` : '';
}

// ホームの 1 行に収めるため、失敗の理由はここまでで切る
const ANALYSIS_ALERT_REASON_MAX = 80;
const alertReason = (s) => {
  const error = String(s);
  return error.length > ANALYSIS_ALERT_REASON_MAX ? `${error.slice(0, ANALYSIS_ALERT_REASON_MAX)}…` : error;
};

/**
 * ホームに出す Play ブックス（Google ドライブ）の自動取り込みの警告（1 行）。
 * Google を使う設定をしていないとき（configured が true でない。古い bh も含む）・取り込めているときは空文字。
 * 取り込めない本（problemCount）は直るまで続く状態なので、取り込みの画面にだけ出す
 * @param {{ configured?: boolean, error?: string } | null | undefined} g /api/info の google
 * @returns {string}
 */
export function playbooksSyncAlert(g) {
  if (g?.configured !== true || !g.error) return '';
  return `Play ブックスの自動取り込みに失敗しています（${alertReason(g.error)}）`;
}

/**
 * ホームに出す分析の失敗の警告（1 行）。自動の分析がオフのとき・失敗していないとき・最後の失敗より新しい成功があるときは空文字
 * @param {{ enabled?: boolean, lastError?: string, lastErrorAt?: string|null, lastSuccessAt?: string|null, failureCount?: number } | null | undefined} au /api/info の autoAnalysis
 * @returns {string}
 */
export function autoAnalysisAlert(au) {
  if (!au?.enabled || !au.lastError) return '';
  if (au.lastSuccessAt && au.lastErrorAt && au.lastSuccessAt >= au.lastErrorAt) return '';
  const reason = alertReason(au.lastError);
  const count = Number(au.failureCount) || 0;
  return count >= 2 ? `PC の分析が ${count} 回続けて失敗しています（${reason}）` : `PC の分析に失敗しています（${reason}）`;
}

/** ホームの先頭の警告欄（Kindle・Play ブックスの自動取り込み・分析の失敗）。PC モードで PC の情報を取れているときだけ出す。分析の警告は押すと知識の画面へ */
export function homeAlertBlock(state) {
  if (state.settings.ai.mode !== 'companion' || !state.pcInfo) return '';
  const playbooks = playbooksSyncAlert(state.pcInfo.google);
  const text = autoAnalysisAlert(state.pcInfo.autoAnalysis);
  return html`${kindleAlertBlock(state)}${playbooks ? html`<a class="notice err" href="#/import" style="${ALERT_STYLE}">${playbooks}（詳しく）</a>` : ''}${text ? html`<a class="notice err" href="#/knowledge" style="${ALERT_STYLE}">${text}（詳しく）</a>` : ''}`;
}

/**
 * 前回の分析のあとに増えた点（どの線にも「まだつながらない点」にも入っていない点。ID で数える）の数と、「分析し直す」への案内。
 * 知識の画面は 0 件でも数を出す。ホーム（toKnowledge）は 1 件以上のときだけ出し、知識の画面の「分析し直す」へリンクする
 */
export function pendingNudge(state, { toKnowledge = false } = {}) {
  const a = state.analysis;
  if (!a) return '';
  const n = pendingPoints(analysisPoints(state.library), a);
  if (!n) return toKnowledge ? '' : html`<p class="small">前回の分析のあとに増えた点 <b>0</b> 件</p>`;
  // 件数を押すと、数えた点そのものの一覧へ（分析し直す前にメモ・タグ・★を付けられるように）
  const head = html`前回の分析のあとに増えた点 <a href="#/knowledge/pending" title="増えた点を見る"><b>${n}</b> 件</a>`;
  const lead = toKnowledge ? html` — <a href="#/knowledge">分析し直す</a>` : '。「分析し直す」で、変わったところだけ作り直します';
  return html`<p class="small pending-nudge" style="${toKnowledge ? 'margin-top:8px' : ''}">${head}（まだ線につながっていません）${lead}</p>`;
}

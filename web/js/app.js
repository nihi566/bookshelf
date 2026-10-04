// 本 — Web アプリ本体（ルーティング・操作）
import { html } from './html.js';
import { kv, requestPersistence } from './db.js';
import { loadCache, loadState, save, saveCache, state } from './state.js';
import { buildBookmarklet, companion, detectServedByCompanion, download, syncWithPc } from './services.js';
import { kindleAlertBlock, openSheet, toast } from './ui.js';
import { book, books, home, search } from './views/library.js';
import { autoStatusBlock, historyView, isolatedView, knowledge, lineView, planeView } from './views/knowledge.js';
import { discoveriesView, discoveryView } from './views/discoveries.js';
import { farView } from './views/far.js';
import { noteView, notesView } from './views/notes.js';
import { pointView } from './views/point.js';
import { noteActions } from './note-actions.js';
import { markDiscoveryRead } from '../core/discovery-reads.js';
import { FAR_REACTIONS, farConnectionById, reactFar } from '../core/far-reactions.js';
import { importView, kindleSyncBlock, settingsView } from './views/settings.js';
import { wishlist } from './views/wishlist.js';
import { records } from './views/records.js';
import { editThoughtSheet, newThoughtSheet, thoughtsView } from './views/thoughts.js';
import { FEEDBACK_LABELS, addHighlight, deleteBook, emptyLibrary, guessTechnical, listBooks, mergeParsed, registerBook, setFeedback, updateBook, updateHighlight } from '../core/model.js';
import { THOUGHT_STATUS, addThought, deleteThought, thoughtsOf, updateThought } from '../core/thoughts.js';
import { isThought, pointById } from '../core/points.js';
import { randomId } from '../core/text.js';
import { COVER_MAX_LENGTH } from '../core/covers.js';
import { parseFiles } from '../core/parsers/index.js';
import { applyImport, makeBackup } from '../core/importing.js';
import { isNotebookJson, parseNotebookJson } from '../core/parsers/kindle-notebook.js';
import { createLlmClient } from '../core/analysis/llm.js';
import { analyzeLibrary, recommendBooks, recommendationNote } from '../core/analysis/pipeline.js';
import { followJob, pcJobOutcome } from '../core/jobs.js';
import { SAMPLE_BOOKS } from '../core/sample.js';
import { browserStore, loadMarks, toRecommendWishlist } from '../core/wishlist.js';
import { loadWishlist } from './wishlist-data.js';

const ROUTES = [
  [/^\/$/, home, 'home'],
  [/^\/books$/, books, 'books'],
  [/^\/book\/(?<id>[\w-]+)$/, book, 'books'],
  [/^\/wishlist$/, wishlist, 'price'],
  // ハイライトの検索は「読んだ本」の中の画面（タブは持たない）
  [/^\/search$/, search, 'books'],
  [/^\/records$/, records, 'records'],
  // 思いつき（フリートノート）の一覧。受け箱はホームにあるので、タブはホーム
  [/^\/thoughts$/, thoughtsView, 'home'],
  [/^\/knowledge$/, knowledge, 'knowledge'],
  [/^\/knowledge\/line\/(?<id>[\w-]+)$/, lineView, 'knowledge'],
  [/^\/knowledge\/plane\/(?<id>[\w-]+)$/, planeView, 'knowledge'],
  [/^\/knowledge\/isolated$/, isolatedView, 'knowledge'],
  // 遠いつながり（別の本・別の面の点の組を AI が読み、共通する考えがあったもの）
  [/^\/knowledge\/far$/, farView, 'knowledge'],
  // 永久ノート（1 ノート = 1 アイデア）と、点 1 つ（それを根拠にしている永久ノート）
  [/^\/notes$/, notesView, 'knowledge'],
  [/^\/note\/(?<id>[\w-]+)$/, noteView, 'knowledge'],
  [/^\/point\/(?<id>[\w-]+)$/, pointView, 'knowledge'],
  // 過去の分析（履歴は PC にだけある）
  [/^\/knowledge\/history\/(?<id>[0-9TZ]+)$/, historyView, 'knowledge'],
  // 発見（ホームの「発見」から開く）
  [/^\/discovery\/(?<id>[\w-]+)$/, discoveryView, 'home'],
  [/^\/discoveries$/, discoveriesView, 'home'],
  [/^\/import$/, importView, 'settings'],
  [/^\/settings$/, settingsView, 'settings'],
];

const view = document.getElementById('view');
let shuffle = 0;
let currentPath = null;
let currentHash = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

function render({ keepScroll = false } = {}) {
  const { path, query } = parseHash();
  let match = null;
  for (const [re, v, tab] of ROUTES) {
    const m = path.match(re);
    if (m) {
      match = { view: v, tab, params: m.groups || {} };
      break;
    }
  }
  if (!match) match = { view: home, tab: 'home', params: {} };
  // refresh: 同じ画面の描き直し（同期・編集のあと）。別の画面から来たとき・リンクを押したときは false
  const ctx = { state, params: match.params, query, shuffle, refresh: location.hash === currentHash, markDiscoveryRead: readDiscovery };
  currentHash = location.hash;
  const y = window.scrollY;
  view.innerHTML = String(match.view.render(ctx));
  match.view.mount?.(view, ctx);
  mountCommon();
  for (const a of document.querySelectorAll('.tabbar a')) {
    if (a.dataset.tab === match.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // 書き出し・設定の画面では PC の出力先と最後に書き出した時刻を取り直す（10 秒に 1 回まで）
  if (PC_INFO_PATHS.includes(path) && state.settings.ai.mode === 'companion' && Date.now() - (state.pcInfoAt || 0) > 10000) {
    state.pcInfoAt = Date.now();
    refreshPcInfo();
  }
  // 別の画面に移ったとき、押したリンクは描き直しで消えてフォーカスが行方不明になる。
  // キーボード・読み上げで使う人が新しい画面の先頭から読めるよう、本文にフォーカスを移す
  if (path !== currentPath && !view.contains(document.activeElement)) view.focus({ preventScroll: true });
  if (keepScroll || path === currentPath) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  currentPath = path;
  updateStatus();
}

function updateStatus() {
  const el = document.getElementById('status');
  const job = state.job;
  el.classList.toggle('busy', Boolean(job?.running));
  el.textContent = job?.running ? job.message || '分析中…' : '';
}

/** 画面ごとの後処理（ドロップゾーン、ブックマークレット） */
function mountCommon() {
  const drop = view.querySelector('#drop');
  if (drop) {
    const input = drop.querySelector('input');
    input.addEventListener('change', () => importFiles([...input.files]));
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      importFiles([...e.dataTransfer.files]);
    });
  }
  const bm = view.querySelector('#bookmarklet');
  if (bm) buildBookmarklet().then((href) => (bm.href = href)).catch(() => {});
}

async function persistLibrary() {
  await save.library();
}

/** 発見を開いたら既読にする（端末に保存し、PC と同期してほかの端末でも既読にする） */
async function readDiscovery(id) {
  if (!state.loaded || !markDiscoveryRead(state.library, id)) return;
  try {
    await persistLibrary();
    autoSyncAfterChange();
  } catch (e) {
    toast(e.message, 4000);
  }
}

// 思いつきを出している画面（受け箱・メモの一覧・点の検索）
const THOUGHT_PATHS = ['/', '/thoughts', '/search'];

/** 画面の入力欄に書きかけがあるか（描き直すと消えてしまう） */
function hasDraft() {
  return [...view.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')].some((el) => el.value !== el.defaultValue);
}

/**
 * 思いつきを書いたあと、思いつきを出している画面だけ描き直す。
 * 上のバーの「メモ」はどの画面からも開けるので、ほかの画面（紙の本の入力欄など）の書きかけを消さない
 */
function refreshThoughtViews() {
  if (THOUGHT_PATHS.includes(parseHash().path) && !hasDraft()) render({ keepScroll: true });
}

// ---- 取り込み ----

async function importFiles(files) {
  if (!files.length) return;
  const out = view.querySelector('#import-result');
  if (out) out.innerHTML = '<p class="loading">読み込み中…</p>';
  try {
    const inputs = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const parsed = await parseFiles(inputs);
    const { results } = parsed;
    const r = applyImport({ library: state.library, analysis: state.analysis }, parsed);
    const { stats } = r;
    state.library = r.library;
    await persistLibrary();
    if (r.analysisChanged) {
      state.analysis = r.analysis;
      await save.analysis();
    }
    const summary = `新しい点 ${stats.added} 件${stats.updated ? `・更新 ${stats.updated} 件` : ''}${stats.unchanged ? `・既存 ${stats.unchanged} 件` : ''}`;
    toast(`取り込みました: ${summary}`);
    if (out) {
      out.innerHTML = String(html`<div class="card" style="margin-top:12px">
        <p class="notice ${stats.added || stats.backups ? 'ok' : ''}">${summary}${r.analysisChanged ? '（バックアップの新しい分析結果も反映）' : ''}</p>
        <ul class="result-list">${results.map((r) => html`<li>${r.error ? '✗' : '✓'} <b>${r.name}</b><br><span class="small muted">${r.error || `${r.formatLabel} — 本 ${r.books} 冊 / 点 ${r.highlights} 件${r.images ? `（画像 ${r.images} 枚は取り込めません）` : ''}`}</span></li>`)}</ul>
        ${stats.memoTitles?.length ? html`<p class="small muted">既にある本にまとめた読書メモ: ${stats.memoTitles.map((m) => `「${m.from}」→『${m.to}』`).join('、')}</p>` : ''}
        <div class="row" style="margin-top:8px"><a class="btn small" href="#/books">本を見る</a></div>
      </div>`);
    }
    autoSyncAfterChange();
  } catch (e) {
    if (out) out.innerHTML = String(html`<p class="notice err">${e.message}</p>`);
  }
}

// Kindle ノートブックのあるドメインだけ（read.amazon.evil.com などは通さない）
const AMAZON_ORIGIN = /^https:\/\/read\.amazon\.(com|co\.jp|co\.uk|de|fr|it|es|nl|ca|in|com\.au|com\.br|com\.mx)$/;

/** ブックマークレットから postMessage でデータを受け取る */
function listenBookmarklet() {
  if (!location.hash.includes('from=bookmarklet') || !window.opener) return;
  window.addEventListener('message', async (e) => {
    if (!AMAZON_ORIGIN.test(e.origin) || e.data?.type !== 'bh-import' || !isNotebookJson(e.data.data)) return;
    const stats = mergeParsed(state.library, parseNotebookJson(e.data.data));
    await persistLibrary();
    toast(`Kindle から取り込みました: 新しい点 ${stats.added} 件`, 5000);
    location.hash = '#/books';
    autoSyncAfterChange();
  });
  window.opener.postMessage({ type: 'bh-ready' }, '*');
}

// ---- AI 分析 ----

function setJob(patch) {
  state.job = { ...(state.job || {}), ...patch };
  updateStatus();
  const { path } = parseHash();
  if (path === '/knowledge') {
    const panel = view.querySelector('.steps')?.closest('.card');
    // 進捗だけの更新は画面全体を描き直さない
    if (panel && state.job.running) {
      import('./views/knowledge.js').then(({ jobPanel }) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = String(jobPanel(state.job));
        panel.replaceWith(tmp.firstElementChild);
      });
    } else render({ keepScroll: true });
  }
}

let abort = null;

/**
 * おすすめに混ぜる欲しい本（購入済み・読んだの印つき）。タグはこのブラウザにしか無いので、分析のたびにここで作って渡す。
 * 読み込めなければ欲しい本なしでおすすめを選ぶ（分析そのものは止めない）
 */
async function recommendWishlist() {
  try {
    const w = await loadWishlist();
    const store = browserStore();
    return toRecommendWishlist(w.books.map((book) => ({ book, marks: loadMarks(book, store) })));
  } catch {
    return [];
  }
}

/** ブラウザから直接 LLM を呼ぶときの設定。トークンはコンパニオンの /llm 中継を使うときだけ送る */
function directLlmOptions(ai) {
  return { ...ai, token: /\/llm\/?$/.test(ai.baseUrl) ? ai.token : '' };
}

async function runAnalysis(mode = 'analyze') {
  if (state.job?.running) return;
  const ai = state.settings.ai;
  if (ai.mode === 'direct') {
    if (!ai.chatModel) return toast('チャットモデルを設定してください（設定 → AI）');
    abort = new AbortController();
    setJob({ running: true, where: 'browser', stage: 'embed', message: '開始しています', done: 0, total: 0, error: '' });
    try {
      const llm = createLlmClient(directLlmOptions(ai));
      const onProgress = (p) => setJob(p);
      const wishlist = await recommendWishlist();
      if (mode === 'recommend') {
        state.analysis.recommendations = await recommendBooks({ library: state.library, analysis: state.analysis, llm, signal: abort.signal, onProgress, wishlist });
        state.analysis.recommendedAt = new Date().toISOString();
        state.analysis.recommendationNote = recommendationNote(state.analysis.recommendations);
      } else {
        const cache = await loadCache();
        try {
          // 前回の線・面を引き継ぎ、変わったところだけ AI を呼ぶ（full: 最初から作り直す）
          const { analysis } = await analyzeLibrary({ library: state.library, llm, cache, previous: state.analysis, signal: abort.signal, onProgress, options: { wishlist, full: mode === 'full' } });
          state.analysis = analysis;
        } finally {
          await saveCache(cache);
        }
      }
      await save.analysis();
      setJob({ running: false, stage: 'done', message: '完了しました' });
      toast('分析が完了しました');
    } catch (e) {
      setJob({ running: false, stage: 'error', error: e.message, message: '' });
    }
    return;
  }
  // PC のコンパニオンサーバで実行（先に同期して最新の点を渡す）
  setJob({ running: true, where: 'pc', stage: 'embed', message: 'PC と同期しています', done: 0, total: 0, error: '' });
  try {
    await syncWithPc();
    const started = await companion.startAnalyze(mode, await recommendWishlist());
    pcJobStartedAt = started?.startedAt || null;
    await pollPcJob();
  } catch (e) {
    // PC がすでに分析している（自動の分析など）: 押した操作は使わず、その分析が終わるまで追う
    if (e.status === 409) {
      toast(e.message, 6000);
      pcJobStartedAt = null;
      setJob({ running: true, where: 'pc', stage: 'embed', message: e.message, error: '' });
      return pollPcJob();
    }
    setJob({ running: false, stage: 'error', error: e.message, message: '' });
  }
}

let followingPcJob = false;
// 追っている PC の分析を始めた時刻（サーバが再起動して別のジョブ・初期状態に変わったことを見分ける）
let pcJobStartedAt = null;

/** PC の分析を最後まで追う。通信が途切れても再接続を続け、長く途切れたら「状況不明」にして確認ボタンを出す */
async function pollPcJob() {
  if (followingPcJob) return;
  followingPcJob = true;
  try {
    const result = await followJob({
      fetchJob: () => companion.job(),
      onUpdate: (u) => {
        if (u.job?.running && u.job.startedAt && !pcJobStartedAt) pcJobStartedAt = u.job.startedAt;
        if (u.job) setJob({ ...u.job, where: 'pc', running: u.job.running, lost: false, reconnecting: 0 });
        else setJob({ where: 'pc', running: true, lost: false, reconnecting: u.reconnecting, message: `PC との通信が途切れました。再接続しています（${u.reconnecting}/${u.maxFailures - 1}）` });
      },
    });
    if (result.lost) return setJob({ running: false, lost: true, where: 'pc', error: '', message: '' });
    const outcome = pcJobOutcome(result, pcJobStartedAt);
    pcJobStartedAt = null;
    if (outcome === 'error') return;
    if (outcome === 'interrupted') {
      return setJob({ running: false, lost: false, where: 'pc', stage: 'interrupted', message: '', error: 'PC の分析が途中で止まりました（PC のサーバが再起動した可能性があります）。もう一度「分析し直す」か「おすすめを選び直す」を押してください。' });
    }
    let analysis;
    try {
      analysis = await companion.analysis();
    } catch {
      return setJob({ running: false, lost: true, where: 'pc', error: '', message: '' });
    }
    if (analysis) {
      state.analysis = analysis;
      await save.analysis();
    }
    setJob({ running: false, lost: false, stage: 'done', message: '完了しました' });
    toast('分析が完了しました');
    refreshPcInfo();
  } finally {
    followingPcJob = false;
  }
}

/** 「PC の状況を確認」: 途切れていた分析の続きを追う（終わっていれば結果を受け取る） */
function checkPcJob() {
  setJob({ running: true, lost: false, where: 'pc', message: 'PC に分析の状況を問い合わせています' });
  return pollPcJob();
}

async function cancelAnalysis() {
  if (state.job?.where === 'pc') await companion.cancel().catch(() => {});
  abort?.abort();
}

// ---- 同期 ----

async function sync({ quiet = false } = {}) {
  try {
    const { analysisDir } = await syncWithPc();
    state.pcSyncFailed = false;
    if (!quiet) toast(`PC と同期しました${analysisDir ? `（分析: ${analysisDir}）` : ''}`);
    // 書きかけの入力欄があるときは描き直さない（同期した内容は次に画面を開いたときに出る）
    if (!hasDraft()) render({ keepScroll: true });
    refreshPcInfo();
    // PC で分析が走っていれば進捗を追う
    const job = await companion.job().catch(() => null);
    if (job?.running && !state.job?.running) {
      setJob({ ...job, where: 'pc' });
      pollPcJob().catch((e) => setJob({ running: false, error: e.message }));
    }
  } catch (e) {
    // 本が 0 冊のとき「読んだ本」に PC のつなぎ方を出すため、失敗を覚えておく
    const wasFailed = state.pcSyncFailed;
    state.pcSyncFailed = true;
    if (!quiet) toast(e.message, 5000);
    // 空表示に案内を出すために描き直す（本があれば空表示は出ないので、絞り込みの入力中を描き直さない）
    if (!wasFailed && parseHash().path === '/books' && !listBooks(state.library).length) render({ keepScroll: true });
  }
}

// PC の状態（拡張の確認結果など）を表示する画面
const PC_INFO_PATHS = ['/settings', '/import', '/', '/knowledge'];
// 描き直さず、欄だけ差し替える画面（描き直すと取り込み結果の表示・開いた説明・今日の点の「別の点」が消える）
const PC_INFO_BOXES = { '/import': ['#kindle-sync', kindleSyncBlock], '/': ['#kindle-alert', kindleAlertBlock], '/knowledge': ['#auto-status', autoStatusBlock] };

/** PC の状態（拡張の確認結果など）を取り直し、表示している画面に反映する */
async function refreshPcInfo() {
  // PC を設定していないとき（GitHub Pages で開いただけ）は localhost に問い合わせない
  if (state.settings.ai.mode !== 'companion' || !(state.servedByCompanion || state.settings.ai.companionUrl)) return;
  try {
    state.pcInfo = await companion.info();
  } catch {
    return;
  }
  const { path } = parseHash();
  // 入力中の欄があるときは描き直さない（書きかけの設定を消さない）
  const typing = document.activeElement?.matches?.('#view input:not([type="checkbox"]):not([type="radio"]), #view textarea, #view select');
  const partial = PC_INFO_BOXES[path];
  if (partial) {
    const [selector, block] = partial;
    const box = document.querySelector(`#view ${selector}`);
    if (box) box.innerHTML = String(block(state));
  } else if (PC_INFO_PATHS.includes(path) && !typing) render({ keepScroll: true });
}

let syncTimer;
function autoSyncAfterChange() {
  // PC の場所が分かっているときだけ（GitHub Pages や試験用に別の所で開いた画面が、既定の localhost の PC に書き込まないように）
  if (!canAutoSync()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync({ quiet: true }), 1500);
}

// PC が Play ブックスの線を取り込んだら、開いている画面にも届ける。
// 1 分ごと（と画面に戻ったとき）に PC の更新日時だけを聞き、この端末より新しいときだけ同期する
const PULL_INTERVAL_MS = 60_000;
const canAutoSync = () => state.settings.ai.mode === 'companion' && state.settings.autoSync && (state.servedByCompanion || state.settings.ai.companionUrl);
let pulling = false;

async function pullIfNewer() {
  if (pulling || document.visibilityState !== 'visible' || !canAutoSync()) return;
  pulling = true;
  try {
    const info = await companion.info();
    // 同期すると両者の更新日時がそろうので、「違う」だけで判定する（端末の時計のずれに左右されない）
    const stamp = (a) => [a?.createdAt || '', a?.recommendedAt || ''].sort().pop();
    const differs = (info.updatedAt || '') !== (state.library.updatedAt || '') || (info.analysis ? stamp(info.analysis) : '') > stamp(state.analysis);
    if (!differs) return;
    // 入力中の画面を描き直すと書きかけが消えるので、そのときは同期だけして描き直しは次の画面遷移に任せる
    const typing = document.activeElement?.matches?.('#view input:not([type="checkbox"]):not([type="radio"]), #view textarea, #view select, #view [contenteditable]');
    if (typing) await syncWithPc();
    else await sync({ quiet: true });
  } catch {
    // PC が止まっているときは黙って次の機会を待つ
  } finally {
    pulling = false;
  }
}

function googleLabel(g) {
  if (!g) return '未対応（PC の bh を更新してください）';
  if (!g.active) return g.error || '未設定';
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '—');
  return `有効（最終確認 ${time(g.lastCheck)}・最終取り込み ${time(g.lastImport)}）${g.error ? ` ／ ${g.error}` : ''}`;
}

// ---- 紙の本（登録・本の情報の編集） ----

// 表紙は一覧の小さな枠と本の画面に出すだけなので、この大きさに縮めて JPEG にする（同期を重くしない）
const COVER_BOX = { width: 360, height: 540 };

/** 選んだ画像を縮小した data URL にする。選んでいなければ空文字 */
async function coverDataUrl(file) {
  if (!file || !file.size) return '';
  if (!String(file.type).startsWith('image/')) throw new Error('表紙には画像ファイルを選んでください');
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('画像を読み込めませんでした（JPEG・PNG・WebP の画像を選んでください）');
  }
  const scale = Math.min(1, COVER_BOX.width / img.width, COVER_BOX.height / img.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const g = canvas.getContext('2d');
  // JPEG は透明を持てないので、透過 PNG が黒くならないよう白で塗ってから描く
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  for (const quality of [0.85, 0.7, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= COVER_MAX_LENGTH) return url;
  }
  throw new Error('表紙の画像を小さくできませんでした。別の画像を選んでください');
}

/** 技術書の選択肢。自動のときは、書名から今どちらと判断しているかも見せる */
function technicalField(b) {
  const value = typeof b?.technical === 'boolean' ? (b.technical ? 'yes' : 'no') : 'auto';
  const guess = b ? (guessTechnical(b.title) ? '技術書' : '技術書ではない') : '';
  const opt = (v, label) => html`<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`;
  return html`<label class="field"><span>技術書（IT の教科書）か</span>
    <select name="technical">${opt('auto', `書名から自動で判断${guess ? `（今は「${guess}」）` : ''}`)}${opt('yes', '技術書（線を点に数えない）')}${opt('no', '技術書ではない')}</select></label>`;
}

const TECHNICAL_VALUES = { auto: null, yes: true, no: false };

const actions = {
  'register-book'() {
    openSheet(
      html`<h2>紙の本を登録</h2>
        <label class="field"><span>書名</span><input type="text" name="title" autocomplete="off"></label>
        <label class="field"><span>著者（任意）</span><input type="text" name="author" autocomplete="off"></label>
        <label class="field"><span>表紙の画像（任意）</span><input type="file" name="cover" accept="image/*"></label>
        ${technicalField(null)}
        <div class="row spread"><span></span><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">登録</button></span></div>`,
      async (data) => {
        try {
          const b = registerBook(state.library, {
            title: data.get('title'),
            author: data.get('author'),
            cover: await coverDataUrl(data.get('cover')),
            technical: TECHNICAL_VALUES[data.get('technical')] ?? undefined,
          });
          await persistLibrary();
          toast(`『${b.title}』を登録しました。線を引いた文を足せます`);
          location.hash = `#/book/${b.id}`;
          autoSyncAfterChange();
        } catch (e) {
          toast(e.message, 5000);
          return true;
        }
      },
    );
  },
  'edit-book'(el) {
    const b = state.library.books[el.dataset.id];
    openSheet(
      html`<h2>本の情報</h2>
        <p class="quote">${b.title}</p>
        <label class="field"><span>著者</span><input type="text" name="author" value="${b.author || ''}" autocomplete="off"></label>
        <label class="field"><span>表紙の画像を${b.cover ? '差し替える' : '選ぶ'}（任意）</span><input type="file" name="cover" accept="image/*"></label>
        ${b.cover ? html`<label class="check"><input type="checkbox" name="removeCover" value="1"> アップロードした表紙を外す</label>` : ''}
        ${technicalField(b)}
        <div class="row spread"><span></span><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`,
      async (data) => {
        try {
          // 変えた欄だけを送る（変えていない表紙・技術書の編集時刻を進めて、別の端末の編集を負かさない）
          const patch = { author: data.get('author') };
          const technical = TECHNICAL_VALUES[data.get('technical')] ?? null;
          if (technical !== (typeof b.technical === 'boolean' ? b.technical : null)) patch.technical = technical;
          const cover = await coverDataUrl(data.get('cover'));
          if (cover) patch.cover = cover;
          else if (data.get('removeCover')) patch.cover = '';
          updateBook(state.library, b.id, patch);
          await persistLibrary();
          toast('保存しました');
          render({ keepScroll: true });
          autoSyncAfterChange();
        } catch (e) {
          toast(e.message, 5000);
          return true;
        }
      },
    );
  },
  async fav(el) {
    const h = updateHighlight(state.library, el.dataset.id, { favorite: !state.library.highlights[el.dataset.id].favorite });
    await persistLibrary();
    el.classList.toggle('on', h.favorite);
    el.textContent = h.favorite ? '★' : '☆';
    el.setAttribute('aria-pressed', String(h.favorite));
    autoSyncAfterChange();
  },
  edit(el) {
    const h = state.library.highlights[el.dataset.id];
    openSheet(
      html`<h2>メモ・タグ</h2>
        <p class="quote">${h.text}</p>
        <label class="field"><span>自分のメモ</span><textarea name="userNote">${h.userNote || ''}</textarea></label>
        <label class="field"><span>タグ（空白かカンマ区切り）</span><input type="text" name="tags" value="${(h.tags || []).join(' ')}" placeholder="例: 習慣 仕事"></label>
        <p class="help">自分のメモ・タグ・★は、AI が点をつなぐときに「読者自身の言葉」として使います（次の分析から）。</p>
        <div class="row spread"><button class="btn danger" value="delete">この点を削除</button><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`,
      async (data, action) => {
        if (action === 'delete') {
          updateHighlight(state.library, h.id, { deleted: true });
          toast('削除しました');
        } else {
          updateHighlight(state.library, h.id, { userNote: String(data.get('userNote') || '').trim(), tags: String(data.get('tags') || '').split(/[\s,、]+/) });
        }
        await persistLibrary();
        render({ keepScroll: true });
        autoSyncAfterChange();
      },
    );
  },
  async copy(el) {
    const h = pointById(state.library, el.dataset.id);
    if (!h) return;
    // http の LAN アドレスなど、安全でない画面ではクリップボードを使えない
    if (!navigator.clipboard) return toast('この画面ではコピーできません（https か localhost で開いてください）', 4000);
    const b = state.library.books[h.bookId];
    await navigator.clipboard.writeText(isThought(h) || !b ? h.text : `${h.text}\n— ${b.title}${b.author ? `（${b.author}）` : ''}`);
    toast('コピーしました');
  },
  // ---- 思いつき（フリートノート） ----
  'new-thought'() {
    if (!state.loaded) return toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
    // ID はシートを開いたときに 1 回だけ作る（保存に失敗して押し直しても、同じメモが 2 件にならない）
    const id = randomId('t');
    openSheet(newThoughtSheet(), async (data) => {
      // 失敗したら例外のままシートに出す（書いた文はシートに残る）
      addThought(state.library, { text: data.get('text') }, undefined, id);
      // 端末に先に保存する（PC とつながっていなくても消えない。つながったときに同期する）
      await persistLibrary();
      toast('受け箱に入れました');
      refreshThoughtViews();
      autoSyncAfterChange();
    });
  },
  'edit-thought'(el) {
    const t = thoughtsOf(state.library)[el.dataset.id];
    if (!t || t.deleted) return;
    openSheet(editThoughtSheet(t), async (data, action) => {
      if (action === 'delete') deleteThought(state.library, t.id);
      // 本文が変わっていなければ updateThought は何もしない（別の端末の新しい編集を負かさない）
      else updateThought(state.library, t.id, { text: data.get('text') });
      await persistLibrary();
      toast(action === 'delete' ? '削除しました' : '保存しました');
      render({ keepScroll: true });
      autoSyncAfterChange();
    });
  },
  async 'thought-status'(el) {
    const t = updateThought(state.library, el.dataset.id, { status: el.dataset.status });
    await persistLibrary();
    toast(`「${THOUGHT_STATUS[t.status]}」にしました`);
    render({ keepScroll: true });
    autoSyncAfterChange();
  },
  // ---- 永久ノート（書く・直す・線やメモから作る・点を根拠にする。中身は note-actions.js） ----
  ...noteActions({ state, openSheet, toast, persist: persistLibrary, sync: autoSyncAfterChange, render, go: (hash) => (location.hash = hash), confirm: (message) => confirm(message) }),
  async 'delete-book'(el) {
    const b = state.library.books[el.dataset.id];
    if (!confirm(`『${b.title}』とその点をすべて削除しますか？`)) return;
    deleteBook(state.library, b.id);
    await persistLibrary();
    location.hash = '#/books';
    toast('削除しました');
    autoSyncAfterChange();
  },
  async 'load-sample'() {
    const stats = mergeParsed(state.library, SAMPLE_BOOKS);
    await persistLibrary();
    toast(`サンプルを入れました（点 ${stats.added} 件）`);
    location.hash = '#/';
    render();
  },
  shuffle() {
    // 押すたびに新しい種で選び直す（開き直すたびに同じ並びが出ないよう、回数ではなく乱数にする）
    shuffle = Math.random().toString(36).slice(2);
    render({ keepScroll: true });
  },
  'run-analysis': () => runAnalysis('analyze'),
  'run-analysis-full': () => runAnalysis('full'),
  'rerun-recommend': () => runAnalysis('recommend'),
  // 立体・線の問いに答える（答えは思いつきとして受け箱に入り、次の分析で点になる）
  answer(el) {
    if (!state.loaded) return toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
    const question = el.dataset.question;
    const answerTo = { kind: el.dataset.kind, question, ...(el.dataset.ref ? { id: el.dataset.ref } : {}) };
    const id = randomId('t');
    openSheet(newThoughtSheet({ question }), async (data) => {
      addThought(state.library, { text: data.get('text'), answerTo }, undefined, id);
      await persistLibrary();
      toast('答えを受け箱に入れました。次の分析から点になります');
      render({ keepScroll: true });
      autoSyncAfterChange();
    });
  },
  'cancel-analysis': cancelAnalysis,
  'check-pc-job': () => checkPcJob(),
  async 'rec-feedback'(el) {
    const r = state.analysis?.recommendations?.[Number(el.dataset.i)];
    if (!r) return;
    const f = setFeedback(state.library, { title: r.title, author: r.author }, el.dataset.status);
    await persistLibrary();
    toast(f.status ? `「${r.title}」を「${FEEDBACK_LABELS[f.status]}」にしました。次のおすすめに反映します` : '反応を外しました');
    render({ keepScroll: true });
    autoSyncAfterChange();
  },
  // 遠いつながりへの反応（面白い: 残り続ける / ちがう: もう出さない）。「ちがう」とした組は画面に無いので、反応の記録からも探す
  async 'far-react'(el) {
    if (!state.loaded) return toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
    const f = farConnectionById(state.analysis, state.library, el.dataset.id);
    if (!f || !Object.hasOwn(FAR_REACTIONS, el.dataset.status)) return;
    const r = reactFar(state.library, f, el.dataset.status);
    await persistLibrary();
    toast(r.status === 'wrong' ? '「ちがう」にしました。この組はもう出しません（すべての遠いつながりの画面で取り消せます）' : r.status === 'interesting' ? '「面白い」にしました。分析し直しても残ります' : '反応を外しました');
    render({ keepScroll: true });
    autoSyncAfterChange();
  },
  'map-zoom'(el) {
    const svg = document.getElementById('knowledge-map');
    const w = parseFloat(svg.getAttribute('width')) || 100;
    const next = Math.max(100, Math.min(400, w * (el.dataset.dir === '1' ? 1.5 : 1 / 1.5)));
    svg.setAttribute('width', `${next}%`);
  },
  sync: () => sync(),
  async 'toggle-autosync'(el) {
    state.settings.autoSync = el.checked;
    await save.settings();
  },
  async backup() {
    const data = JSON.stringify(makeBackup(state.library, state.analysis));
    download(`bookshelf-backup-${new Date().toISOString().slice(0, 10)}.json`, data, 'application/json');
  },
  async 'clear-all'() {
    if (!confirm('この端末のハイライト・分析結果・設定をすべて消します。よろしいですか？')) return;
    await kv.clear();
    state.library = emptyLibrary();
    state.analysis = null;
    location.hash = '#/';
    location.reload();
  },
  async 'copy-bookmarklet'() {
    await navigator.clipboard.writeText(await buildBookmarklet());
    toast('ブックマークレットをコピーしました。ブックマークの URL に貼り付けてください');
  },
};

const forms = {
  search(form) {
    form.querySelector('input')?.blur();
  },
  async 'add-highlight'(form) {
    const d = new FormData(form);
    const chapter = String(d.get('chapter') || '');
    const r = addHighlight(state.library, form.dataset.id, { text: d.get('text'), page: d.get('page'), chapter });
    await persistLibrary();
    toast(r.added ? '追加しました' : '同じ文が既にあります');
    render({ keepScroll: true });
    // 続けて同じ章の文を入れやすいよう、章は残して文の欄に戻る
    const next = view.querySelector('form[data-form="add-highlight"]');
    if (next) {
      next.elements.chapter.value = chapter;
      next.elements.text.focus();
    }
    autoSyncAfterChange();
  },
  'book-filter'(form) {
    const q = new FormData(form).get('q');
    const { query } = parseHash();
    if (q) query.set('q', q);
    else query.delete('q');
    location.hash = `#/books?${query}`;
  },
  'thought-filter'(form) {
    const q = new FormData(form).get('q');
    const { query } = parseHash();
    if (q) query.set('q', q);
    else query.delete('q');
    location.hash = `#/thoughts?${query}`;
  },
  'note-filter'(form) {
    const q = new FormData(form).get('q');
    const { query } = parseHash();
    if (q) query.set('q', q);
    else query.delete('q');
    location.hash = `#/notes?${query}`;
  },
  async 'ai-settings'(form, submitter) {
    const d = new FormData(form);
    const ai = state.settings.ai;
    Object.assign(ai, {
      mode: d.get('mode') === 'direct' ? 'direct' : 'companion',
      companionUrl: String(d.get('companionUrl') || '').trim(),
      token: String(d.get('token') || ''),
      baseUrl: String(d.get('baseUrl') || '').trim() || 'http://localhost:11434',
      chatModel: String(d.get('chatModel') || '').trim(),
      embedModel: String(d.get('embedModel') || '').trim(),
    });
    await save.settings();
    const out = view.querySelector('#ai-test');
    if (submitter?.value !== 'test') {
      toast('保存しました');
      return;
    }
    out.innerHTML = '<p class="loading">確認中…</p>';
    try {
      if (ai.mode === 'direct') {
        const models = await createLlmClient({ ...directLlmOptions(ai), timeoutMs: 15000 }).listModels();
        view.querySelector('#model-list').innerHTML = models.map((m) => `<option value="${m.replace(/"/g, '&quot;')}">`).join('');
        out.innerHTML = String(html`<p class="notice ok">接続できました。モデル: ${models.join('、') || '（なし）'}</p>`);
      } else {
        const info = await companion.info();
        out.innerHTML = String(html`<p class="notice ${info.llm.configured ? 'ok' : ''}">PC に接続できました。点 ${info.stats.points ?? info.stats.highlights} 件・チャットモデル: ${info.llm.chatModel || '未設定（PC で bh config model …）'}・埋め込み: ${info.llm.embedModel || '文字 n-gram'}・Play ブックスの自動取り込み: ${googleLabel(info.google)}</p>`);
      }
    } catch (e) {
      out.innerHTML = String(html`<p class="notice err">${e.message}</p>`);
    }
  },
};

// 表紙が読めない（通信できない・表紙の無い本で 1px の画像が返る）ときは画像を外し、書名の 1 文字目を見せる
const dropCover = (img) => img.matches?.('img[data-cover]') && img.remove();
document.addEventListener('error', (e) => dropCover(e.target), true);
document.addEventListener('load', (e) => e.target.naturalWidth <= 1 && dropCover(e.target), true);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn(el)).catch((err) => toast(err.message, 5000));
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('input[data-action]');
  if (el) actions[el.dataset.action]?.(el);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  Promise.resolve(forms[form.dataset.form]?.(form, e.submitter)).catch((err) => toast(err.message, 5000));
});

window.addEventListener('hashchange', () => render());

document.addEventListener('visibilitychange', () => {
  const job = state.job;
  // 途切れて「状況不明」になった PC の分析だけ確かめ直す（始める途中の分析を古い結果で上書きしない）
  if (document.visibilityState === 'visible' && job?.where === 'pc' && job.lost && !followingPcJob) checkPcJob();
});

async function start() {
  await loadState();
  state.servedByCompanion = await detectServedByCompanion();
  render();
  listenBookmarklet();
  requestPersistence();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (canAutoSync()) sync({ quiet: true });
  setInterval(pullIfNewer, PULL_INTERVAL_MS);
  document.addEventListener('visibilitychange', pullIfNewer);
}

start().catch((e) => {
  view.innerHTML = String(html`<p class="notice err">起動できませんでした: ${e.message}</p>`);
});

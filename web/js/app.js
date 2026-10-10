// 本 — Web アプリ本体（ルーティング・操作）
import { html } from './html.js';
import { kv, requestPersistence } from './db.js';
import { loadCache, loadState, save, saveCache, state } from './state.js';
import { buildBookmarklet, companion, detectCompanion, download, syncWithPc } from './services.js';
import { openSheet, serveVersionBlock, toast } from './ui.js';
import { swVersion } from '../core/serve-version.js';
import { LAYER_PATHS, PC_INFO_BOXES, PC_INFO_PATHS, THOUGHT_PATHS, matchRoute, parseHash as parseRouteHash } from './routes.js';
import { appActions } from './app-actions.js';
import { noteActions } from './note-actions.js';
import { linkActions } from './link-actions.js';
import { askResultBlock, semanticAvailability } from './views/ask.js';
import { askActions } from './ask-actions.js';
import { outlineStatusBlock } from './views/outlines.js';
import { outlineActions } from './outline-actions.js';
import { importOutcome, importResultBlock } from './views/settings.js';
import { addHighlight, emptyLibrary, listBooks, mergeParsed, parseShuffleRecord, shuffleRecord, shuffleSeedFor } from '../core/model.js';
import { COVER_MAX_LENGTH } from '../core/covers.js';
import { parseFiles } from '../core/parsers/index.js';
import { applyImport, makeBackup } from '../core/importing.js';
import { isNotebookJson, parseNotebookJson } from '../core/parsers/kindle-notebook.js';
import { createLlmClient } from '../core/analysis/llm.js';
import { analyzeLibrary, recommendBooks, recommendationNote } from '../core/analysis/pipeline.js';
import { followJob, pcJobOutcome } from '../core/jobs.js';
import { browserStore, loadMarks, toRecommendWishlist } from '../core/wishlist.js';
import { loadWishlist } from './wishlist-data.js';

const view = document.getElementById('view');
// 今日の点の「別の点」で選び直した種。この端末に残し、その日のうちは開き直しても同じ組を出す（NIH-89）
const SHUFFLE_KEY = 'today-shuffle';
// 起動時に呼ぶので、サイトデータをブロックしたブラウザ（localStorage を見ただけで例外）でも起動を止めない
const shuffleStore = (() => {
  try {
    return browserStore();
  } catch {
    return { get: () => null, set() {} };
  }
})();
let shuffle = parseShuffleRecord(shuffleStore.get(SHUFFLE_KEY));
let currentPath = null;
let currentHash = null;

const parseHash = () => parseRouteHash(location.hash);

function render({ keepScroll = false } = {}) {
  const { path, query } = parseHash();
  const match = matchRoute(path);
  // refresh: 同じ画面の描き直し（同期・編集のあと）。別の画面から来たとき・リンクを押したときは false
  const ctx = { state, params: match.params, query, shuffle: shuffleSeedFor(shuffle, new Date()), refresh: location.hash === currentHash, markDiscoveryRead: appOps.readDiscovery };
  currentHash = location.hash;
  // 取り込みの結果は、画面を離れたら（別の画面から来たら）忘れる
  if (!ctx.refresh) state.lastImport = null;
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
  state.lastImport = null;
  // 読み込み中に自動同期で描き直されると最初の欄は画面から外れるので、書くたびに取り直す
  const showResult = (content) => {
    const out = view.querySelector('#import-result');
    if (out) out.innerHTML = content;
  };
  showResult('<p class="loading">読み込み中…</p>');
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
    // 自動同期で画面を描き直しても結果欄を出し直せるよう、画面を離れるか次に取り込むまで覚えておく
    state.lastImport = { results, stats, analysisChanged: r.analysisChanged };
    const outcome = importOutcome(results, stats);
    toast(outcome.message, outcome.failed ? 5000 : undefined);
    showResult(String(importResultBlock(state.lastImport)));
    autoSyncAfterChange();
  } catch (e) {
    state.lastImport = { error: e.message };
    showResult(String(importResultBlock(state.lastImport)));
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
  } else if (LAYER_PATHS.includes(path) && !state.job.running) render({ keepScroll: true });
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
    for (const [selector, block] of partial) {
      const box = document.querySelector(`#view ${selector}`);
      if (!box) continue;
      // 開いて読んでいる説明（取り込めない本の理由など）を、差し替えで閉じない
      const open = box.querySelector('details')?.open;
      box.innerHTML = String(block(state));
      if (open) box.querySelector('details')?.setAttribute('open', '');
    }
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
  if (pulling || document.visibilityState !== 'visible') return;
  pulling = true;
  // 入力中の画面を描き直すと書きかけ・キーボードが消えるので、そのときは同期だけして描き直しは次の画面遷移に任せる
  const typing = () => document.activeElement?.matches?.('#view input:not([type="checkbox"]):not([type="radio"]), #view textarea, #view select, #view [contenteditable]');
  try {
    // 起動したときに PC に届かなかった画面（Tailscale がまだつながっていなかった等）は、ここで PC を探し直す。
    // 見つけたらその場で同期する（その間に端末へ書いたメモを PC へ送る）
    if (await detectCompanion()) {
      if (canAutoSync()) {
        if (typing()) await syncWithPc();
        else await sync({ quiet: true });
      } else if (!typing() && !hasDraft()) render({ keepScroll: true });
      return;
    }
    if (!canAutoSync()) return;
    const info = await companion.info();
    // 同期すると両者の更新日時がそろうので、「違う」だけで判定する（端末の時計のずれに左右されない）
    const stamp = (a) => [a?.createdAt || '', a?.recommendedAt || ''].sort().pop();
    const differs = (info.updatedAt || '') !== (state.library.updatedAt || '') || (info.analysis ? stamp(info.analysis) : '') > stamp(state.analysis);
    if (!differs) return;
    if (typing()) await syncWithPc();
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
  const problems = g.problemCount ?? g.problems?.length ?? 0;
  return `有効（最終確認 ${time(g.lastCheck)}・最終取り込み ${time(g.lastImport)}）${problems ? ` ／ 取り込めない本 ${problems} 冊（取り込みの画面に理由）` : ''}${g.error ? ` ／ ${g.error}` : ''}`;
}

const OWN_VERSION_TIMEOUT_MS = 3000;
/** この画面の sw.js の版（PC の bh serve の版と比べる。読めなければ空） */
async function ownSwVersion() {
  try {
    // 版は補助の情報なので、待たされて接続の確認の結果まで出なくならないよう区切る
    const res = await fetch('sw.js', { cache: 'no-store', signal: AbortSignal.timeout(OWN_VERSION_TIMEOUT_MS) });
    return res.ok ? swVersion(await res.text()) : '';
  } catch {
    return '';
  }
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

/**
 * 問いかけた結果を出す。問いかける画面の答えの欄とボタンだけを差し替える
 * （答えは数十秒あとに届くので、ほかの画面や、書き直している質問の欄を描き直さない）
 */
function renderAskResult() {
  if (parseHash().path !== '/ask') return;
  const box = document.querySelector('#view #ask-result');
  if (box) box.innerHTML = String(askResultBlock(state));
  const btn = document.querySelector('#view #ask-submit');
  if (btn) btn.disabled = semanticAvailability(state) !== 'ok' || state.ask?.status === 'pending';
}

// 問いかける（質問を PC に送る・答えをメモにする。中身は ask-actions.js）
const askOps = askActions({ state, ask: (question) => companion.ask(question), persist: persistLibrary, sync: autoSyncAfterChange, render: renderAskResult, toast });

/** 骨組みを作っている間・失敗の表示。作る画面の欄とボタンだけを差し替える（選んだ材料のチェックを描き直さない） */
function renderOutlineStatus() {
  if (parseHash().path !== '/outline/new') return;
  const box = document.querySelector('#view #outline-status');
  if (box) box.innerHTML = String(outlineStatusBlock(state));
  const btn = document.querySelector('#view #outline-submit');
  if (btn) btn.disabled = semanticAvailability(state) !== 'ok' || state.outlineDraft?.status === 'pending';
}

// 文章の骨組み（作る・直す・Markdown をコピー・消す。中身は outline-actions.js）
const { create: createOutline, ...outlineButtons } = outlineActions({
  state,
  generate: (picks) => companion.outline(picks),
  openSheet,
  toast,
  persist: persistLibrary,
  sync: autoSyncAfterChange,
  render: renderOutlineStatus,
  renderPage: render,
  go: (hash) => (location.hash = hash),
  here: () => parseHash().path,
  confirm: (message) => confirm(message),
  copy: async (text) => {
    if (!navigator.clipboard) throw new Error('この画面ではコピーできません（https か localhost で開いてください）');
    await navigator.clipboard.writeText(text);
  },
});

// 本・点・思いつき・線(グループ)・反応のデータを変える操作（中身は app-actions.js）
const appOps = appActions({
  state,
  openSheet,
  toast,
  persist: persistLibrary,
  saveAnalysis: () => save.analysis(),
  sync: autoSyncAfterChange,
  render,
  refreshThoughts: refreshThoughtViews,
  go: (hash) => (location.hash = hash),
  confirm: (message) => confirm(message),
  coverDataUrl,
  clipboard: () => navigator.clipboard,
  restoreHistory: (id) => companion.restoreHistory(id),
  pinHistory: (id, pinned) => companion.pinHistory(id, pinned),
});

const actions = {
  'ask-save': () => askOps.save(),
  ...outlineButtons,
  ...appOps.actions,
  // ---- 永久ノート（書く・直す・線やメモから作る・点を根拠にする。中身は note-actions.js） ----
  ...noteActions({ state, openSheet, toast, persist: persistLibrary, sync: autoSyncAfterChange, render, go: (hash) => (location.hash = hash), confirm: (message) => confirm(message) }),
  // ---- リンク（張る・理由を書く・外す。中身は link-actions.js） ----
  ...linkActions({ state, openSheet, toast, persist: persistLibrary, sync: autoSyncAfterChange, render, go: (hash) => (location.hash = hash), confirm: (message) => confirm(message) }),
  shuffle() {
    // 押すたびに新しい種で選び直す（開き直すたびに同じ並びが出ないよう、回数ではなく乱数にする）
    shuffle = shuffleRecord(new Date(), Math.random().toString(36).slice(2));
    shuffleStore.set(SHUFFLE_KEY, JSON.stringify(shuffle));
    render({ keepScroll: true });
  },
  'run-analysis': () => runAnalysis('analyze'),
  'run-analysis-full': () => runAnalysis('full'),
  'rerun-recommend': () => runAnalysis('recommend'),
  'cancel-analysis': cancelAnalysis,
  'check-pc-job': () => checkPcJob(),
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
  // 取り込みで読めなかったファイルの行から、同じ画面の取り出し方の説明を開いて見せる
  'open-import-help'(el) {
    const target = document.getElementById(el.dataset.target);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
};

const forms = {
  search(form) {
    form.querySelector('input')?.blur();
  },
  ask(form) {
    // 検索の画面から引き継いだ言葉（?q=）を URL から外す（描き直しても、送った質問の欄が引き継いだ言葉に戻らないように）
    if (location.hash !== '#/ask') history.replaceState(null, '', '#/ask');
    return askOps.submit(new FormData(form).get('question'));
  },
  'outline-new'(form) {
    const d = new FormData(form);
    return createOutline(['plane', 'line', 'note'].flatMap((kind) => d.getAll(kind).map((id) => ({ kind, id: String(id) }))));
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
  'link-search'(form) {
    const q = String(new FormData(form).get('q') || '');
    const params = new URLSearchParams(q ? { q } : {});
    location.hash = `#/link/${encodeURIComponent(form.dataset.from)}${params.toString() ? `?${params}` : ''}`;
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
        const [info, appVersion] = await Promise.all([companion.info(), ownSwVersion()]);
        out.innerHTML = String(html`<p class="notice ${info.llm.configured ? 'ok' : ''}">PC に接続できました。点 ${info.stats.points ?? info.stats.highlights} 件・チャットモデル: ${info.llm.chatModel || '未設定（PC で bh config model …）'}・埋め込み: ${info.llm.embedModel || '文字 n-gram'}・Play ブックスの自動取り込み: ${googleLabel(info.google)}</p>
          ${serveVersionBlock(info.server, appVersion)}`);
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

// 上のバーの高さ（状況の表示で変わることがある）を、その下に貼りつく検索欄の位置に使う
const topbar = document.querySelector('.topbar');
if (topbar && 'ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
window.addEventListener('hashchange', () => render());

document.addEventListener('visibilitychange', () => {
  const job = state.job;
  // 途切れて「状況不明」になった PC の分析だけ確かめ直す（始める途中の分析を古い結果で上書きしない）
  if (document.visibilityState === 'visible' && job?.where === 'pc' && job.lost && !followingPcJob) checkPcJob();
});

async function start() {
  await loadState();
  await detectCompanion();
  render();
  listenBookmarklet();
  requestPersistence();
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (canAutoSync()) sync({ quiet: true });
  setInterval(pullIfNewer, PULL_INTERVAL_MS);
  document.addEventListener('visibilitychange', pullIfNewer);
  window.addEventListener('online', pullIfNewer);
}

start().catch((e) => {
  view.innerHTML = String(html`<p class="notice err">起動できませんでした: ${e.message}</p>`);
});

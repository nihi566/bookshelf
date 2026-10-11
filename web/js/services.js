// 外部とのやりとり: PC のコンパニオンサーバ、ブックマークレット
import { state, save } from './state.js';
import { mergeLibraries } from '../core/model.js';
import { analysisStamp } from '../core/importing.js';

// ---- コンパニオンサーバ ----

// 意味で探す・問いかける・骨組みを作るを待つ長さ（問いかけ・骨組みは PC の AI が文を書くので長め。切れると PC 側の処理も止まる）
const SEARCH_TIMEOUT_MS = 30 * 1000;
const ASK_TIMEOUT_MS = 3 * 60 * 1000;
// PC が配信している画面かを確かめるのを待つ長さ（つながりかけの Tailscale で返事が来ないまま、探し直しが止まらないように）
const PROBE_TIMEOUT_MS = 5 * 1000;

export function companionBase() {
  const url = state.settings.ai.companionUrl.trim().replace(/\/+$/, '');
  if (url) return url;
  return state.servedByCompanion ? location.origin : 'http://localhost:8787';
}

/** timeoutMs: その時間のうちに返事が来なければあきらめる（PC の AI が止まっていても待ち続けない。0 なら待ち続ける） */
async function call(path, { method = 'GET', body, base = companionBase(), timeoutMs = 0 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.ai.token) headers['X-BH-Token'] = state.settings.ai.token;
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  let text;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl?.signal });
    text = await res.text();
  } catch (e) {
    if (ctrl?.signal.aborted) throw new Error(`PC から ${Math.round(timeoutMs / 1000)} 秒たっても返事がありませんでした。PC の AI が忙しいか、止まっているかもしれません。少し待ってから、もう一度押してください。`);
    throw new Error(`PC（${base}）に接続できません。コンパニオンサーバ（bh serve）が起動しているか確認してください。`);
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    // 断った理由の種類（no-embed-model など。画面が出す説明を選ぶ）
    if (typeof data?.code === 'string') err.code = data.code;
    throw err;
  }
  return data;
}

export const companion = {
  info: (base) => call('/api/info', { base }),
  library: () => call('/api/library'),
  merge: (library) => call('/api/library/merge', { method: 'POST', body: library }),
  analysis: () => call('/api/analysis').catch((e) => (e.status === 404 ? null : Promise.reject(e))),
  putAnalysis: (analysis) => call('/api/analysis', { method: 'PUT', body: analysis }),
  startAnalyze: (mode = 'analyze', wishlist = []) => call('/api/analyze', { method: 'POST', body: { mode, wishlist } }),
  job: () => call('/api/analyze'),
  cancel: () => call('/api/analyze', { method: 'DELETE' }),
  // 意味で探す・問いかける（PC の埋め込みモデルとローカル LLM。本文は送り返さず、点・ノートの ID が返る）
  search: (q) => call('/api/search', { method: 'POST', body: { q }, timeoutMs: SEARCH_TIMEOUT_MS }),
  ask: (question) => call('/api/ask', { method: 'POST', body: { question }, timeoutMs: ASK_TIMEOUT_MS }),
  // 文章の骨組みを作る（材料の面・線・永久ノートの ID を送り、保存前の下書きが返る）
  outline: (sources) => call('/api/outline', { method: 'POST', body: { sources }, timeoutMs: ASK_TIMEOUT_MS }),
  // 分析の履歴は PC にだけ置く（一覧は要約だけ。開いたときに 1 回分を取りに行く）。pinMax: 「残す」の印の上限（古い PC は返さないので null）
  history: () => call('/api/history').then((r) => ({ items: r?.items || [], pinMax: Number.isInteger(r?.pinMax) ? r.pinMax : null })),
  historyEntry: (id) => call(`/api/history/${encodeURIComponent(id)}`),
  // 過去の分析に戻す（PC が今の時刻の分析として保存し、戻した分析が返る）
  restoreHistory: (id) => call(`/api/history/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  // 履歴の回に「この回を残す」の印を付け外しする（印の付いた回は直近 12 回を過ぎても消えない。付け外した回の要約が返る）
  pinHistory: (id, pinned) => call(`/api/history/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned } }),
};

/**
 * 同一オリジンでコンパニオンサーバが動いているか（http://localhost:8787 や Tailscale の URL で開いた場合など）。
 * 通信できない・返事が無い・5xx（PC の bh serve が再起動中で Tailscale が 502 を返す等）なら null（まだ分からない。
 * Tailscale がつながっていない間も、画面はサービスワーカーのキャッシュから開ける）
 */
export async function probeCompanionOrigin(st = state, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('api/info', { headers: st.settings.ai.token ? { 'X-BH-Token': st.settings.ai.token } : {}, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) return true;
  if (res.status >= 500) return null;
  if (!res.ok) return false;
  try {
    return (await res.json())?.app === 'book-highlights';
  } catch {
    return false;
  }
}

/**
 * PC が配信している画面かを確かめ、st.servedByCompanion に入れる。
 * 届かなかったときは確かめ直せるように残す（起動したときに 1 回だけ確かめると、そのとき PC に届かなかった画面は
 * 開き直すまで同期しなくなり、スマホで書いたメモが PC に届かない。NIH-57）。
 * 届いて PC ではないと分かった（GitHub Pages など）とき・PC の URL を設定しているときは問い合わせない。
 * @returns {Promise<boolean>} 今回はじめて PC だと分かったか
 */
export async function detectCompanion(st = state, probe = probeCompanionOrigin) {
  if (st.settings.ai.mode !== 'companion' || st.settings.ai.companionUrl.trim()) return false;
  if (st.servedByCompanion || st.companionOriginChecked) return false;
  const found = await probe(st);
  if (found === null) return false;
  st.companionOriginChecked = true;
  st.servedByCompanion = found;
  return found;
}

/** PC と同期: ライブラリは双方向に統合、分析結果は新しい方を採用 */
export async function syncWithPc() {
  // 最後の同期は、PC に送る前の時刻で残す（同期の間に書いたメモを、届いていないのに同期済みと見せない。NIH-6）
  const startedAt = new Date().toISOString();
  const merged = await companion.merge(state.library);
  state.library = mergeLibraries(state.library, merged);
  await save.library();
  const remote = await companion.analysis();
  const local = state.analysis;
  // 分析し直した時刻とおすすめを選び直した時刻の新しい方で比べる
  const stamp = analysisStamp;
  let analysisDir = '';
  if (remote && stamp(remote) > stamp(local)) {
    state.analysis = remote;
    await save.analysis();
    analysisDir = 'pc→この端末';
  } else if (local && stamp(local) > stamp(remote)) {
    await companion.putAnalysis(local);
    analysisDir = 'この端末→pc';
  }
  state.lastSync = startedAt;
  await save.lastSync();
  return { analysisDir };
}

// ---- ブックマークレット ----

export async function buildBookmarklet() {
  const src = await (await fetch('bookmarklet/kindle-notebook.js')).text();
  const appUrl = location.origin + location.pathname;
  const code = src
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
    .replaceAll('__APP_URL__', appUrl);
  return 'javascript:' + encodeURIComponent(code);
}

export function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

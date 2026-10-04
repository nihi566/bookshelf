// 外部とのやりとり: PC のコンパニオンサーバ、ブックマークレット
import { state, save } from './state.js';
import { mergeLibraries } from '../core/model.js';
import { analysisStamp } from '../core/importing.js';

// ---- コンパニオンサーバ ----

export function companionBase() {
  const url = state.settings.ai.companionUrl.trim().replace(/\/+$/, '');
  if (url) return url;
  return state.servedByCompanion ? location.origin : 'http://localhost:8787';
}

async function call(path, { method = 'GET', body, base = companionBase() } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.ai.token) headers['X-BH-Token'] = state.settings.ai.token;
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error(`PC（${base}）に接続できません。コンパニオンサーバ（bh serve）が起動しているか確認してください。`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
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
  // 分析の履歴は PC にだけ置く（一覧は要約だけ。開いたときに 1 回分を取りに行く）
  history: () => call('/api/history').then((r) => r?.items || []),
  historyEntry: (id) => call(`/api/history/${encodeURIComponent(id)}`),
};

/** 同一オリジンでコンパニオンサーバが動いているか（http://localhost:8787 で開いた場合など） */
export async function detectServedByCompanion() {
  try {
    const res = await fetch('api/info', { headers: state.settings.ai.token ? { 'X-BH-Token': state.settings.ai.token } : {} });
    if (!res.ok && res.status !== 401) return false;
    if (res.status === 401) return true;
    return (await res.json())?.app === 'book-highlights';
  } catch {
    return false;
  }
}

/** PC と同期: ライブラリは双方向に統合、分析結果は新しい方を採用 */
export async function syncWithPc() {
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
  state.lastSync = new Date().toISOString();
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

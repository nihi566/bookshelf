// PC の bh serve が古いコードのまま動いていないかの判定（設定 → 接続を確認 に出す）。
// 版は sw.js の CACHE（'bh-vNN'）。bh serve は起動時の版（version）と、いまディスクにある版（diskVersion）を /api/info で返す。

export const STALE_SERVE = 'PC の bh serve が古いコードで動いています（PC で bh update）';
const APP_OLDER = 'この画面の方が古い版です（ページを読み込み直してください）';

/** sw.js の版（const CACHE = 'bh-vNN'） */
export function swVersion(text) {
  return String(text).match(/const CACHE = '([^']+)'/)?.[1] || '';
}

const versionNumber = (v) => Number(String(v).match(/(\d+)$/)?.[1] ?? NaN);

/**
 * @param {{ appVersion?: string, server?: { startedAt?: string, version?: string, diskVersion?: string } | null }} input
 *   appVersion: この画面の sw.js の版（読めなければ空）。server: /api/info の server
 * @returns {{ startedAt: string, version: string, warning: string }} warning は出す警告（無ければ空文字）
 */
export function serveVersionCheck({ appVersion = '', server } = {}) {
  const startedAt = server?.startedAt || '';
  const version = server?.version || '';
  const out = (warning) => ({ startedAt, version, warning });
  // 版を返さない bh serve は、この判定より前のコードで動いている
  if (!version) return out(STALE_SERVE);
  if (server.diskVersion && server.diskVersion !== version) return out(STALE_SERVE);
  if (!appVersion || appVersion === version) return out('');
  // PC の方が新しいのは画面（GitHub Pages）の公開待ち。bh update では直らない
  return out(versionNumber(version) > versionNumber(appVersion) ? APP_OLDER : STALE_SERVE);
}

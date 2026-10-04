// PC 側のデータ保存（data/ 以下の JSON ファイル）

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary } from '../web/core/model.js';
import { deserializeCache, serializeCache } from '../web/core/analysis/pipeline.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  llm: { baseUrl: 'http://127.0.0.1:11434', chatModel: '', embedModel: '' },
  port: 8787,
  host: '127.0.0.1',
  allowedOrigins: ['https://nihi566.github.io'],
  token: '',
  // Play ブックスのメモ（Google ドライブ）の自動取り込み。clientId が空なら使わない
  google: { clientId: '', clientSecret: '', folderId: '', intervalSec: 60 },
};

export function createStore(dataDir = process.env.BH_DATA || path.join(REPO_ROOT, 'data')) {
  const file = (name) => path.join(dataDir, name);

  async function readJson(name, fallback) {
    try {
      return JSON.parse(await readFile(file(name), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      throw new Error(`${file(name)} を読めませんでした: ${e.message}`);
    }
  }

  async function writeJson(name, data, { mode } = {}) {
    await mkdir(dataDir, { recursive: true });
    const tmp = file(`${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmp, JSON.stringify(data, null, 1), { mode });
    await rename(tmp, file(name));
  }

  // 読み込み → 変更 → 保存 を直列に行うためのロック（同時リクエストで更新が消えないように）
  let chain = Promise.resolve();
  const lock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  return {
    dataDir,
    lock,
    async config() {
      // vault / root / autoExport は Obsidian への書き出しを削除する前の設定。次に保存したときに消えるよう読み捨てる
      const { vault, root, autoExport, ...c } = await readJson('config.json', {});
      return { ...DEFAULT_CONFIG, ...c, llm: { ...DEFAULT_CONFIG.llm, ...(c.llm || {}) }, google: { ...DEFAULT_CONFIG.google, ...(c.google || {}) } };
    },
    saveConfig: (c) => writeJson('config.json', c),
    library: () => readJson('library.json', emptyLibrary()),
    saveLibrary: (lib) => writeJson('library.json', lib),
    analysis: () => readJson('analysis.json', null),
    saveAnalysis: (a) => writeJson('analysis.json', a),
    async cache() {
      return deserializeCache(await readJson('cache.json', null));
    },
    saveCache: (c) => writeJson('cache.json', serializeCache(c)),
    // Google のリフレッシュトークン（ドライブを読む鍵なので本人だけが読めるように保存する）
    googleToken: () => readJson('google-token.json', null),
    saveGoogleToken: (t) => writeJson('google-token.json', t, { mode: 0o600 }),
    removeGoogleToken: () => rm(file('google-token.json'), { force: true }),
    // 取り込み済みのドキュメントと、その時点の更新日時
    googleSync: () => readJson('google-sync.json', { files: {} }),
    saveGoogleSync: (s) => writeJson('google-sync.json', s),
    // Kindle の拡張機能の確認結果など、設定ではない状態
    state: () => readJson('state.json', {}),
    saveState: (st) => writeJson('state.json', st),
  };
}

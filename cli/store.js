// PC 側のデータ保存（data/ 以下の JSON ファイル）

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary } from '../web/core/model.js';
import { deserializeCache, serializeCache } from '../web/core/analysis/pipeline.js';
import { AUTO_DEFAULTS } from '../web/core/auto-analysis.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 分析の履歴を残す回数（直近から。完了条件は 10 回分以上）
export const HISTORY_KEEP = 12;

export const DEFAULT_CONFIG = {
  llm: { baseUrl: 'http://127.0.0.1:11434', chatModel: '', embedModel: '' },
  port: 8787,
  host: '127.0.0.1',
  allowedOrigins: ['https://nihi566.github.io'],
  token: '',
  // Play ブックスのメモ（Google ドライブ）の自動取り込み。clientId が空なら使わない
  google: { clientId: '', clientSecret: '', folderId: '', intervalSec: 60 },
  // bh serve が人の操作なしに分析し直す条件（前回のあとに点が minPoints 件増えた / maxHours 時間たって 1 件以上増えた）
  autoAnalyze: { ...AUTO_DEFAULTS },
};

/** 履歴の ID（分析した時刻から作る。ファイル名にそのまま使うので数字と T・Z だけ。短すぎる・長すぎるものは使わない） */
export const HISTORY_ID = /^[0-9TZ]{8,40}$/;
export function historyId(analysis) {
  const id = String(analysis?.createdAt || '').replace(/[^0-9TZ]/g, '');
  return HISTORY_ID.test(id) ? id : '';
}

/** 履歴の一覧に出す要約（本文は持たない。届いた値をそのまま写さず、確かめた短い値と数だけにする） */
function historySummary(a) {
  const c = a.changes && typeof a.changes === 'object' ? a.changes : null;
  const short = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const count = (v) => (Array.isArray(v) ? v.length : 0);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const s = a.stats && typeof a.stats === 'object' ? a.stats : {};
  return {
    id: historyId(a),
    createdAt: short(a.createdAt, 40),
    recommendedAt: short(a.recommendedAt, 40) || null,
    model: { chat: short(a.model?.chat, 80), embed: short(a.model?.embed, 80) },
    stats: { points: num(s.points), thoughts: num(s.thoughts), lines: num(s.lines), planes: num(s.planes), isolated: num(s.isolated) },
    incremental: a.incremental === true,
    changes: c ? { rebuilt: c.rebuilt === true, addedLines: count(c.addedLines), grownLines: count(c.grownLines), removedLines: count(c.removedLines), connectedPoints: count(c.connectedPoints) } : null,
  };
}

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
    // 履歴は history/ の下に置く
    await mkdir(path.dirname(file(name)), { recursive: true });
    const tmp = file(`${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(data, null, 1), { mode });
      await rename(tmp, file(name));
    } catch (e) {
      // 書けなかった一時ファイルを残さない
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  // 読み込み → 変更 → 保存 を直列に行うためのロック（同時リクエストで更新が消えないように）
  const serial = () => {
    let chain = Promise.resolve();
    return (fn) => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => {});
      return run;
    };
  };
  const lock = serial();
  // 分析結果と履歴の保存だけの順番待ち（lock の中からも呼ばれるので別にする。同時に保存すると履歴の一覧が欠ける）
  const analysisLock = serial();

  return {
    dataDir,
    lock,
    async config() {
      // vault / root / autoExport は Obsidian への書き出しを削除する前の設定。次に保存したときに消えるよう読み捨てる
      // JSON として正しくても null・配列などオブジェクトでない中身なら、既定の設定で読む
      const saved = await readJson('config.json', {});
      const { vault, root, autoExport, ...c } = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
      return { ...DEFAULT_CONFIG, ...c, llm: { ...DEFAULT_CONFIG.llm, ...(c.llm || {}) }, google: { ...DEFAULT_CONFIG.google, ...(c.google || {}) }, autoAnalyze: { ...DEFAULT_CONFIG.autoAnalyze, ...(c.autoAnalyze || {}) } };
    },
    saveConfig: (c) => writeJson('config.json', c),
    library: () => readJson('library.json', emptyLibrary()),
    saveLibrary: (lib) => writeJson('library.json', lib),
    analysis: () => readJson('analysis.json', null),
    /** 分析結果を保存し、履歴（history/）にも残す。おすすめだけ選び直したとき（同じ分析の時刻）は、その回の履歴を差し替える */
    saveAnalysis: (a) =>
      analysisLock(async () => {
        await writeJson('analysis.json', a);
        const id = historyId(a);
        if (!id) return;
        await writeJson(`history/${id}.json`, a);
        const index = [historySummary(a), ...(await readJson('history/index.json', [])).filter((h) => h.id !== id)].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
        // 一覧を先に書いてから古い回を消す（途中で止まっても、消えたファイルを指す一覧を残さない）。
        // 消すのは一覧ではなく実際のファイルで決める（一覧から漏れたファイルも残さない）
        const kept = index.slice(0, HISTORY_KEEP);
        await writeJson('history/index.json', kept);
        const keep = new Set(kept.map((h) => `${h.id}.json`));
        for (const f of await readdir(file('history'))) {
          if (f !== 'index.json' && !keep.has(f) && /^[0-9TZ]{8,40}\.json$/.test(f)) await rm(file(`history/${f}`), { force: true });
        }
      }),
    /** 分析の履歴（新しい順の要約） */
    history: () => readJson('history/index.json', []),
    /** 過去の分析を 1 回分。ID の形が違えば null */
    historyEntry: (id) => (HISTORY_ID.test(String(id)) ? readJson(`history/${id}.json`, null) : Promise.resolve(null)),
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

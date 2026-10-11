// アプリの状態（ライブラリ・分析結果・設定）と保存
import { kv } from './db.js';
import { emptyLibrary } from '../core/model.js';
import { deserializeCache, emptyCache, serializeCache } from '../core/analysis/pipeline.js';

export const DEFAULT_SETTINGS = {
  ai: {
    // companion: PC のコンパニオンサーバで分析（スマホからも使える） / direct: ブラウザから LLM に直接つなぐ
    mode: 'companion',
    companionUrl: '',
    token: '',
    baseUrl: 'http://localhost:11434',
    chatModel: '',
    embedModel: '',
  },
  autoSync: true,
};

export const state = {
  library: emptyLibrary(),
  analysis: null,
  settings: structuredClone(DEFAULT_SETTINGS),
  servedByCompanion: false,
  // PC が配信している画面かを確かめ終えたか（届かなかった間は false のまま、あとで確かめ直す）
  companionOriginChecked: false,
  job: null,
  lastSync: null,
  // 最後の PC との同期が失敗したか（保存しない。開き直すたびに同期し直す）
  pcSyncFailed: false,
  // 最後の PC との同期が失敗した時刻と理由 { at, message }。成功したら null（保存しない。NIH-146）
  lastSyncError: null,
  // PC のコンパニオンサーバの状態（拡張の確認結果など）
  pcInfo: null,
  // 取り込み画面の最後の取り込み結果（保存しない。自動同期の描き直しのあとも結果欄を出し直すため。画面を離れたら消す）
  lastImport: null,
  // 端末に保存したデータを読み終えたか。読み終える前に保存すると、空のライブラリで上書きしてしまう
  loaded: false,
};

export async function loadState() {
  const [library, analysis, settings, lastSync] = await Promise.all([kv.get('library'), kv.get('analysis'), kv.get('settings'), kv.get('lastSync')]);
  if (library) state.library = library;
  if (analysis) state.analysis = analysis;
  if (settings) {
    // root / rootExplicit / vaultName / autoExportFolder は Obsidian への書き出しを削除する前の設定。次に保存したときに消えるよう読み捨てる
    const { root, rootExplicit, vaultName, autoExportFolder, ...rest } = settings;
    state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...rest, ai: { ...DEFAULT_SETTINGS.ai, ...(settings.ai || {}) } };
  }
  state.lastSync = lastSync || null;
  state.loaded = true;
}

export const save = {
  library: () => {
    if (!state.loaded) return Promise.reject(new Error('まだ端末のデータを読み込んでいます。少し待ってからもう一度押してください'));
    return kv.set('library', state.library);
  },
  analysis: () => (state.analysis ? kv.set('analysis', state.analysis) : kv.del('analysis')),
  settings: () => kv.set('settings', state.settings),
  lastSync: () => kv.set('lastSync', state.lastSync),
};

export async function loadCache() {
  return deserializeCache(await kv.get('cache')) || emptyCache();
}

export async function saveCache(cache) {
  await kv.set('cache', serializeCache(cache));
}

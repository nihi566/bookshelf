// コンパニオンサーバ（PC で常駐させる小さな HTTP サーバ。依存ライブラリなし）
//
// - Web アプリそのものを配信する（http://localhost:8787 で開けば Safari でも LLM を使える）
// - /api/*  … ライブラリの同期、PC 側での AI 分析ジョブ
// - /llm/*  … ローカル LLM（Ollama など）への中継。CORS と Host ヘッダの問題をここで吸収する
//
// スマホからは `tailscale serve --bg 8787` で https://<PC名>.<tailnet>.ts.net として届く。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from './store.js';
import { libraryStats, mergeLibraries } from '../web/core/model.js';
import { analysisPoints } from '../web/core/points.js';
import { analysisStamp, applyImport } from '../web/core/importing.js';
import { mergeKindleSync, normalizeKindleReport } from '../web/core/kindle-status.js';
import { createLlmClient, normalizeBaseUrl } from '../web/core/analysis/llm.js';
import { analyzeLibrary, recommendBooks, recommendationNote } from '../web/core/analysis/pipeline.js';
import { autoAnalyzeDue, autoConfig, notesChanged, pendingPoints } from '../web/core/auto-analysis.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { swVersion } from '../web/core/serve-version.js';
import { restoreAnalysis } from '../web/core/analysis/restore.js';
import { wishlistForRecommend } from '../web/core/wishlist.js';
import { parseFiles } from '../web/core/parsers/index.js';
// 画面に出すエラーの文から、URL に書いたパスワード（http://user:pass@…）を伏せる
import { maskSecrets } from '../web/core/text.js';
import { askLibrary, cleanQuery, createSemanticIndex, searchTargets, semanticSearch } from '../web/core/ask.js';
import { cleanPicks, outlineMaterials, outlinePrompt, readOutline } from '../web/core/outline-draft.js';

// 埋め込みモデルが無いときの説明（意味で探す・問いかけるは使えない。画面は言葉の一致の検索に戻る）
const NO_EMBED_MODEL = 'PC に埋め込みモデルが設定されていないので、意味で探す・問いかけるは使えません（PC で bh config embed bge-m3 を実行してください）';
// チャットモデルが無いときの説明（問いかける・骨組みを作るは使えない）
const NO_CHAT_MODEL = 'PC のチャットモデルが設定されていないので、AI に頼めません（PC で bh config model qwen2.5:7b などを実行してください）';

const WEB_ROOT = path.join(REPO_ROOT, 'web');
const SW_PATH = path.join(WEB_ROOT, 'sw.js');
// web/sw.js の版（読めなければ空。画面は「版を返さない古い bh serve」と同じに扱う）
function startupSwVersion() {
  try {
    return swVersion(readFileSync(SW_PATH, 'utf8'));
  } catch {
    return '';
  }
}
async function diskSwVersion() {
  try {
    return swVersion(await readFile(SW_PATH, 'utf8'));
  } catch {
    return '';
  }
}
// 画面に渡す、Play ブックスの取り込めないドキュメントの数の上限（件数は problemCount で全部を渡す）
const DRIVE_PROBLEMS_MAX = 30;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
const MAX_BODY = 50 * 1024 * 1024;
// 意味で探す・問いかける・骨組みを作るの本文（質問は 300 字まで）と、同時に受ける数（PC の AI を使い切らせない。分析も同じ AI を使う）
const AI_BODY_MAX = 64 * 1024;
const AI_CONCURRENCY = 2;

// catalogFetch: おすすめの本を探す書誌 DB への fetch（テストで差し替える）
// drive: Play ブックスのメモ（Google ドライブ）の見張り役（startDriveWatcher の戻り値。無ければ null）
// auto: { intervalMs } を渡すと、その間隔で自動の分析を始めるかを確かめる（bh serve。テストでは渡さず checkAutoAnalyze を呼ぶ）
export function createCompanionServer({ store, log = console.log, catalogFetch, drive = null, auto = null }) {
  // trigger: 'manual'（画面のボタン・bh）/ 'auto'（点が増えたので PC が自分で始めた）
  // bh update が「止めた後に起動したプロセス（= 新しいコード）か」を確かめるのに使う
  const serverStartedAt = new Date().toISOString();
  // 起動したときの web/sw.js の版（= 動いているコードの版）。/sw.js はディスクから毎回配るので、そちらでは古いコードか分からない
  const serverVersion = startupSwVersion();
  const job = { running: false, stage: '', message: '', done: 0, total: 0, error: '', startedAt: null, finishedAt: null, trigger: '', controller: null };
  // 取り込みの最中は自動の分析を始めない（取り込み途中の点で分析しない）
  let activeImports = 0;
  // 最後に失敗・中止した時刻（state.json に書けないときも、試し直すまで待てるよう手元にも持つ）
  const lastStop = { failure: null, cancel: null };
  // 意味で探す・問いかけるのベクトル（LLM の場所と埋め込みモデルごとに 1 つ。cache.json は分析と書き合いになるので書かない）
  let semantic = null;
  // 意味で探す・問いかける・骨組みを作るの、いま答えている数
  let aiActive = 0;

  /**
   * 意味で探す・問いかける・骨組みを作るを、同時に受ける数を守って動かす（超えたら 429）。相手が接続を切ったら AI の処理も止める
   * @param {(signal: AbortSignal) => Promise<unknown>} fn
   */
  async function aiJob(res, fn) {
    if (aiActive >= AI_CONCURRENCY) return send(res, 429, { error: 'PC がほかの問い合わせに答えています。少し待ってから、もう一度押してください', code: 'busy' });
    aiActive++;
    const ctrl = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ctrl.abort();
    };
    res.on('close', onClose);
    try {
      return await fn(ctrl.signal);
    } finally {
      aiActive--;
      res.off('close', onClose);
    }
  }

  /** 意味で探す・問いかけるの失敗の返し方（相手が切ったなら返さない。先に分析が要るなら 409。それ以外は 502 で、URL の秘密は伏せる） */
  function semanticError(res, e, signal, what) {
    if (signal.aborted) return;
    if (e.code === 'needs-analysis') return send(res, 409, { error: e.message, code: e.code });
    return send(res, 502, { error: `${what}（${maskSecrets(e.message)}）` });
  }

  /** 意味で探す・問いかけるの準備（分析のキャッシュが新しくなっていたら、そのベクトルを使い直す） */
  async function semanticIndex(cfg, library) {
    const llm = createLlmClient(cfg.llm);
    const key = `${normalizeBaseUrl(cfg.llm.baseUrl)}|${cfg.llm.embedModel}`;
    if (semantic?.key !== key) semantic = { key, index: createSemanticIndex({ embed: llm.embed, model: cfg.llm.embedModel }), cacheAt: null };
    const cacheAt = await stat(path.join(store.dataDir, 'cache.json')).then((s) => s.mtimeMs, () => 0);
    if (cacheAt !== semantic.cacheAt) {
      semantic.index.seed((await store.cache()).embeddings, searchTargets(library));
      semantic.cacheAt = cacheAt;
    }
    return { index: semantic.index, llm };
  }

  function isAllowedOrigin(origin, host, cfg) {
    if (!origin) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
    // Tailscale Serve で配信した画面からの同一オリジンのリクエストだけ許可する
    // （*.ts.net を丸ごと許すと、公開されている他人の Funnel サイトからも読めてしまう）
    if (host && origin === `https://${host}` && /\.ts\.net$/i.test(host)) return true;
    return (cfg.allowedOrigins || []).some((o) => o.replace(/\/+$/, '') === origin);
  }

  function isAllowedHost(host, cfg) {
    // DNS リバインディング対策: 想定外の Host 名で来たリクエストは拒否（トークン設定時は除く）
    if (cfg.token) return true;
    const h = String(host || '').replace(/:\d+$/, '').toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]'].includes(h) || h.endsWith('.ts.net') || (cfg.allowedHosts || []).includes(h);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    const cfg = await store.config();
    if (origin && isAllowedOrigin(origin, req.headers.host, cfg)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-BH-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      // Chrome の Local Network Access / Private Network Access のプリフライトに応える
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    } else if (origin) {
      return send(res, 403, { error: `このオリジンからの接続は許可されていません: ${origin}（bh config origin ${origin} で追加できます）` });
    }
    if (req.method === 'OPTIONS') return send(res, 204);
    if (!isAllowedHost(req.headers.host, cfg)) return send(res, 403, { error: 'Host ヘッダが許可されていません' });

    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/llm/');
    if (isApi && cfg.token && req.headers['x-bh-token'] !== cfg.token && url.searchParams.get('token') !== cfg.token) {
      return send(res, 401, { error: 'トークンが違います' });
    }
    if (url.pathname.startsWith('/llm/')) return proxyLlm(req, res, url, cfg);
    if (url.pathname.startsWith('/api/')) return api(req, res, url, cfg);
    return serveStatic(res, url.pathname);
  }

  async function api(req, res, url, cfg) {
    const route = `${req.method} ${url.pathname}`;
    // 過去の分析を 1 回分（履歴の ID は分析した時刻の数字）
    const hist = req.method === 'GET' && url.pathname.match(/^\/api\/history\/([0-9TZ]{8,40})$/);
    if (hist) {
      const a = await store.historyEntry(hist[1]);
      return a ? send(res, 200, a) : send(res, 404, { error: 'その分析は履歴にありません' });
    }
    // 過去の分析に戻す（NIH-7）。その回を今の時刻の分析として保存する（履歴にも 1 回分として残る）
    const back = req.method === 'POST' && url.pathname.match(/^\/api\/history\/([0-9TZ]{8,40})\/restore$/);
    if (back) {
      // 分析の最中は戻さない（分析が終わって保存すると、戻した結果が上書きされる）
      const busy = () => send(res, 409, { error: `PC が${job.trigger === 'auto' ? '自動で' : ''}分析しています。終わってから、もう一度押してください。`, job: publicJob() });
      if (job.running) return busy();
      const entry = await store.historyEntry(back[1]);
      if (!entry) return send(res, 404, { error: 'その分析は履歴にありません' });
      // 続けて押されても、今の分析を読んでから保存するまでを 1 回ずつにする（同じ時刻の回で履歴を上書きしない）
      const out = await store.lock(async () => {
        // 今の分析（おすすめを選んだ時刻も含む）より新しい時刻にする（時計のずれた端末の分析が未来の時刻でも、同期で戻した回が負けないように）
        const latest = Date.parse(analysisStamp(await store.analysis())) || 0;
        const restored = restoreAnalysis(entry, new Date(Math.max(Date.now(), latest + 1)).toISOString());
        const err = analysisShapeError(restored);
        if (err) return { status: 400, body: { error: `この分析には戻せません: ${err}` } };
        if (job.running) return null;
        await store.saveAnalysis(restored);
        return { status: 200, body: restored };
      });
      return out ? send(res, out.status, out.body) : busy();
    }
    switch (route) {
      case 'GET /api/info': {
        const lib = await store.library();
        const analysis = await store.analysis();
        const st = await store.state();
        return send(res, 200, {
          app: 'book-highlights',
          // 設定 → 接続を確認 が、古いコードのまま動いていないかを見る（web/core/serve-version.js）
          server: { startedAt: serverStartedAt, version: serverVersion, diskVersion: await diskSwVersion() },
          stats: libraryStats(lib),
          // Web アプリはこれが自分の持つものより新しいときだけ同期する
          updatedAt: lib.updatedAt,
          llm: { chatModel: cfg.llm.chatModel, embedModel: cfg.llm.embedModel, configured: Boolean(cfg.llm.chatModel) },
          kindleSync: st.kindleSync || null,
          analysis: analysis ? { createdAt: analysis.createdAt, recommendedAt: analysis.recommendedAt, ...analysis.stats } : null,
          job: publicJob(),
          google: drive ? { ...publicDrive(drive.status), lastNew: st.playbooksSync?.lastNew || null } : null,
          // 自動の分析の設定と、最後に成功した時刻・失敗の理由（知識の画面に出す）
          autoAnalysis: { ...autoConfig(cfg.autoAnalyze), running: Boolean(auto), pending: pendingPoints(analysisPoints(lib), analysis), notesChanged: notesChanged(lib, analysis), ...publicAutoState(st.autoAnalysis) },
        });
      }
      case 'GET /api/history':
        return send(res, 200, { items: await store.history() });
      case 'GET /api/library':
        return send(res, 200, await store.library());
      case 'POST /api/library/merge': {
        const incoming = await readBody(req);
        const merged = await store.lock(async () => {
          const m = mergeLibraries(await store.library(), incoming);
          await store.saveLibrary(m);
          return m;
        });
        return send(res, 200, merged);
      }
      case 'POST /api/import': {
        // { files: [{ name, base64 }], auto? } を PC 側でパースして取り込む（auto: ブラウザ拡張の自動取り込み。削除した本を復活させない）
        // 本文を受け取り終えてから「取り込みの最中」に数える（ゆっくり送り続ける接続で自動の分析を止め続けられないように）
        const body = await readBody(req);
        const list = body.files ?? [];
        if (!Array.isArray(list) || !list.every((f) => f && typeof f === 'object' && typeof f.base64 === 'string')) {
          return send(res, 400, { error: 'files は [{ name, base64 }] の形で送ってください' });
        }
        activeImports++;
        try {
          const files = list.map((f) => ({ name: String(f.name ?? ''), bytes: Buffer.from(f.base64, 'base64') }));
          const parsed = await parseFiles(files);
          const r = await store.lock(async () => {
            const out = applyImport({ library: await store.library(), analysis: await store.analysis() }, parsed, { reviveDeleted: !body.auto });
            await store.saveLibrary(out.library);
            if (out.analysisChanged) await store.saveAnalysis(out.analysis);
            return out;
          });
          return send(res, 200, { stats: r.stats, results: parsed.results, analysisChanged: r.analysisChanged });
        } finally {
          activeImports--;
        }
      }
      case 'POST /api/kindle-status': {
        // ブラウザ拡張の確認結果（正常 / ログイン切れ / 失敗など）を state.json に残す。本文はログに出さない
        let report;
        try {
          report = normalizeKindleReport(await readBody(req));
        } catch (e) {
          return send(res, e.status || 400, { error: e.message });
        }
        await store.lock(async () => {
          const st = await store.state();
          await store.saveState({ ...st, kindleSync: mergeKindleSync(st.kindleSync, report, new Date().toISOString()) });
        });
        return send(res, 200, { ok: true });
      }
      case 'GET /api/analysis': {
        const a = await store.analysis();
        return a ? send(res, 200, a) : send(res, 404, { error: 'まだ分析していません' });
      }
      case 'PUT /api/analysis': {
        // ブラウザで分析した結果（ブラウザから LLM に直接つなぐ使い方）。形の壊れたものは保存しない（前回の結果・履歴・件数の計算に使うため）
        const a = await readBody(req);
        const err = analysisShapeError(a);
        if (err) return send(res, 400, { error: `分析結果を保存できません: ${err}` });
        await store.saveAnalysis(a);
        return send(res, 200, { ok: true });
      }
      case 'GET /api/analyze':
        return send(res, 200, publicJob());
      case 'POST /api/analyze': {
        const body = await readBody(req).catch(() => ({}));
        // mode: analyze（前回を引き継ぐ）/ full（最初から作り直す）/ recommend（おすすめだけ選び直す）
        // 欲しい本（タグつき）は Web アプリが送る。PC には保存せず、このジョブのおすすめにだけ使う
        const mode = ['recommend', 'full'].includes(body.mode) ? body.mode : 'analyze';
        // 分析の最中（自動の分析を含む）は始めない。黙って受けると、押した「作り直し」などが使われないまま完了に見える
        if (job.running) return send(res, 409, { error: `PC が${job.trigger === 'auto' ? '自動で' : 'ほかの'}分析をしています。終わってから、もう一度押してください。`, job: publicJob() });
        startJob(mode, wishlistForRecommend(body.wishlist), { trigger: 'manual' });
        return send(res, 202, publicJob());
      }
      case 'DELETE /api/analyze':
        job.controller?.abort();
        return send(res, 200, publicJob());
      case 'POST /api/search': {
        // 意味で探す（G8-1）。返すのは点・永久ノートの ID と近さだけ（本文は画面の側が自分のライブラリから出す）
        const q = cleanQuery((await readBody(req, AI_BODY_MAX)).q);
        if (!q) return send(res, 400, { error: '探す言葉を入れてください' });
        if (!cfg.llm.embedModel) return send(res, 409, { error: NO_EMBED_MODEL, code: 'no-embed-model' });
        return aiJob(res, async (signal) => {
          const library = await store.library();
          try {
            const { index } = await semanticIndex(cfg, library);
            return send(res, 200, { model: cfg.llm.embedModel, results: await semanticSearch({ library, query: q, index, signal }) });
          } catch (e) {
            return semanticError(res, e, signal, '意味で探せませんでした');
          }
        });
      }
      case 'POST /api/ask': {
        // 問いかける（G8-2・G8-3）。関連する点を最大 8 件集め、ローカル LLM が点だけを根拠に答える。関係する点が無ければ AI を呼ばない
        const question = cleanQuery((await readBody(req, AI_BODY_MAX)).question);
        if (!question) return send(res, 400, { error: '質問を入れてください' });
        if (!cfg.llm.embedModel) return send(res, 409, { error: NO_EMBED_MODEL, code: 'no-embed-model' });
        if (!cfg.llm.chatModel) return send(res, 409, { error: NO_CHAT_MODEL, code: 'no-chat-model' });
        return aiJob(res, async (signal) => {
          const library = await store.library();
          try {
            const { index, llm } = await semanticIndex(cfg, library);
            return send(res, 200, await askLibrary({ library, question, index, chatJson: llm.chatJson, signal }));
          } catch (e) {
            return semanticError(res, e, signal, '問いかけに答えられませんでした');
          }
        });
      }
      case 'POST /api/outline': {
        // 文章の骨組みを作る（G9-1）。PC が自分のライブラリ・分析から材料を集め、ローカル LLM が見出し・要点・引用の番号を作る。
        // 返すのは保存前の下書き（引用は点の ID。保存と手直しは画面の側）
        const picks = cleanPicks((await readBody(req, AI_BODY_MAX)).sources);
        if (!picks.length) return send(res, 400, { error: '面・線・永久ノートを 1 つ以上選んでください' });
        if (!cfg.llm.chatModel) return send(res, 409, { error: NO_CHAT_MODEL, code: 'no-chat-model' });
        return aiJob(res, async (signal) => {
          const library = await store.library();
          const materials = outlineMaterials(library, await store.analysis(), picks);
          // 1 つでも見つからなければ作らない（抜けたまま作らない。スマホで書いたノートがまだ PC に無い・PC で分析し直して面・線が変わった）
          if (materials.missing.length) {
            return send(res, 409, { error: `選んだ材料のうち ${materials.missing.length} 件が PC に見つかりません。PC と同期してから、もう一度押してください（分析し直して面・線が変わったときは、選び直してください）`, code: 'missing-sources' });
          }
          try {
            const r = await createLlmClient(cfg.llm).chatJson({ ...outlinePrompt(library, materials), signal });
            return send(res, 200, readOutline(r, materials));
          } catch (e) {
            if (signal.aborted) return;
            return send(res, 502, { error: e.code === 'empty-outline' ? e.message : `骨組みを作れませんでした（${maskSecrets(e.message)}）` });
          }
        });
      }
      default:
        return send(res, 404, { error: `不明な API: ${route}` });
    }
  }

  function publicDrive({ active, configured, lastCheck, lastImport, error, problems = [] }) {
    // 取り込めないドキュメントは画面に出すだけなので、数と長さを切って渡す
    const cut = (s, n) => String(s || '').slice(0, n);
    return { active, configured, lastCheck, lastImport, error, problemCount: problems.length, problems: problems.slice(0, DRIVE_PROBLEMS_MAX).map((p) => ({ name: cut(p.name, 200), error: cut(p.error, 300), modifiedTime: cut(p.modifiedTime, 40) })) };
  }

  function publicJob() {
    const { controller, ...rest } = job;
    return rest;
  }

  /** state.json の autoAnalysis のうち、画面に出すもの */
  function publicAutoState(a = {}) {
    return { lastRunAt: a.lastRunAt || null, lastSuccessAt: a.lastSuccessAt || null, lastError: a.lastError || '', lastErrorAt: a.lastErrorAt || null, failureCount: Number(a.failureCount) || 0, lastCancelledAt: a.lastCancelledAt || null, lastTrigger: a.lastTrigger || '' };
  }

  /**
   * 分析の結果（成功・失敗・中止）を state.json に残す（失敗しても前回の分析結果は残っている）。書けなくても分析の結果は変えない。
   * patch は前回の記録を受け取って差分を返す関数でもよい（続けて失敗した回数を数えるため）
   */
  async function recordRun(patch) {
    try {
      await store.lock(async () => {
        const st = await store.state();
        const prev = st.autoAnalysis || {};
        await store.saveState({ ...st, autoAnalysis: { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) } });
      });
    } catch (e) {
      log(`[analyze] 分析の記録を state.json に書けませんでした: ${e.message}`);
    }
  }

  /** ジョブを始める（終わるのは待たない。万一の例外も拾って、プロセスを落とさない） */
  function startJob(...args) {
    runJob(...args).catch((e) => log(`[analyze] ${e?.message || e}`));
  }

  /**
   * 分析のジョブ。mode: analyze（前回の線・面を引き継いで変わったところだけ AI を呼ぶ）/ full（最初から作り直す）/ recommend
   * trigger: manual / auto（自動の分析）。失敗しても analysis.json は書き換えない（前回の結果が残る）
   */
  async function runJob(mode, wishlist = [], { trigger = 'manual' } = {}) {
    const startedAt = new Date().toISOString();
    Object.assign(job, { running: true, stage: 'start', message: trigger === 'auto' ? '点が増えたので、PC が自動で分析しています' : '開始しています', done: 0, total: 0, error: '', startedAt, finishedAt: null, trigger, controller: new AbortController() });
    try {
      const cfg = await store.config();
      if (!cfg.llm.chatModel) throw new Error('チャットモデルが設定されていません（bh config model <モデル名>）');
      const llm = createLlmClient(cfg.llm);
      const library = await store.library();
      const onProgress = (p) => Object.assign(job, p);
      if (mode === 'recommend') {
        const analysis = await store.analysis();
        if (!analysis) throw new Error('先に分析を実行してください');
        analysis.recommendations = await recommendBooks({ library, analysis, llm, onProgress, signal: job.controller.signal, fetchImpl: catalogFetch, wishlist });
        analysis.recommendedAt = new Date().toISOString();
        analysis.recommendationNote = recommendationNote(analysis.recommendations);
        await store.saveAnalysis(analysis);
      } else {
        const cache = await store.cache();
        const previous = await store.analysis();
        // 自動の分析は欲しい本（購入済み・読んだの印は画面の側にある）を知らないので、おすすめは前回のものを残す
        const recommend = trigger === 'auto' ? 'keep' : true;
        let analysis;
        try {
          ({ analysis } = await analyzeLibrary({ library, llm, cache, previous, onProgress, signal: job.controller.signal, options: { fetchImpl: catalogFetch, wishlist, full: mode === 'full', recommend } }));
        } finally {
          await store.saveCache(cache);
        }
        await store.saveAnalysis(analysis);
      }
      job.stage = 'done';
      job.message = '完了しました';
      lastStop.failure = null;
      lastStop.cancel = null;
      await recordRun({ lastRunAt: startedAt, lastSuccessAt: new Date().toISOString(), lastError: '', lastErrorAt: null, failureCount: 0, lastCancelledAt: null, lastTrigger: trigger });
    } catch (e) {
      const now = new Date().toISOString();
      job.error = maskSecrets(e.message);
      job.stage = 'error';
      if (job.controller.signal.aborted) {
        // 利用者が止めた: 失敗とは分けて残す（赤字の「失敗」にしない。すぐには自動で始め直さない）
        lastStop.cancel = now;
        await recordRun({ lastRunAt: startedAt, lastCancelledAt: now, lastTrigger: trigger });
      } else {
        log(`[analyze${trigger === 'auto' ? '・自動' : ''}] ${job.error}`);
        lastStop.failure = now;
        // 続けて失敗した回数はホームの警告に出す（成功で 0 に戻す。中止は数えない）
        await recordRun((prev) => ({ lastRunAt: startedAt, lastError: job.error, lastErrorAt: now, failureCount: (Number(prev.failureCount) || 0) + 1, lastTrigger: trigger }));
      }
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  }

  /**
   * 自動の分析を始めるか確かめ、条件を満たしていれば始める（終わるのは待たない）。
   * 手動の分析中・取り込みの最中（拡張・Google ドライブ・画面からの取り込み）には始めない
   * @returns {Promise<{ started: boolean, reason: string, pending?: number }>}
   */
  async function checkAutoAnalyze(now = new Date()) {
    if (job.running) return { started: false, reason: '分析の最中です' };
    if (activeImports > 0 || drive?.status?.checking) return { started: false, reason: '取り込みの最中です' };
    const cfg = await store.config();
    if (!cfg.llm.chatModel) return { started: false, reason: 'チャットモデルが設定されていません' };
    const [library, analysis, st] = await Promise.all([store.library(), store.analysis(), store.state()]);
    const later = (a, b) => [a, b].filter(Boolean).sort().pop() || null;
    const r = autoAnalyzeDue({
      points: analysisPoints(library),
      analysis,
      config: cfg.autoAnalyze,
      now,
      lastFailureAt: later(st.autoAnalysis?.lastErrorAt, lastStop.failure),
      lastCancelledAt: later(st.autoAnalysis?.lastCancelledAt, lastStop.cancel),
      notesChanged: notesChanged(library, analysis),
    });
    if (!r.due || job.running) return { started: false, ...r };
    log(`[auto] ${r.reason}。分析を始めます`);
    startJob('analyze', [], { trigger: 'auto' });
    return { started: true, ...r };
  }

  async function proxyLlm(req, res, url, cfg) {
    const upstream = normalizeBaseUrl(cfg.llm.baseUrl) + url.pathname.replace(/^\/llm/, '') + url.search;
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readRaw(req);
    let r;
    try {
      // fetch が Host を upstream 側に合わせるので、Ollama の Host チェック（403）を回避できる
      r = await fetch(upstream, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, body });
    } catch (e) {
      return send(res, 502, { error: `LLM サーバ (${cfg.llm.baseUrl}) に接続できません: ${e.message}` });
    }
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
  }

  async function serveStatic(res, pathname) {
    let p;
    try {
      p = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { error: 'bad request' });
    }
    if (p.endsWith('/')) p += 'index.html';
    const full = path.join(WEB_ROOT, p);
    if (!full.startsWith(WEB_ROOT + path.sep)) return send(res, 403, { error: 'forbidden' });
    try {
      const s = await stat(full);
      if (s.isDirectory()) return serveStatic(res, p + '/');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(full));
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`[error] ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.end();
    });
  });
  server.job = job;
  server.checkAutoAnalyze = checkAutoAnalyze;
  // 自動の分析: 決まった間隔で条件を確かめる（起動の少しあとに 1 回目）。間隔を空けてまとめて分析する
  if (auto?.intervalMs) {
    const timers = [];
    const tick = () => checkAutoAnalyze().catch((e) => log(`[auto] ${e.message}`));
    server.on('listening', () => timers.push(setTimeout(tick, auto.firstDelayMs ?? 10_000), setInterval(tick, auto.intervalMs)));
    server.on('close', () => timers.forEach((t) => clearTimeout(t)));
  }
  return server;
}


function send(res, status, data) {
  if (data === undefined) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readRaw(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('リクエストが大きすぎます'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readBody(req, max = MAX_BODY) {
  const raw = await readRaw(req, max);
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON を読めませんでした'), { status: 400 });
  }
  // API の本文はどれもオブジェクト（null・配列・数値などは形が違う）
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('本文は JSON のオブジェクトで送ってください'), { status: 400 });
  return body;
}

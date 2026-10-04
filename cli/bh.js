#!/usr/bin/env node
// bookshelf の PC 用コマンド
//
//   bh import <ファイル|フォルダ...>  Kindle / Play Books のハイライト・読書メモ（.md）を取り込む
//   bh analyze                    ローカル LLM で 点→線→面→立体 を分析し、おすすめの本を選ぶ
//   bh recommend                   おすすめの本だけ選び直す
//   bh serve                       コンパニオンサーバを起動（Web アプリ + 同期 + LLM 中継 + Play ブックスの自動取り込み）
//   bh google login|sync|logout    Play ブックスのメモ（Google ドライブ）との連携
//   bh list / bh search <語>       一覧・検索
//   bh config [キー 値]            設定の表示・変更

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from './store.js';
import { createCompanionServer } from './server.js';
import { createGoogleClient, describeSync, isFolderId, MIN_INTERVAL_SEC, startDriveWatcher } from './google.js';
import { SOURCES, listBooks, libraryStats, searchHighlights } from '../web/core/model.js';
import { applyImport } from '../web/core/importing.js';
import { ACCEPT, parseFiles } from '../web/core/parsers/index.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { TFIDF_HINT, analyzeLibrary, recommendBooks, recommendationNote } from '../web/core/analysis/pipeline.js';
import { autoConfig } from '../web/core/auto-analysis.js';
import { truncate } from '../web/core/text.js';

// bh serve が自動の分析の条件を確かめる間隔（点が増えるたびではなく、間隔を空けてまとめて分析する）
const AUTO_CHECK_MS = 60_000;

const HELP = `使い方: bh <コマンド> [オプション]

  import <ファイル|フォルダ...> [--dry-run]
                                      ハイライトを取り込む（My Clippings.txt / Kindle のエクスポート HTML /
                                      ブックマークレットの JSON / Play Books のメモ .docx .html .md / それらの .zip /
                                      自分で書いた読書メモ .md）。フォルダは中のファイルをすべて（入れ子も）読むので、
                                      ノートアプリの保管場所全体ではなく、読書メモのフォルダを指定する。
                                      --dry-run は保存せずに結果だけ表示する
  analyze [--no-recommend] [--full]   ローカル LLM で 点→線→面→立体 を分析（前回の線・面を引き継ぎ、変わったところだけ
                                      AI を呼ぶ。--full は最初から作り直す）
  recommend                           おすすめの本を選び直す
  serve [--port 8787] [--host 127.0.0.1]  コンパニオンサーバを起動（Google にログイン済みなら Play ブックスの線を自動で取り込む。
                                      点が増えたら自動で分析し直す）
  google login                        Google にログインする（ドライブの読み取りだけを許可）
  google sync                         Play ブックスのメモを今すぐ取り込む
  google logout                       ログアウトする（Google 側の許可も取り消す）
  list                                本の一覧
  search <語...>                       ハイライトを検索
  config                              設定を表示
  config url <URL>                    LLM サーバ（既定: http://127.0.0.1:11434 = Ollama）
  config model <名前>                 チャットモデル（例: qwen3.5:9b）
  config embed <名前>                 埋め込みモデル（例: bge-m3。空なら文字 n-gram で代用）
  config origin <URL>                 接続を許可する Web アプリのオリジン（GitHub Pages など）を追加
  config token <文字列>               API にトークンを要求する（インターネットに公開する場合は必須）
  config google-client <ID> <シークレット>  Google Cloud で作った OAuth クライアント（種類: デスクトップ アプリ）
  config google-folder <フォルダ ID>  「Play ブックスのメモ」フォルダを名前で探せないときに指定（空で自動に戻す）
  config google-interval <秒>         ドライブを確認する間隔（既定: 60、最短 ${MIN_INTERVAL_SEC}）
  config auto on|off                  bh serve の自動の分析を入れる・切る（既定: on）
  config auto-points <件数>           前回の分析のあとに点がこの件数増えたら自動で分析する（既定: 10）
  config auto-hours <時間>            前回からこの時間たち、点が 1 件以上増えていたら自動で分析する（既定: 24）

環境変数 BH_DATA でデータの保存先（既定: リポジトリの data/）を変えられます。`;

const IMPORT_EXTENSIONS = new Set(ACCEPT.split(','));

/**
 * 取り込むファイルを集める。フォルダなら中の取り込める形式のファイルをすべて（入れ子も・名前順）。
 * name はフォルダからの相対パス（同じ名前のメモが別のフォルダにあっても見分けられるように）
 */
async function collectImportFiles(target, base = target) {
  if (!(await stat(target)).isDirectory()) {
    const name = target === base ? path.basename(target) : path.relative(base, target).split(path.sep).join('/');
    return [{ name, bytes: new Uint8Array(await readFile(target)) }];
  }
  const out = [];
  const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    // 隠しフォルダ（.obsidian など）とシンボリックリンク（たどると循環しうる）は読まない
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const p = path.join(target, e.name);
    if (e.isDirectory() || IMPORT_EXTENSIONS.has(path.extname(e.name).toLowerCase())) out.push(...(await collectImportFiles(p, base)));
  }
  return out;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) args[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && ['port', 'host', 'data'].includes(k)) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const store = createStore(args.data);

  switch (cmd) {
    case 'import': {
      if (!rest.length) throw new Error('取り込むファイルかフォルダを指定してください');
      const files = [];
      for (const p of rest) files.push(...(await collectImportFiles(p)));
      if (!files.length) throw new Error('取り込めるファイルがありませんでした');
      const parsed = await parseFiles(files);
      for (const r of parsed.results) {
        if (r.error) console.log(`✗ ${r.name}: ${r.error}`);
        else console.log(`✓ ${r.name}: ${r.formatLabel} — 本 ${r.books} 冊 / 点 ${r.highlights} 件${r.images ? `（画像 ${r.images} 枚は取り込めません）` : ''}`);
      }
      const r = applyImport({ library: await store.library(), analysis: await store.analysis() }, parsed);
      const dryRun = Boolean(args['dry-run']);
      if (!dryRun) {
        await store.saveLibrary(r.library);
        if (r.analysisChanged) await store.saveAnalysis(r.analysis);
      }
      const s = r.stats;
      for (const m of s.memoTitles) console.log(`→ 読書メモ「${m.from}」は既にある本『${m.to}』にまとめました`);
      console.log(`${dryRun ? '（試し・保存していません）' : ''}取り込み: 新しい点 ${s.added} 件、更新 ${s.updated} 件、既存 ${s.unchanged} 件（新しい本 ${s.booksAdded} 冊）${r.analysisChanged ? '。バックアップの新しい分析結果も反映しました' : ''}`);
      break;
    }
    case 'analyze':
    case 'recommend': {
      const cfg = await store.config();
      if (!cfg.llm.chatModel) throw new Error('チャットモデルが未設定です。例: bh config model qwen3.5:9b');
      const llm = createLlmClient(cfg.llm);
      const library = await store.library();
      const onProgress = progressPrinter();
      if (cmd === 'recommend') {
        const analysis = await store.analysis();
        if (!analysis) throw new Error('先に bh analyze を実行してください');
        analysis.recommendations = await recommendBooks({ library, analysis, llm, onProgress });
        analysis.recommendedAt = new Date().toISOString();
        analysis.recommendationNote = recommendationNote(analysis.recommendations);
        await store.saveAnalysis(analysis);
        printRecommendations(analysis);
      } else {
        const cache = await store.cache();
        const previous = await store.analysis();
        let analysis;
        try {
          ({ analysis } = await analyzeLibrary({ library, llm, cache, previous, onProgress, options: { recommend: !args['no-recommend'], full: Boolean(args.full) } }));
        } finally {
          // 途中で失敗しても、済んだ部分の LLM の結果は次回に使えるよう保存する
          await store.saveCache(cache);
        }
        await store.saveAnalysis(analysis);
        // 知識の画面の「最後に成功」と失敗の表示を、bh analyze で分析したときも合わせる
        const st = await store.state();
        await store.saveState({ ...st, autoAnalysis: { ...(st.autoAnalysis || {}), lastRunAt: analysis.createdAt, lastSuccessAt: new Date().toISOString(), lastError: '', lastErrorAt: null, lastTrigger: 'manual' } });
        process.stdout.write('\n');
        const { chat, embed } = analysis.stats.calls;
        console.log(`${analysis.incremental ? '前回の線・面を引き継ぎました' : '最初から作り直しました'}（AI を呼んだ回数: チャット ${chat}・埋め込み ${embed}。おすすめの本は除く）`);
        if (analysis.model.embed === 'tfidf') console.log(`\n! ${TFIDF_HINT}（bh config embed bge-m3）`);
        console.log(`\n■ 立体: ${analysis.solid.title}\n${analysis.solid.core}\n`);
        for (const p of analysis.planes) {
          console.log(`■ 面: ${p.name}`);
          for (const id of p.lineIds) {
            const l = analysis.lines.find((x) => x.id === id);
            console.log(`   ─ 線: ${l.name}（点 ${l.highlightIds.length}）`);
          }
        }
        printRecommendations(analysis);
      }
      break;
    }
    case 'serve': {
      const cfg = await store.config();
      const port = Number(args.port || cfg.port);
      const host = args.host || cfg.host;
      const drive = startDriveWatcher({ store, client: createGoogleClient({ store }) });
      const server = createCompanionServer({ store, drive, auto: { intervalMs: AUTO_CHECK_MS } });
      const auto = autoConfig(cfg.autoAnalyze);
      server.listen(port, host, () => {
        console.log(`コンパニオンサーバ: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
        console.log(`  LLM: ${cfg.llm.baseUrl}（チャット: ${cfg.llm.chatModel || '未設定'} / 埋め込み: ${cfg.llm.embedModel || '文字 n-gram'}）`);
        console.log(`  Play ブックス: ${cfg.google.clientId ? `${Math.max(MIN_INTERVAL_SEC, cfg.google.intervalSec)} 秒ごとに Google ドライブを確認` : '未設定（docs/setup.md の「Play ブックスの自動取り込み」）'}`);
        console.log(`  自動の分析: ${auto.enabled ? `前回のあとに点が ${auto.minPoints} 件増えるか、${auto.maxHours} 時間たって 1 件以上増えたら分析（bh config auto off で止める）` : '切ってあります（bh config auto on）'}`);
        console.log(`  スマホから使うには: tailscale serve --bg ${port}`);
      });
      break;
    }
    case 'google': {
      const client = createGoogleClient({ store });
      const [sub] = rest;
      if (sub === 'login') {
        // 取り込みはここでは行わない（動いている bh serve と同時に library.json を書くと、片方の更新が消えるため）
        await client.login();
        console.log('ログインしました。bh serve が次の確認から Play ブックスの線を取り込みます（bh serve を使わない場合は bh google sync）');
      } else if (sub === 'sync') {
        const r = await client.sync();
        console.log(describeSync(r));
        for (const e of r.errors) console.log(`  ! ${e}`);
      } else if (sub === 'logout') {
        await client.logout();
        console.log('ログアウトしました');
      } else throw new Error('使い方: bh google login | sync | logout');
      break;
    }
    case 'list': {
      const lib = await store.library();
      const s = libraryStats(lib);
      console.log(`本 ${s.books} 冊 / 点 ${s.points} 件${s.thoughts ? `（うち思いつき ${s.thoughts} 件）` : ''}`);
      for (const b of listBooks(lib)) console.log(`${String(b.count).padStart(4)}  ${b.title}${b.author ? ' — ' + b.author : ''}  [${b.sources.map((x) => SOURCES[x]).join(', ')}]`);
      break;
    }
    case 'search': {
      const lib = await store.library();
      const hits = searchHighlights(lib, rest.join(' '));
      for (const h of hits.slice(0, 50)) console.log(`『${lib.books[h.bookId].title}』 ${truncate(h.text.replace(/\s+/g, ' '), 120)}`);
      console.log(`${hits.length} 件`);
      break;
    }
    case 'config': {
      const cfg = await store.config();
      const [key, ...vals] = rest;
      const value = vals.join(' ');
      if (!key) {
        const hidden = (v) => (v ? '(設定済み)' : '');
        console.log(JSON.stringify({ ...cfg, token: hidden(cfg.token), google: { ...cfg.google, clientSecret: hidden(cfg.google.clientSecret) } }, null, 2));
        console.log(`データ: ${store.dataDir}`);
        break;
      }
      const setters = {
        url: () => (cfg.llm.baseUrl = value),
        model: () => (cfg.llm.chatModel = value),
        embed: () => (cfg.llm.embedModel = value),
        origin: () => (cfg.allowedOrigins = [...new Set([...(cfg.allowedOrigins || []), value.replace(/\/+$/, '')])]),
        token: () => (cfg.token = value),
        port: () => (cfg.port = Number(value)),
        host: () => (cfg.host = value),
        'google-client': () => {
          const [clientId, clientSecret = ''] = vals;
          if (!clientId) throw new Error('使い方: bh config google-client <クライアント ID> <クライアント シークレット>');
          Object.assign(cfg.google, { clientId, clientSecret });
        },
        'google-folder': () => {
          if (value && !isFolderId(value)) throw new Error('フォルダ ID の形式ではありません（ドライブでフォルダを開いた URL の folders/ の後ろの文字列）');
          cfg.google.folderId = value;
        },
        'google-interval': () => {
          const sec = Number(value);
          if (!Number.isFinite(sec) || sec < MIN_INTERVAL_SEC) throw new Error(`${MIN_INTERVAL_SEC} 秒以上を指定してください`);
          cfg.google.intervalSec = sec;
        },
        auto: () => {
          if (!['on', 'off'].includes(value)) throw new Error('使い方: bh config auto on | off');
          cfg.autoAnalyze = { ...cfg.autoAnalyze, enabled: value === 'on' };
        },
        'auto-points': () => {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) throw new Error('1 以上の整数を指定してください');
          cfg.autoAnalyze = { ...cfg.autoAnalyze, minPoints: n };
        },
        'auto-hours': () => {
          const h = Number(value);
          if (!Number.isFinite(h) || h <= 0) throw new Error('0 より大きい時間を指定してください');
          cfg.autoAnalyze = { ...cfg.autoAnalyze, maxHours: h };
        },
      };
      if (!setters[key]) throw new Error(`不明な設定: ${key}`);
      setters[key]();
      await store.saveConfig(cfg);
      console.log(`${key} を設定しました`);
      break;
    }
    default:
      console.log(HELP);
  }
}

function progressPrinter() {
  let last = '';
  return ({ message, done, total }) => {
    const line = total > 1 && !/\d+\/\d+/.test(message) ? `${message} ${done}/${total}` : message;
    if (line === last) return;
    last = line;
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${line}`);
    else console.log(line);
  };
}

function printRecommendations(analysis) {
  if (analysis.recommendationNote) console.log(`\n! ${analysis.recommendationNote}`);
  if (!analysis.recommendations?.length) return;
  console.log('\n■ おすすめの本（✓ = 書誌データベースで実在を確認 / ? = 見つからず）');
  for (const r of analysis.recommendations) {
    const mark = r.verified ? '✓' : r.verified === false ? '?' : ' ';
    console.log(` ${mark} ${r.title}${r.author ? ' — ' + r.author : ''}${r.verified?.publishedDate ? `（${String(r.verified.publishedDate).slice(0, 4)}）` : ''}\n     ${r.reason}`);
  }
}

main().catch((e) => {
  console.error(`エラー: ${e.message}`);
  process.exit(1);
});

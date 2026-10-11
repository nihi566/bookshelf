// bh update: マージした main を PC の常駐 bh serve に反映する
//
//   1. data/ の library.json・analysis.json を時刻つきの名前で退避（コピー。元は変えない）
//   2. リポジトリで git pull --ff-only origin main（失敗したらここで止め、常駐は止めない）
//   3. 設定のポートで待ち受けている bh serve を止める（bh serve 以外が使っていたら何も止めない）
//   4. 起動し直す（Windows でタスク「book-highlights bh serve」があればそれを、無ければ切り離して起動）
//   5. 止めた後に起動したサーバが応答し、起動時に読んだ版（/api/info の server.version。古いサーバなら /sw.js の版）がディスクの web/sw.js と同じかを確かめる
//      （確かめられなければ、理由に続けて data/serve.log の末尾を出す）
//   3〜5 で失敗したら、bh serve が待ち受けていなければ 4 と同じ経路で起動し直してから失敗にする（常駐を止めたまま残さない）

import { execFile, spawn } from 'node:child_process';
import { copyFile, open, readFile } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import path from 'node:path';
import { swVersion } from '../web/core/serve-version.js';

export { swVersion };

// この PC の常駐（タスク スケジューラ）。docs/setup.md の「常駐させる」
export const SERVE_TASK = 'book-highlights bh serve';
const BACKUP_FILES = ['library.json', 'analysis.json'];
const DEFAULT_WAIT_MS = 30_000;
const STOP_WAIT_MS = 10_000;
const POLL_MS = 500;
const COMMAND_TIMEOUT_MS = 120_000;
// 起動の確認に失敗したとき、理由に続けて出す data/serve.log の末尾（追記され続けるので後ろから少しだけ読む）
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;

/** 退避ファイル名に使う時刻（PC の時刻で YYYYMMDD-HHMMSS） */
export function backupStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** library.json・analysis.json を <名前>.backup-<時刻>-before-update.json にコピーし、作ったファイル名を返す（無いファイルは飛ばす） */
export async function backupData(dataDir, stamp) {
  const made = [];
  for (const name of BACKUP_FILES) {
    const to = `${path.basename(name, '.json')}.backup-${stamp}-before-update.json`;
    try {
      await copyFile(path.join(dataDir, name), path.join(dataDir, to));
      made.push(to);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`${name} を退避できませんでした: ${e.message}`);
    }
  }
  return made;
}

/** プロセスのコマンドラインが bh serve か（bh update 自身やほかの node は止めない） */
export function isServeCommand(cmdline) {
  return /(^|[\\/\s"'])bh\.js["']?\s+serve(\s|$)/.test(String(cmdline || ''));
}

/** main で git pull --ff-only origin main し、前後のコミットと取り込んだコミットの一覧を返す */
export async function pullMain({ repoDir, run }) {
  const git = async (...args) => String(await run('git', args, { cwd: repoDir })).trim();
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`${repoDir} のブランチが main ではありません（${branch}）。main に切り替えてから実行してください`);
  const before = await git('rev-parse', '--short', 'HEAD');
  try {
    await git('pull', '--ff-only', 'origin', 'main');
  } catch (e) {
    throw new Error(`main を取り込めませんでした。常駐の bh serve は止めていません: ${e.message}`);
  }
  const after = await git('rev-parse', '--short', 'HEAD');
  const log = before === after ? [] : (await git('log', '--oneline', `${before}..${after}`)).split('\n').filter(Boolean);
  return { before, after, log };
}

/** ポートで待ち受けているプロセス（[{ pid, cmd }]） */
export async function listeners({ platform, port, run = execRun }) {
  let out = '';
  try {
    // 待ち受けが無いと Get-NetTCPConnection は SilentlyContinue でも終了コードを 1 にするので、最後に exit 0 で「該当なし」を成功にする
    out = platform === 'win32'
      ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; foreach ($i in (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) { "$i\`t$((Get-CimInstance Win32_Process -Filter "ProcessId=$i").CommandLine)" }; exit 0`])
      : await run('sh', ['-c', `for p in $(lsof -nP -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null); do printf '%s\\t%s\\n' "$p" "$(ps -o args= -p "$p")"; done`]);
  } catch (e) {
    throw new Error(`ポート ${port} を使っているプロセスを調べられませんでした: ${e.message}`);
  }
  return String(out).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    return { pid: Number(tab < 0 ? l : l.slice(0, tab)), cmd: tab < 0 ? '' : l.slice(tab + 1) };
  }).filter((l) => Number.isInteger(l.pid) && l.pid > 0);
}

/** ポートで待ち受けている bh serve を調べる（bh serve と確かめられないプロセスがあれば、何も止めずに失敗にする） */
async function findServe({ platform, port, run }) {
  const found = await listeners({ platform, port, run });
  const others = found.filter((l) => !isServeCommand(l.cmd));
  if (others.length) {
    const what = others.map((l) => `PID ${l.pid}${l.cmd ? '' : '（コマンドラインを読めませんでした）'}`).join(', ');
    throw new Error(`ポート ${port} を bh serve と確かめられないプロセスが使っています（${what}）。何も止めずに終わります`);
  }
  return found;
}

async function stopServe(found, { platform, port, run, kill, sleep, now, log }) {
  if (!found.length) {
    log(`止める: ポート ${port} で動いている bh serve はありませんでした（別のポートで動かしているなら、bh config port で合わせてください）`);
    return;
  }
  for (const l of found) {
    try {
      kill(l.pid);
    } catch (e) {
      // 調べてから止めるまでのあいだに終わっていたなら、止まっているのでそのまま進む
      if (e?.code === 'ESRCH') continue;
      throw new Error(`bh serve（PID ${l.pid}）を止められませんでした: ${e.message}（main は取り込み済み）`);
    }
  }
  log(`止める: bh serve（PID ${found.map((l) => l.pid).join(', ')}）`);
  const deadline = now().getTime() + STOP_WAIT_MS;
  while ((await listeners({ platform, port, run })).length) {
    if (now().getTime() > deadline) throw new Error(`bh serve を止めたあとも、ポート ${port} が空きませんでした`);
    await sleep(POLL_MS);
  }
}

async function hasTask(run) {
  try {
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-ScheduledTask -TaskName '${SERVE_TASK}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName`]);
    return String(out).trim() === SERVE_TASK;
  } catch {
    return false;
  }
}

/** bh serve を切り離して起動する（出力は data/serve.log に足す） */
function spawnDetached(repoDir, dataDir) {
  const out = openSync(path.join(dataDir, 'serve.log'), 'a');
  const child = spawn(process.execPath, [path.join(repoDir, 'cli/bh.js'), 'serve'], { cwd: repoDir, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  // 起動できなかったときは、確認の段階（応答が無い）で理由と一緒に知らせる。ここで落とさない
  child.on('error', (e) => console.error(`bh serve を起動できませんでした: ${e.message}`));
  child.unref();
  closeSync(out);
}

async function startServe({ platform, run, repoDir, dataDir, spawnServe, log }) {
  if (platform === 'win32' && (await hasTask(run))) {
    // node を止めればタスクは終わるが、念のため止めてから起動する（動いている間の起動は何もしないため）
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName '${SERVE_TASK}'; Start-ScheduledTask -TaskName '${SERVE_TASK}'`]);
    log(`起動: タスク「${SERVE_TASK}」`);
    return 'task';
  }
  (spawnServe || (() => spawnDetached(repoDir, dataDir)))();
  log(`起動: node cli/bh.js serve（出力は ${path.join(dataDir, 'serve.log')}）`);
  return 'spawn';
}

/** data/serve.log の末尾の行（無い・空・読めないときは空の配列） */
async function serveLogTail(dataDir) {
  let fh;
  try {
    fh = await open(path.join(dataDir, 'serve.log'), 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split(/\r?\n/);
    // 途中から読んだなら、先頭の行は欠けているので捨てる
    if (length < size) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines.some((l) => l.trim()) ? lines.slice(-LOG_TAIL_LINES) : [];
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

function baseUrl(cfg) {
  const h = !cfg.host || ['0.0.0.0', '::'].includes(cfg.host) ? '127.0.0.1' : cfg.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${cfg.port}`;
}

/** 止めた後に起動したサーバが応答し、起動時に読んだ版（古いサーバなら配っている sw.js の版）がディスクのものと同じかを確かめる */
async function verifyServe({ cfg, repoDir, fetchFn, stoppedAt, waitMs, sleep, now }) {
  const base = baseUrl(cfg);
  const headers = cfg.token ? { 'X-BH-Token': cfg.token } : {};
  const expected = swVersion(await readFile(path.join(repoDir, 'web/sw.js'), 'utf8'));
  const deadline = now().getTime() + waitMs;
  let reason = '応答がありません';
  for (;;) {
    try {
      const res = await fetchFn(`${base}/api/info`, { headers, signal: AbortSignal.timeout(2000) });
      if (!res.ok) reason = `/api/info が ${res.status} を返しました`;
      else {
        const info = await res.json();
        const started = Date.parse(info.server?.startedAt);
        if (!(started >= stoppedAt)) reason = '止める前に起動したサーバ（古いコード）が応答しています';
        else {
          // 新しく起動したサーバが違う版なら、待っても変わらないのですぐ失敗にする
          const running = info.server.version;
          if (running) {
            // 起動時に読んだ版（NIH-80）。/sw.js は毎回ディスクから読むので、動いているコードの版はこちらでしか分からない
            if (running !== expected) return { mismatch: `サーバの版（${running}）がディスクの版（${expected}）と違います` };
            return { version: running, startedAt: info.server.startedAt };
          }
          // server.version を返さない古いサーバは、配っている sw.js で比べる
          const sw = await fetchFn(`${base}/sw.js`, { signal: AbortSignal.timeout(2000) });
          const version = sw.ok ? swVersion(await sw.text()) : '';
          if (version !== expected) return { mismatch: `サーバの sw.js の版（${version || `不明・${sw.status}`}）がディスクの版（${expected}）と違います` };
          return { version, startedAt: info.server.startedAt };
        }
      }
    } catch (e) {
      reason = e.message;
    }
    if (now().getTime() >= deadline) throw new Error(`${base} が ${Math.round(waitMs / 1000)} 秒以内に新しいコードで応答しませんでした（${reason}）。data/serve.log を確かめてください`);
    await sleep(POLL_MS);
  }
}

/** 版を問わず、サーバが /api/info に応答するまで待つ（起動し直したときの確認） */
async function waitResponding({ cfg, fetchFn, waitMs, sleep, now }) {
  const base = baseUrl(cfg);
  const headers = cfg.token ? { 'X-BH-Token': cfg.token } : {};
  const deadline = now().getTime() + waitMs;
  let reason = '応答がありません';
  for (;;) {
    try {
      const res = await fetchFn(`${base}/api/info`, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      reason = `/api/info が ${res.status} を返しました`;
    } catch (e) {
      reason = e.message;
    }
    if (now().getTime() >= deadline) throw new Error(`${base} が ${Math.round(waitMs / 1000)} 秒以内に応答しませんでした: ${reason}`);
    await sleep(POLL_MS);
  }
}

function manualStartHint(platform) {
  const plain = 'リポジトリで node cli/bh.js serve';
  return platform === 'win32' ? `PowerShell で Start-ScheduledTask -TaskName '${SERVE_TASK}'（タスクが無ければ ${plain}）` : plain;
}

/**
 * 止めた後の段階で失敗したとき、常駐が止まったまま残らないようにする（NIH-147）。
 * bh serve がまだ待ち受けていれば何もしない。いなければ同じ経路で起動し直し、応答を待つ。結果の文面を返す（ここでは投げない）
 */
async function recoverServe(ctx) {
  const { platform, port, run } = ctx;
  try {
    const running = (await listeners({ platform, port, run })).filter((l) => isServeCommand(l.cmd));
    if (running.length) return `bh serve は動いています（PID ${running.map((l) => l.pid).join(', ')}）。起動し直していません`;
  } catch {
    // 調べられなければ、止まっているものとして起動し直す（動いていれば、起動した側がポートを取れずに終わるだけ）
  }
  try {
    const how = await startServe(ctx);
    await waitResponding({ ...ctx, cfg: { ...ctx.cfg, port } });
    return `bh serve を起動し直しました（${how === 'task' ? `タスク「${SERVE_TASK}」` : 'node cli/bh.js serve'}）`;
  } catch (e) {
    return `bh serve を起動し直せませんでした（${e.message}）。手で起動してください: ${manualStartHint(platform)}`;
  }
}

/**
 * 既定の外部コマンドの実行（標準出力を返す。失敗したら標準エラーを理由にして投げる）。
 * git が資格情報を尋ねて止まったままにならないよう、尋ねさせず、時間を区切る
 */
function execRun(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/**
 * 1〜5 をこの順に行う。外部コマンド（run）・fetch・プロセスの停止・時計は差し替えられる（テスト用）
 * @returns {Promise<{ backups: string[], commits: { before: string, after: string, log: string[] }, started: 'task'|'spawn', version: string, startedAt: string }>}
 */
export async function runUpdate({
  repoDir, dataDir, cfg,
  platform = process.platform,
  run = execRun,
  fetchFn = fetch,
  kill = (pid) => process.kill(pid),
  spawnServe,
  now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  waitMs = DEFAULT_WAIT_MS,
  log = console.log,
}) {
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ポートの設定が正しくありません: ${cfg.port}`);

  const backups = await backupData(dataDir, backupStamp(now()));
  log(`退避: ${backups.length ? backups.map((b) => path.join(dataDir, b)).join('、') : '（退避するファイルがありませんでした）'}`);

  const commits = await pullMain({ repoDir, run });
  log(commits.log.length ? `取り込み: ${commits.before} → ${commits.after}（${commits.log.length} 件）` : `取り込み: 新しいコミットはありませんでした（${commits.after}）`);
  for (const l of commits.log) log(`  ${l}`);

  const ctx = { platform, port, run, kill, sleep, now, log, repoDir, dataDir, spawnServe, cfg, fetchFn, waitMs };
  const found = await findServe(ctx);
  try {
    await stopServe(found, ctx);
    const stoppedAt = now().getTime();
    const started = await startServe(ctx);

    let result;
    try {
      result = await verifyServe({ ...ctx, cfg: { ...cfg, port }, stoppedAt });
    } catch (e) {
      result = { mismatch: e.message };
    }
    const { version, startedAt, mismatch } = result;
    if (mismatch) {
      // 起動時の例外・ポート競合などの原因は、たいていログの末尾にある
      const tail = await serveLogTail(dataDir);
      throw new Error(tail.length ? `${mismatch}\n--- ${path.join(dataDir, 'serve.log')} の末尾 ${tail.length} 行 ---\n${tail.join('\n')}` : mismatch);
    }
    log(`確認: 新しいコードで動いています（版 ${version}・起動 ${startedAt}）`);
    return { backups, commits, started, version, startedAt };
  } catch (e) {
    throw new Error(`${e.message}\n${await recoverServe(ctx)}`);
  }
}

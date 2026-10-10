import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { SERVE_TASK, backupData, backupStamp, isServeCommand, runUpdate, swVersion } from '../cli/update.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const SW = "const CACHE = 'bh-v42';\n";

test('bh update: 退避のファイル名は時刻つきで、元のファイルは変えない', async () => {
  const dir = tmp('bh-upd-');
  writeFileSync(path.join(dir, 'library.json'), '{"a":1}');
  const names = await backupData(dir, '20261010-093005');
  assert.deepEqual(names, ['library.backup-20261010-093005-before-update.json']);
  assert.equal(readFileSync(path.join(dir, names[0]), 'utf8'), '{"a":1}');
  assert.equal(readFileSync(path.join(dir, 'library.json'), 'utf8'), '{"a":1}');
  assert.equal(backupStamp(new Date(2026, 9, 10, 9, 30, 5)), '20261010-093005');
});

test('bh update: 止める対象は bh.js serve だけ（ほかの node や bh update 自身は止めない）', () => {
  assert.equal(isServeCommand('"C:\\Program Files\\nodejs\\node.exe"  cli\\bh.js serve '), true);
  assert.equal(isServeCommand('node /home/u/bookshelf/cli/bh.js serve --port 8787'), true);
  assert.equal(isServeCommand('node bh.js serve'), true);
  assert.equal(isServeCommand('node cli/bh.js update'), false);
  assert.equal(isServeCommand('node cli/other-bh.js serve'), false);
  assert.equal(isServeCommand('node C:\\dev\\local-server-hub\\scripts\\start.mjs'), false);
  assert.equal(isServeCommand(''), false);
  assert.equal(swVersion(SW), 'bh-v42');
  assert.equal(swVersion('nothing'), '');
});

/** 外部コマンドの偽物。呼ばれた順に記録し、handlers の最初に合うもので答える */
function fakeRun(handlers) {
  const calls = [];
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [re, out] of handlers) if (re.test(line)) return typeof out === 'function' ? out(line) : out;
    return '';
  };
  return { run, calls };
}

/**
 * 偽の PC。サーバは「起動」されるまで応答せず（接続できない）、起動した時刻を startedAt として返す。
 * oldServer なら起動しても止める前の時刻を返し続ける（古いコードのまま）
 */
function setup({ pullFails = false, listeners = [{ pid: 111, cmd: 'node cli\\bh.js serve' }], oldServer = false, servedSw = SW } = {}) {
  const repoDir = tmp('bh-repo-');
  const dataDir = path.join(repoDir, 'data');
  mkdirSync(path.join(repoDir, 'web'), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(path.join(repoDir, 'web/sw.js'), SW);
  writeFileSync(path.join(dataDir, 'library.json'), '{}');
  writeFileSync(path.join(dataDir, 'analysis.json'), '{}');
  let alive = [...listeners];
  const killed = [];
  const events = [];
  let clock = Date.parse('2026-10-10T00:00:00Z');
  let serverStartedAt = null;
  const startServer = () => {
    events.push('start');
    serverStartedAt = oldServer ? '2026-01-01T00:00:00Z' : new Date(clock).toISOString();
  };
  const { run, calls } = fakeRun([
    [/rev-parse --abbrev-ref HEAD/, 'main\n'],
    [/rev-parse --short HEAD/, (() => { let n = 0; return () => (n++ === 0 ? 'aaa1111\n' : 'bbb2222\n'); })()],
    [/pull --ff-only origin main/, () => {
      // 取り込む時点で、退避は済んでいる
      events.push(`pull:backups=${readdirSync(dataDir).filter((f) => f.includes('before-update')).length}`);
      if (pullFails) throw new Error('fatal: Not possible to fast-forward');
      return '';
    }],
    [/log --oneline/, 'bbb2222 feat: 新しい機能\n'],
    [/Get-NetTCPConnection/, () => alive.map((l) => `${l.pid}\t${l.cmd}`).join('\n')],
    [/Get-ScheduledTask/, `${SERVE_TASK}\n`],
    [/Start-ScheduledTask/, () => { startServer(); return ''; }],
  ]);
  const fetchFn = async (url) => {
    if (!serverStartedAt) throw new TypeError('fetch failed');
    if (url.endsWith('/api/info')) return new Response(JSON.stringify({ app: 'book-highlights', server: { startedAt: serverStartedAt } }));
    if (url.endsWith('/sw.js')) return new Response(servedSw);
    return new Response('', { status: 404 });
  };
  const opts = {
    repoDir,
    dataDir,
    cfg: { port: 8787, host: '127.0.0.1', token: '' },
    platform: 'win32',
    run,
    fetchFn,
    kill: (pid) => {
      events.push(`kill:${pid}`);
      killed.push(pid);
      alive = alive.filter((l) => l.pid !== pid);
    },
    now: () => new Date(clock),
    sleep: async (ms) => { clock += ms; },
    log: () => {},
  };
  return { opts, calls, killed, events, dataDir, startServer };
}

test('bh update: 退避 → 取り込み → 止める → タスク起動 → 新しい版を確かめる', async () => {
  const { opts, calls, killed, events, dataDir } = setup();
  const r = await runUpdate(opts);
  assert.equal(r.backups.length, 2);
  for (const b of r.backups) assert.ok(existsSync(path.join(dataDir, b)), b);
  assert.deepEqual(r.commits, { before: 'aaa1111', after: 'bbb2222', log: ['bbb2222 feat: 新しい機能'] });
  assert.deepEqual(killed, [111]);
  assert.ok(calls.some((c) => c.includes('Start-ScheduledTask') && c.includes(SERVE_TASK)), calls.join('\n'));
  assert.equal(r.version, 'bh-v42');
  assert.equal(r.started, 'task');
  // 退避してから取り込み、止めてから起動する
  assert.deepEqual(events, ['pull:backups=2', 'kill:111', 'start']);
});

test('bh update: 取り込みに失敗したら常駐を止めずに終わる', async () => {
  const { opts, calls, killed } = setup({ pullFails: true });
  await assert.rejects(runUpdate(opts), /取り込めませんでした.*fast-forward/s);
  assert.deepEqual(killed, []);
  assert.ok(!calls.some((c) => c.includes('Start-ScheduledTask')));
});

test('bh update: ポートを bh serve 以外が使っていたら何も止めずに終わる', async () => {
  const { opts, killed } = setup({ listeners: [{ pid: 222, cmd: 'python -m http.server 8787' }] });
  await assert.rejects(runUpdate(opts), /bh serve と確かめられないプロセス.*222/);
  assert.deepEqual(killed, []);
});

test('bh update: コマンドラインを読めないプロセスは止めず、読めなかったと伝える', async () => {
  const { opts, killed } = setup({ listeners: [{ pid: 333, cmd: '' }] });
  await assert.rejects(runUpdate(opts), /PID 333（コマンドラインを読めませんでした）/);
  assert.deepEqual(killed, []);
});

test('bh update: 止める前にプロセスが終わっていても（ESRCH）先へ進む', async () => {
  const { opts, events } = setup();
  const kill = (pid) => {
    opts.kill(pid);
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  };
  const r = await runUpdate({ ...opts, kill });
  assert.equal(r.version, 'bh-v42');
  assert.deepEqual(events.slice(-2), ['kill:111', 'start']);
});

test('bh update: 止められなければ（EPERM）起動せずに理由を出す', async () => {
  const { opts, events } = setup();
  const kill = () => { throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' }); };
  await assert.rejects(runUpdate({ ...opts, kill }), /PID 111.*止められませんでした.*EPERM/);
  assert.ok(!events.includes('start'));
});

test('bh update: 起動したサーバが止める前のもの（古いコード）なら失敗にする', async () => {
  const { opts } = setup({ oldServer: true });
  await assert.rejects(runUpdate({ ...opts, waitMs: 3000 }), /新しいコードで応答しませんでした（止める前に起動したサーバ/);
});

test('bh update: 起動したサーバの sw.js の版がディスクと違えば失敗にする', async () => {
  const { opts } = setup({ servedSw: "const CACHE = 'bh-v41';\n" });
  await assert.rejects(runUpdate(opts), /sw\.js の版（bh-v41）がディスクの版（bh-v42）と違います/);
});

test('bh update: main 以外のブランチでは取り込まない', async () => {
  const { opts, calls, killed } = setup();
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    return /abbrev-ref/.test(line) ? 'feature/x\n' : opts.run(cmd, args);
  };
  await assert.rejects(runUpdate({ ...opts, run }), /main ではありません.*feature\/x/);
  assert.ok(!calls.some((c) => c.includes('pull')));
  assert.deepEqual(killed, []);
});

test('bh update: タスクが無い PC では bh serve を切り離して起動する', async () => {
  const { opts, calls, startServer } = setup();
  const run = async (cmd, args) => ([cmd, ...args].join(' ').includes('Get-ScheduledTask') ? '' : opts.run(cmd, args));
  const r = await runUpdate({ ...opts, run, spawnServe: startServer });
  assert.equal(r.started, 'spawn');
  assert.equal(r.version, 'bh-v42');
  assert.ok(!calls.some((c) => c.includes('Start-ScheduledTask')));
});

test('/api/info: そのサーバの起動時刻を返す（問い合わせのたびの時刻ではない）', async () => {
  const store = createStore(tmp('bh-data-'));
  const before = Date.now();
  const server = createCompanionServer({ store, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const info = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/info`)).json()).server.startedAt;
    const first = await info();
    assert.ok(Date.parse(first) >= before - 1000, first);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await info(), first);
  } finally {
    server.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { REPO_ROOT } from '../cli/store.js';
import { STALE_SERVE, serveVersionCheck, swVersion } from '../web/core/serve-version.js';

const server = (o = {}) => ({ startedAt: '2026-10-11T01:02:03.000Z', version: 'bh-v25', diskVersion: 'bh-v25', ...o });

test('PC の bh serve の版: 画面・ディスクと同じ版なら古くない', () => {
  const r = serveVersionCheck({ appVersion: 'bh-v25', server: server() });
  assert.equal(r.version, 'bh-v25');
  assert.equal(r.startedAt, '2026-10-11T01:02:03.000Z');
  assert.equal(r.warning, '');
});

test('PC の bh serve の版: 画面より古い版で動いていれば bh update を促す', () => {
  const r = serveVersionCheck({ appVersion: 'bh-v26', server: server({ diskVersion: 'bh-v26' }) });
  assert.equal(r.warning, STALE_SERVE);
  assert.match(STALE_SERVE, /PC の bh serve が古いコードで動いています（PC で bh update）/);
  // 版の数が 2 桁から 3 桁になっても数で比べる
  assert.equal(serveVersionCheck({ appVersion: 'bh-v100', server: server({ version: 'bh-v99', diskVersion: 'bh-v99' }) }).warning, STALE_SERVE);
});

test('PC の bh serve の版: ディスクの版より古い版で動いていれば、画面の版が分からなくても促す', () => {
  assert.equal(serveVersionCheck({ appVersion: '', server: server({ diskVersion: 'bh-v26' }) }).warning, STALE_SERVE);
});

test('PC の bh serve の版: 版を返さない古い bh serve も古いコードとして促す', () => {
  const r = serveVersionCheck({ appVersion: 'bh-v25', server: { startedAt: '2026-10-11T01:02:03.000Z' } });
  assert.equal(r.version, '');
  assert.equal(r.warning, STALE_SERVE);
  assert.equal(serveVersionCheck({ appVersion: 'bh-v25', server: undefined }).warning, STALE_SERVE);
});

test('PC の bh serve の版: PC の方が新しい（画面の公開待ち）ときは bh update を促さない', () => {
  const r = serveVersionCheck({ appVersion: 'bh-v24', server: server() });
  assert.notEqual(r.warning, STALE_SERVE);
  assert.match(r.warning, /この画面の方が古い版/);
});

test('PC の bh serve の版: 画面の版が読めないとき、ディスクと同じなら何も言わない', () => {
  assert.equal(serveVersionCheck({ appVersion: '', server: server() }).warning, '');
});

test('sw.js の版を読む', () => {
  assert.equal(swVersion("const CACHE = 'bh-v42';"), 'bh-v42');
  assert.equal(swVersion('nothing'), '');
});

test('コンパニオンサーバ: /api/info が起動時の版とディスクの版を返す', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-data-')));
  const srv = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response('{}') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const info = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/info`)).json();
    const disk = swVersion(await readFile(path.join(REPO_ROOT, 'web/sw.js'), 'utf8'));
    assert.match(disk, /^bh-v\d+$/);
    assert.equal(info.server.version, disk);
    assert.equal(info.server.diskVersion, disk);
    assert.ok(Date.parse(info.server.startedAt));
  } finally {
    srv.close();
  }
});

test('接続を確認: 起動時刻と版を出し、古いコードなら警告を出す', async () => {
  const { serveVersionBlock } = await import('../web/js/ui.js');
  const ok = String(serveVersionBlock(server(), 'bh-v25'));
  assert.match(ok, /PC の bh serve: 起動 \d+\/\d+ \d+:\d+・版 bh-v25/);
  assert.doesNotMatch(ok, /notice err/);
  const stale = String(serveVersionBlock(server(), 'bh-v26'));
  assert.match(stale, /この画面の版 bh-v26/);
  assert.match(stale, /notice err">PC の bh serve が古いコードで動いています（PC で bh update）/);
  // 版も時刻も返さない古い bh serve
  assert.match(String(serveVersionBlock(undefined, 'bh-v26')), /起動 不明・版 不明/);
});

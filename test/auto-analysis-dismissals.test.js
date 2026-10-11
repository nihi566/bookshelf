// NIH-210: 線・面を消した・戻した日も、自動の分析が始まる（立体・おすすめを、消した面を前提にした文のまま残さない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { autoAnalyzeDue, dismissalsChanged, dismissalsKey } from '../web/core/auto-analysis.js';
import { dismiss, undoDismiss } from '../web/core/dismissals.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test/fixtures', name);
const pts = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }));
const NOW = new Date('2026-10-04T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

// 前回の分析（4 点すべてが線に入っている = 増えた点は無い）
const analysisOf = (createdAt, lib) => ({
  createdAt,
  lines: [{ id: 'l1', name: '線1', highlightIds: ['h0', 'h1'] }, { id: 'l2', name: '線2', highlightIds: ['h2', 'h3'] }],
  planes: [{ id: 'p1', name: '面1', lineIds: ['l1', 'l2'] }],
  isolated: [],
  ...(lib ? { dismissalsKey: dismissalsKey(lib) } : {}),
});

test('NIH-210: 線・面を消した・戻したら dismissalsChanged が立ち、消して戻しただけなら立たない', () => {
  const lib = { dismissals: {} };
  const analysis = analysisOf(hoursAgo(25), lib);
  assert.equal(dismissalsChanged(lib, analysis), false, '分析したときのまま');

  dismiss(lib, analysis, 'plane', 'p1', hoursAgo(2));
  assert.equal(dismissalsChanged(lib, analysis), true, '面を消した');
  undoDismiss(lib, 'p1', hoursAgo(1));
  assert.equal(dismissalsChanged(lib, analysis), false, '消して戻しただけ（分析したときと同じ）');

  dismiss(lib, analysis, 'line', 'l2', hoursAgo(1));
  assert.equal(dismissalsChanged(lib, analysis), true, '線を消した');
  const after = analysisOf(hoursAgo(0.5), lib);
  assert.equal(dismissalsChanged(lib, after), false, '消したあとに分析した');
  undoDismiss(lib, 'l2', hoursAgo(0.1));
  assert.equal(dismissalsChanged(lib, after), true, '戻した（次の分析から、また作ってよい）');

  assert.equal(dismissalsChanged(lib, null), false, 'まだ分析していなければ点の数で決める');
});

test('NIH-210: 指紋を持たない古い分析は、分析より後に消した・戻した記録があるかで見る', () => {
  const lib = { dismissals: {} };
  const old = analysisOf(hoursAgo(25));
  dismiss(lib, old, 'plane', 'p1', hoursAgo(30));
  assert.equal(dismissalsChanged(lib, old), false, '分析より前に消した');
  dismiss(lib, old, 'line', 'l1', hoursAgo(2));
  assert.equal(dismissalsChanged(lib, old), true, '分析より後に消した');
});

test('NIH-210: 点が増えていなくても、消した線・面があれば前回から 24 時間たって分析を始める（それまでは待つと出す）', () => {
  const due = autoAnalyzeDue({ points: pts(4), analysis: analysisOf(hoursAgo(25), { dismissals: {} }), now: NOW, dismissalsChanged: true });
  assert.equal(due.due, true, due.reason);
  assert.match(due.reason, /線・面を消した・戻しました/);

  const wait = autoAnalyzeDue({ points: pts(4), analysis: analysisOf(hoursAgo(1), { dismissals: {} }), now: NOW, dismissalsChanged: true });
  assert.equal(wait.due, false);
  assert.match(wait.reason, /消した・戻した線・面は、前回から 24 時間たつと分析に入れます/);
  assert.equal(wait.nextAt, hoursAgo(-23), '始まる見込みの時刻');

  const both = autoAnalyzeDue({ points: pts(4), analysis: analysisOf(hoursAgo(1), { dismissals: {} }), now: NOW, dismissalsChanged: true, notesChanged: true });
  assert.match(both.reason, /書いた・直した永久ノートと、消した・戻した線・面は/);

  const none = autoAnalyzeDue({ points: pts(4), analysis: analysisOf(hoursAgo(25), { dismissals: {} }), now: NOW });
  assert.equal(none.due, false, '何も変わっていなければ始めない');
  assert.match(none.reason, /消した・戻した線・面もありません/);
});

test('NIH-210: bh serve は、面を消した翌日に自動で分析し直し、知識の画面に消した面を待っていると出せる', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-auto-dismiss-'));
  const fake = await startFakeLlm();
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' } });
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response(JSON.stringify({ items: [] })) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const waitJob = async () => {
    for (let i = 0; i < 200; i++) {
      const job = await (await fetch(`${base}/api/analyze`)).json();
      if (!job.running) return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('分析が終わらない');
  };
  try {
    const b64 = (await readFile(fixture('My Clippings.txt'))).toString('base64');
    await fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files: [{ name: 'My Clippings.txt', base64: b64 }] }) });
    assert.equal((await server.checkAutoAnalyze()).started, true);
    assert.equal((await waitJob()).stage, 'done');
    const first = await store.analysis();
    assert.equal(typeof first.dismissalsKey, 'string', '分析に消した線・面の指紋を残す');
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    assert.equal((await server.checkAutoAnalyze(tomorrow)).started, false, '点も消した線・面も変わっていなければ始めない');

    const lib = await store.library();
    dismiss(lib, first, 'plane', first.planes[0].id);
    await store.saveLibrary(lib);
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.autoAnalysis.dismissalsChanged, true, '知識の画面に、消した線・面を待っていることを出せる');
    assert.match(info.autoAnalysis.next.reason, /消した・戻した線・面は、前回から 24 時間たつと分析に入れます/);
    assert.equal((await server.checkAutoAnalyze()).started, false, '前回から 24 時間たつまでは待つ');
    const r = await server.checkAutoAnalyze(tomorrow);
    assert.equal(r.started, true, r.reason);
    assert.equal((await waitJob()).stage, 'done');
    const second = await store.analysis();
    assert.notEqual(second.createdAt, first.createdAt, '分析し直した');
    assert.notEqual(second.dismissalsKey, first.dismissalsKey, '消した面を外して分析し直した');
    assert.equal((await (await fetch(`${base}/api/info`)).json()).autoAnalysis.dismissalsChanged, false);
  } finally {
    server.close();
    await fake.close();
  }
});

test('NIH-210: 知識の画面に、消した線・面が次の分析で立体に届くと出る', async () => {
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  const au = { enabled: true, minPoints: 10, maxHours: 24, pending: 0, dismissalsChanged: true, next: { due: false, reason: '消した・戻した線・面は、前回から 24 時間たつと分析に入れます', nextAt: null } };
  const st = { library: { dismissals: {} }, analysis: null, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo: { autoAnalysis: au } };
  const out = String(autoStatusBlock(st));
  assert.match(out, /線・面を消した・戻したとき、PC が分析し直します/);
  assert.match(out, /次の自動の分析: 消した・戻した線・面は、前回から 24 時間たつと分析に入れます/);
  assert.match(out, /前回の分析のあとに消した・戻した線・面があります。次の分析で面・立体を作り直します。/);
  const quiet = String(autoStatusBlock({ ...st, pcInfo: { autoAnalysis: { ...au, dismissalsChanged: false } } }));
  assert.doesNotMatch(quiet, /消した・戻した線・面があります/);
});

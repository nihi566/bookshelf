// NIH-112: 知識の画面に、次の自動の分析がいつ・何を待って始まるかを出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { AUTO_RETRY_MS, autoAnalyzeDue } from '../web/core/auto-analysis.js';
import { emptyLibrary } from '../web/core/model.js';

const pts = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }));
const NOW = new Date('2026-10-04T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const iso = (ms) => new Date(ms).toISOString();
// 前回の分析（h0〜h3 が線に入っている）
const analysisAt = (createdAt) => ({ createdAt, lines: [{ highlightIds: ['h0', 'h1', 'h2', 'h3'] }], isolated: [] });

test('NIH-112: 点だけ待っているときは、あと何件か・前回から 24 時間たつ時刻を返す', () => {
  const r = autoAnalyzeDue({ points: pts(4 + 3), analysis: analysisAt(hoursAgo(5)), now: NOW });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'あと 7 件増える・減るか、前回から 24 時間たつと分析します');
  assert.equal(r.nextAt, iso(NOW - 5 * 3_600_000 + 24 * 3_600_000));
});

test('NIH-112: 永久ノートだけ待っているときは、前回から 24 時間たつ時刻を返す', () => {
  const r = autoAnalyzeDue({ points: pts(4), analysis: analysisAt(hoursAgo(1)), now: NOW, notesChanged: true });
  assert.equal(r.due, false);
  assert.equal(r.reason, '書いた・直した永久ノートは、前回から 24 時間たつと分析に入れます');
  assert.equal(r.nextAt, iso(NOW - 3_600_000 + 24 * 3_600_000));
});

test('NIH-112: 失敗のあとは、試し直す時刻を返す（そのあとも時間待ちなら、遅い方の時刻）', () => {
  const failedAt = NOW - AUTO_RETRY_MS / 2;
  // 条件は満たしている: 試し直す時刻
  const ready = autoAnalyzeDue({ points: pts(4 + 10), analysis: analysisAt(hoursAgo(1)), now: NOW, lastFailureAt: iso(failedAt) });
  assert.equal(ready.due, false);
  assert.equal(ready.reason, '前回の分析が失敗したので、少し待ってから試し直します');
  assert.equal(ready.nextAt, iso(failedAt + AUTO_RETRY_MS));
  // 1 件増えただけで前回から 1 時間: 24 時間たつ方が遅い
  const waiting = autoAnalyzeDue({ points: pts(4 + 1), analysis: analysisAt(hoursAgo(1)), now: NOW, lastFailureAt: iso(failedAt) });
  assert.equal(waiting.reason, '前回の分析が失敗したので、少し待ってから試し直します');
  assert.equal(waiting.nextAt, iso(NOW - 3_600_000 + 24 * 3_600_000));
  // 中止のあとも同じ
  const cancelled = autoAnalyzeDue({ points: pts(4 + 10), analysis: analysisAt(hoursAgo(1)), now: NOW, lastCancelledAt: iso(failedAt) });
  assert.equal(cancelled.reason, '分析を中止したので、少し待ってから始めます');
  assert.equal(cancelled.nextAt, iso(failedAt + AUTO_RETRY_MS));
});

test('NIH-112: 条件を満たしたとき・変化が無いときは、見込みの時刻を返さない', () => {
  assert.equal(autoAnalyzeDue({ points: pts(4 + 10), analysis: analysisAt(hoursAgo(1)), now: NOW }).nextAt, null);
  const none = autoAnalyzeDue({ points: pts(4), analysis: analysisAt(hoursAgo(1)), now: NOW });
  assert.equal(none.nextAt, null);
  assert.equal(autoAnalyzeDue({ points: pts(4 + 1), analysis: analysisAt(hoursAgo(1)), now: NOW, config: { enabled: false } }).nextAt, null);
});

test('NIH-112: /api/info の autoAnalysis.next に、今の判断の理由と見込みの時刻が入る', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-next-')));
  await store.saveConfig({ llm: { baseUrl: 'http://127.0.0.1:9', chatModel: 'fake-chat', embedModel: 'fake-embed' } });
  const server = createCompanionServer({ store, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const info = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/info`)).json()).autoAnalysis.next;
    assert.deepEqual(await info(), { due: false, reason: '点が 4 件未満です', nextAt: null });
    // 1 時間前の分析と、そのあとに増えた点 1 件
    const lib = emptyLibrary();
    lib.books.b1 = { id: 'b1', title: '本', author: '著者', source: 'kindle' };
    for (let i = 0; i < 5; i++) lib.highlights[`h${i}`] = { id: `h${i}`, bookId: 'b1', text: `線 ${i}`, createdAt: hoursAgo(2) };
    await store.saveLibrary(lib);
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    await store.saveAnalysis({ ...analysisAt(createdAt), version: 2, planes: [], stats: {} });
    const next = await info();
    assert.equal(next.due, false);
    assert.equal(next.reason, 'あと 9 件増える・減るか、前回から 24 時間たつと分析します');
    assert.equal(next.nextAt, new Date(Date.parse(createdAt) + 24 * 3_600_000).toISOString());
  } finally {
    server.close();
  }
});

test('NIH-112: 知識の画面の自動の分析の欄に、次の分析の一文が出る（オフ・PC につながっていないときは出さない）', async () => {
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  const st = (autoAnalysis, mode = 'companion') => ({ library: emptyLibrary(), analysis: null, settings: { ai: { mode, companionUrl: '' } }, pcInfo: autoAnalysis ? { autoAnalysis } : null });
  const au = { enabled: true, minPoints: 10, maxHours: 24, pending: 1, next: { due: false, reason: 'あと 9 件増える・減るか、前回から 24 時間たつと分析します', nextAt: '2026-10-05T11:00:00.000Z' } };
  const out = String(autoStatusBlock(st(au)));
  assert.match(out, /次の自動の分析: あと 9 件増える・減るか、前回から 24 時間たつと分析します（始まる見込み: 10\/5 \d\d:00）/);
  const due = String(autoStatusBlock(st({ ...au, next: { due: true, reason: '前回の分析のあとに点が 12 件増えました', nextAt: null } })));
  assert.match(due, /次の自動の分析: まもなく始めます（前回の分析のあとに点が 12 件増えました）/);
  assert.doesNotMatch(String(autoStatusBlock(st({ ...au, enabled: false }))), /次の自動の分析/, 'オフのときは出さない');
  assert.doesNotMatch(String(autoStatusBlock(st({ ...au, running: true }))), /次の自動の分析/, '分析の最中は出さない');
  assert.doesNotMatch(String(autoStatusBlock(st(null))), /次の自動の分析/, 'PC の情報が無いときは出さない');
  assert.doesNotMatch(String(autoStatusBlock(st(au, 'direct'))), /次の自動の分析/, 'PC につながっていないときは出さない');
});

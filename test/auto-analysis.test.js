// G5-1 自動の分析・G5-3 失敗しても前回の結果が残る・G5-4 履歴（PC に残し、最新の結果に変化を入れる）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStore, HISTORY_KEEP } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { AUTO_RETRY_MS, autoAnalyzeDue, pendingPoints, removedPoints } from '../web/core/auto-analysis.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test/fixtures', name);
const pts = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const NOW = new Date('2026-10-04T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test('G5-1: 前回の分析のあとに点が 10 件以上増えたとき、または 24 時間以上たって 1 件以上増えたときに始める', () => {
  const analysis = { createdAt: hoursAgo(1), lines: [{ highlightIds: ['h0', 'h1'] }], isolated: ['h2'] };
  assert.equal(pendingPoints(pts(5), analysis), 2);
  assert.equal(autoAnalyzeDue({ points: pts(3 + 9), analysis, now: NOW }).due, false, '9 件増えただけ・1 時間前');
  assert.equal(autoAnalyzeDue({ points: pts(3 + 10), analysis, now: NOW }).due, true, '10 件増えた');
  const old = { ...analysis, createdAt: hoursAgo(25) };
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis: old, now: NOW }).due, true, '24 時間以上たって 1 件増えた');
  assert.equal(autoAnalyzeDue({ points: pts(3), analysis: old, now: NOW }).due, false, '増えていなければ始めない');
  assert.equal(autoAnalyzeDue({ points: pts(20), analysis: null, now: NOW }).due, true, 'まだ一度も分析していない');
  assert.equal(autoAnalyzeDue({ points: pts(3), analysis: null, now: NOW }).due, false, '点が 4 件未満');
  // bh config で入切・件数・時間を変えられる
  assert.equal(autoAnalyzeDue({ points: pts(3 + 10), analysis, now: NOW, config: { enabled: false } }).due, false);
  assert.equal(autoAnalyzeDue({ points: pts(3 + 3), analysis, now: NOW, config: { minPoints: 3 } }).due, true);
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis, now: NOW, config: { maxHours: 0.5 } }).due, true);
  // 失敗したあとは少し待ってから試し直す
  assert.equal(autoAnalyzeDue({ points: pts(3 + 10), analysis, now: NOW, lastFailureAt: new Date(NOW - AUTO_RETRY_MS / 2).toISOString() }).due, false);
  assert.equal(autoAnalyzeDue({ points: pts(3 + 10), analysis, now: NOW, lastFailureAt: new Date(NOW - AUTO_RETRY_MS - 1000).toISOString() }).due, true);
});

test('NIH-107: 前回の分析に入っていた点が消えたときも、増えた点と同じ条件で始める', () => {
  const analysis = { createdAt: hoursAgo(1), lines: [{ highlightIds: pts(12).map((p) => p.id) }], isolated: ['h12', 'h13'] };
  assert.equal(removedPoints(pts(14), analysis), 0);
  assert.equal(removedPoints(pts(5), analysis), 9, '線の点もまだつながらない点も数える');
  assert.equal(removedPoints(pts(5), null), 0, '前回が無ければ消えた点も無い');
  // 増えた点が無くても、消えた点だけで条件を満たす（件数・時間の考え方は増えた点と同じ）
  const fewGone = autoAnalyzeDue({ points: pts(14).slice(1), analysis, now: NOW });
  assert.deepEqual([fewGone.due, fewGone.pending, fewGone.removed], [false, 0, 1], '1 件消えただけ・1 時間前');
  const manyGone = autoAnalyzeDue({ points: pts(4), analysis, now: NOW });
  assert.equal(manyGone.due, true, '10 件消えた');
  assert.equal(manyGone.removed, 10);
  assert.match(manyGone.reason, /10 件減りました/);
  const old = { ...analysis, createdAt: hoursAgo(25) };
  const oneGone = autoAnalyzeDue({ points: pts(14).slice(1), analysis: old, now: NOW });
  assert.equal(oneGone.due, true, '24 時間以上たって 1 件消えた');
  assert.match(oneGone.reason, /1 件減りました/);
  assert.equal(autoAnalyzeDue({ points: pts(14), analysis: old, now: NOW }).due, false, '増えも減りもしなければ始めない');
  // 増えた点と消えた点を合わせて数える（入れ替わりも変化）
  const swapped = [...pts(14).slice(5), ...pts(5, 'n')];
  const r = autoAnalyzeDue({ points: swapped, analysis, now: NOW });
  assert.deepEqual([r.due, r.pending, r.removed], [true, 5, 5]);
  assert.equal(autoAnalyzeDue({ points: pts(14).slice(1), analysis, now: NOW, config: { minPoints: 1 } }).due, true, 'bh config の件数にも従う');
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis, now: NOW, lastFailureAt: new Date(NOW - AUTO_RETRY_MS / 2).toISOString() }).due, false, '失敗の直後は待つ');
});

async function withServer(fn, { llmUrl, drive = null } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-auto-'));
  const fake = await startFakeLlm();
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: llmUrl || fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' } });
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response(JSON.stringify({ items: [] })), drive });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, server, fake, dataDir });
  } finally {
    server.close();
    await fake.close();
  }
}

const b64 = async (file) => (await readFile(file)).toString('base64');
const importFiles = (base, files) => fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files }) }).then((r) => r.json());
const notebook = (texts, title = '増えた本') => ({ name: 'kindle-auto.json', base64: Buffer.from(JSON.stringify({ format: 'book-highlights/kindle-notebook', version: 1, books: [{ asin: 'B0AUTO0001', title, author: '著者', highlights: texts.map((text) => ({ text })) }] })).toString('base64') });

async function waitJob(base) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${base}/api/analyze`)).json();
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('分析が終わらない');
}

test('G5-1: bh serve は取り込みのあと、人の操作なしに分析を始める（手動の分析中・取り込みの最中には始めない）', async () => {
  await withServer(async ({ base, server }) => {
    assert.equal((await server.checkAutoAnalyze()).started, false, '点が無い');
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
    const r1 = await server.checkAutoAnalyze();
    assert.equal(r1.started, true, r1.reason);
    const job = await waitJob(base);
    assert.equal(job.stage, 'done');
    assert.equal(job.trigger, 'auto');
    const first = await (await fetch(`${base}/api/analysis`)).json();
    assert.ok(first.lines.length > 0);
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.ok(info.autoAnalysis.lastSuccessAt);
    assert.equal(info.autoAnalysis.pending, 0);
    assert.deepEqual([info.autoAnalysis.enabled, info.autoAnalysis.minPoints, info.autoAnalysis.maxHours], [true, 10, 24]);
    assert.equal((await server.checkAutoAnalyze()).started, false, '増えていなければ始めない');

    // 9 件増えただけでは始めず、10 件で始める（増分の分析: 前回の線の ID を保つ）
    await importFiles(base, [notebook(Array.from({ length: 9 }, (_, i) => `新しく引いた線 その${i}`))]);
    assert.equal((await server.checkAutoAnalyze()).started, false);
    await importFiles(base, [notebook(Array.from({ length: 10 }, (_, i) => `新しく引いた線 その${i}`))]);
    // 手動の分析が走っている間は始めない
    await fetch(`${base}/api/analyze`, { method: 'POST', body: '{}' });
    assert.deepEqual(await server.checkAutoAnalyze(), { started: false, reason: '分析の最中です' });
    await waitJob(base);
  });
  // 画面・拡張からの取り込み（/api/import）を処理している最中は始めない
  // （ライブラリへの書き込みの順番待ちで止めておき、その間に確かめる。本文を受け取っている間は数えない: ゆっくり送り続ける接続で止め続けられないように）
  await withServer(async ({ base, server, store }) => {
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
    let release;
    const held = store.lock(() => new Promise((r) => (release = r)));
    const importing = importFiles(base, [notebook(['処理中に届いた線'])]);
    let busy;
    for (let i = 0; i < 100 && busy?.reason !== '取り込みの最中です'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      busy = await server.checkAutoAnalyze();
    }
    assert.deepEqual(busy, { started: false, reason: '取り込みの最中です' });
    release();
    await held;
    await importing;
    assert.equal((await server.checkAutoAnalyze()).started, true, '取り込みが終われば始める');
    await waitJob(base);
  });
  // Google ドライブからの取り込みの最中は始めない
  await withServer(
    async ({ base, server }) => {
      await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
      assert.deepEqual(await server.checkAutoAnalyze(), { started: false, reason: '取り込みの最中です' });
    },
    { drive: { status: { checking: true } } },
  );
});

test('NIH-107: 本を技術書にして点が減ると、bh serve は自動で分析し直し、消えた点を線から外す（分析のあとは始め直さない）', async () => {
  await withServer(async ({ base, server, store }) => {
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }, notebook(Array.from({ length: 6 }, (_, i) => `技術書にする本の線 その${i}`), '技術書にする本')]);
    assert.equal((await server.checkAutoAnalyze()).started, true);
    await waitJob(base);
    const lib = await store.library();
    const book = Object.values(lib.books).find((b) => b.title === '技術書にする本');
    const goneIds = Object.values(lib.highlights).filter((h) => h.bookId === book.id).map((h) => h.id);
    const before = await (await fetch(`${base}/api/analysis`)).json();
    const inBefore = new Set([...before.lines.flatMap((l) => l.highlightIds), ...before.isolated]);
    assert.ok(goneIds.every((id) => inBefore.has(id)), '前回の分析に入っている');

    await store.saveConfig({ ...(await store.config()), autoAnalyze: { minPoints: goneIds.length } });
    await store.saveLibrary({ ...lib, books: { ...lib.books, [book.id]: { ...book, technical: true } } });
    const r = await server.checkAutoAnalyze();
    assert.equal(r.started, true, r.reason);
    assert.equal(r.removed, goneIds.length);
    assert.equal(r.pending, 0);
    assert.equal((await waitJob(base)).stage, 'done');
    const after = await (await fetch(`${base}/api/analysis`)).json();
    const inAfter = new Set([...after.lines.flatMap((l) => l.highlightIds), ...after.isolated]);
    assert.ok(goneIds.every((id) => !inAfter.has(id)), '消えた点は線からも、まだつながらない点からも外れる');
    assert.equal((await server.checkAutoAnalyze()).started, false, '分析し直したあとは始め直さない');
  });
});

test('G5-1: bh config で自動の分析の入切・件数・時間を変えられる', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-auto-cli-'));
  const env = { ...process.env, BH_DATA: dataDir };
  const bh = (...a) => run('node', [path.join(ROOT, 'cli/bh.js'), ...a], { env });
  await bh('config', 'auto', 'off');
  await bh('config', 'auto-points', '3');
  await bh('config', 'auto-hours', '6');
  assert.deepEqual((await createStore(dataDir).config()).autoAnalyze, { enabled: false, minPoints: 3, maxHours: 6 });
  await assert.rejects(bh('config', 'auto', 'maybe'), /bh config auto on \| off/);
  await assert.rejects(bh('config', 'auto-points', '0'), /1 以上の整数/);
  assert.match((await bh('help')).stdout, /config auto on\|off/);
});

test('G5-3: 自動の分析が失敗しても前回の結果は残り、失敗の理由と最後に成功した時刻が分かる。次の機会に試し直す', async () => {
  const dead = 'http://127.0.0.1:9';
  await withServer(async ({ base, server, store }) => {
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
    await server.checkAutoAnalyze();
    await waitJob(base);
    const before = await store.analysis();
    const okAt = (await (await fetch(`${base}/api/info`)).json()).autoAnalysis.lastSuccessAt;
    // LLM が止まった状態で点が 10 件増える
    const cfg = await store.config();
    await store.saveConfig({ ...cfg, llm: { ...cfg.llm, baseUrl: dead } });
    await importFiles(base, [notebook(Array.from({ length: 10 }, (_, i) => `止まっている間に引いた線 ${i}`))]);
    assert.equal((await server.checkAutoAnalyze()).started, true);
    const job = await waitJob(base);
    assert.equal(job.stage, 'error');
    assert.equal((await store.analysis()).createdAt, before.createdAt, '前回の結果はそのまま');
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.match(info.autoAnalysis.lastError, /LLM サーバに接続できません/);
    assert.ok(info.autoAnalysis.lastErrorAt);
    assert.equal(info.autoAnalysis.lastSuccessAt, okAt);
    assert.equal(info.autoAnalysis.pending, 10);
    assert.equal(info.autoAnalysis.removed, 0, '消えた点の数も返す（NIH-135）');
    assert.equal(info.autoAnalysis.failureCount, 1, '続けて失敗した回数（NIH-53: ホームの警告に出す）');
    // すぐには試し直さないが、時間がたてば試し直す（LLM が戻っていなければ、続けて失敗した回数が増える）
    assert.equal((await server.checkAutoAnalyze()).started, false);
    const later = new Date(Date.now() + AUTO_RETRY_MS + 60_000);
    assert.equal((await server.checkAutoAnalyze(later)).started, true);
    assert.equal((await waitJob(base)).stage, 'error');
    assert.equal((await (await fetch(`${base}/api/info`)).json()).autoAnalysis.failureCount, 2);
    // LLM が戻っていれば成功し、回数は 0 に戻る
    await store.saveConfig(cfg);
    assert.equal((await server.checkAutoAnalyze(new Date(later.getTime() + AUTO_RETRY_MS + 60_000))).started, true);
    assert.equal((await waitJob(base)).stage, 'done');
    const after = await (await fetch(`${base}/api/info`)).json();
    assert.equal(after.autoAnalysis.lastError, '');
    assert.equal(after.autoAnalysis.failureCount, 0);
    assert.equal(after.autoAnalysis.pending, 0);
  });
});

test('G5-4: 分析の履歴を PC に直近 12 回分残す。最新の結果には前回からの変化が入る', async () => {
  await withServer(async ({ base, server, store }) => {
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
    await server.checkAutoAnalyze();
    await waitJob(base);
    await importFiles(base, [notebook(Array.from({ length: 10 }, (_, i) => `My Clippings の線を言い換えた ${i}`))]);
    await server.checkAutoAnalyze();
    await waitJob(base);
    const latest = await (await fetch(`${base}/api/analysis`)).json();
    assert.equal(latest.incremental, true);
    assert.ok(latest.changes && Array.isArray(latest.changes.connectedPoints));
    const { items } = await (await fetch(`${base}/api/history`)).json();
    assert.equal(items.length, 2);
    assert.ok(items[0].createdAt > items[1].createdAt, '新しい順');
    assert.equal(items[0].createdAt, latest.createdAt);
    assert.equal(typeof items[0].changes.connectedPoints, 'number');
    const past = await (await fetch(`${base}/api/history/${items[1].id}`)).json();
    assert.equal(past.createdAt, items[1].createdAt);
    assert.ok(Array.isArray(past.lines));
    assert.equal((await fetch(`${base}/api/history/20990101T000000000Z`)).status, 404);
    assert.equal((await fetch(`${base}/api/history/..%2F..%2Fconfig`)).status, 404);

    // 直近 12 回を超えた古い履歴は消す（おすすめだけ選び直したときは同じ回を差し替える）
    for (let i = 0; i < HISTORY_KEEP + 2; i++) await store.saveAnalysis({ ...latest, createdAt: new Date(Date.UTC(2030, 0, 1 + i)).toISOString() });
    const kept = await store.history();
    assert.equal(kept.length, HISTORY_KEEP);
    assert.equal(kept[0].createdAt, new Date(Date.UTC(2030, 0, HISTORY_KEEP + 2)).toISOString());
    await store.saveAnalysis({ ...latest, createdAt: kept[0].createdAt, recommendedAt: '2030-02-01T00:00:00.000Z' });
    assert.equal((await store.history()).length, HISTORY_KEEP);
    assert.equal((await store.history())[0].recommendedAt, '2030-02-01T00:00:00.000Z');
  });
});

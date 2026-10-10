// G5 のレビューで見つかった問題の再現テスト（同時保存・壊れた分析・中止・分析中の依頼・自動のおすすめ・作り直し・設定値）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HISTORY_KEEP } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { AUTO_RETRY_MS, autoAnalyzeDue, autoConfig, pendingPoints } from '../web/core/auto-analysis.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { analyzeLibrary } from '../web/core/analysis/pipeline.js';
import { applyImport } from '../web/core/importing.js';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test/fixtures', name);
const b64 = async (file) => (await readFile(file)).toString('base64');
const sampleFiles = async () => [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }];

function analysisAt(createdAt, extra = {}) {
  return { version: 2, createdAt, model: { chat: 'x', embed: 'tfidf' }, stats: { points: 1, lines: 0, planes: 0, isolated: 0 }, lines: [], planes: [], solid: { title: '', core: '' }, isolated: [], recommendations: [], ...extra };
}

/** 応答を返さない LLM（分析を途中で止めるため） */
async function hangingLlm() {
  const pending = [];
  const server = http.createServer((req, res) => pending.push(res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { pending.forEach((res) => res.destroy()); server.close(r); }) };
}

async function withServer(fn, { llmUrl } = {}) {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-review-')));
  const fake = await startFakeLlm();
  await store.saveConfig({ llm: { baseUrl: llmUrl || fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' } });
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response('{"items":[]}') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, server });
  } finally {
    server.close();
    await fake.close();
  }
}

const waitJob = async (base) => {
  for (let i = 0; i < 400; i++) {
    const job = await (await fetch(`${base}/api/analyze`)).json();
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('分析が終わらない');
};

test('履歴: 同時に保存しても一覧は欠けず、残すのは 12 回分（一覧から漏れたファイルも残さない）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bh-hist-'));
  const store = createStore(dir);
  const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.saveAnalysis(analysisAt(at(i)))));
  const index = await store.history();
  assert.equal(index.length, HISTORY_KEEP);
  assert.equal(index[0].createdAt, at(19));
  const files = readdirSync(path.join(dir, 'history')).filter((f) => f !== 'index.json');
  assert.equal(files.length, HISTORY_KEEP);
  assert.ok(!readdirSync(path.join(dir, 'history')).some((f) => f.endsWith('.tmp')), '一時ファイルを残さない');
});

test('履歴の一覧は、届いた値をそのまま写さない（長い文字列・数でない件数は持たない）', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-hist2-')));
  await store.saveAnalysis(analysisAt('2026-01-01T00:00:00.000Z', { model: { chat: 'x'.repeat(5000), embed: 1 }, stats: { points: 'many', lines: 3, junk: 'y'.repeat(5000) } }));
  const [h] = await store.history();
  assert.equal(h.model.chat.length, 80);
  assert.equal(h.model.embed, '');
  assert.deepEqual(h.stats, { points: null, thoughts: null, lines: 3, planes: null, isolated: null });
});

test('壊れた分析は受け取らない（PUT /api/analysis は 400・PC の状態は返し続ける・バックアップの分析は採らない）', async () => {
  assert.match(analysisShapeError({ lines: 5 }), /時刻/);
  assert.match(analysisShapeError(analysisAt('2026-01-01T00:00:00.000Z', { lines: [null] })), /線/);
  assert.match(analysisShapeError(analysisAt('2999-01-01T00:00:00.000Z')), /時刻/, '遠い未来の時刻は受け取らない');
  assert.equal(analysisShapeError(analysisAt('2026-01-01T00:00:00.000Z')), '');
  await withServer(async ({ base, store }) => {
    await fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files: await sampleFiles() }) });
    for (const bad of [{ lines: 5 }, { ...analysisAt('2026-01-01T00:00:00.000Z'), lines: [null] }, { ...analysisAt('2026-01-01T00:00:00.000Z'), isolated: 5 }]) {
      const r = await fetch(`${base}/api/analysis`, { method: 'PUT', body: JSON.stringify(bad) });
      assert.equal(r.status, 400);
      assert.match((await r.json()).error, /分析結果を保存できません/);
    }
    assert.equal(await store.analysis(), null);
    assert.equal((await fetch(`${base}/api/info`)).status, 200);
    assert.equal((await fetch(`${base}/api/analysis`, { method: 'PUT', body: JSON.stringify(analysisAt('2026-01-01T00:00:00.000Z')) })).status, 200);
  });
  const r = applyImport({ library: emptyLibrary(), analysis: null }, { backups: [{ library: emptyLibrary(), analysis: { createdAt: '2026-01-01T00:00:00.000Z', lines: 5 } }] });
  assert.equal(r.analysis, null);
  assert.equal(r.analysisChanged, false);
  // 壊れた分析が手元にあっても、件数の計算・前回の結果として使うところで落ちない
  assert.equal(pendingPoints([{ id: 'h1' }], { lines: 5, isolated: 'x' }), 1);
});

test('分析の最中（自動の分析を含む）に頼まれた分析は 409 で断る。利用者が止めた分析は「失敗」にせず、すぐには自動で始め直さない', async () => {
  const hang = await hangingLlm();
  try {
    await withServer(
      async ({ base, server }) => {
        await fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files: await sampleFiles() }) });
        assert.equal((await server.checkAutoAnalyze()).started, true);
        const busy = await fetch(`${base}/api/analyze`, { method: 'POST', body: JSON.stringify({ mode: 'full' }) });
        assert.equal(busy.status, 409);
        assert.match((await busy.json()).error, /PC が自動で分析をしています/);
        await fetch(`${base}/api/analyze`, { method: 'DELETE' });
        const job = await waitJob(base);
        assert.equal(job.stage, 'error');
        const info = await (await fetch(`${base}/api/info`)).json();
        assert.equal(info.autoAnalysis.lastError, '', '中止は失敗として出さない');
        assert.equal(info.autoAnalysis.failureCount, 0, '中止は続けて失敗した回数に数えない');
        assert.ok(info.autoAnalysis.lastCancelledAt);
        assert.equal((await server.checkAutoAnalyze()).started, false, '止めた直後は始め直さない');
        assert.equal((await server.checkAutoAnalyze(new Date(Date.now() + AUTO_RETRY_MS + 60_000))).started, true, '時間がたてば始める');
        await fetch(`${base}/api/analyze`, { method: 'DELETE' });
        await waitJob(base);
      },
      { llmUrl: hang.url },
    );
  } finally {
    await hang.close();
  }
});

test('LLM への依頼の前に中止されていたら、応答を待たずにすぐやめる（中止の合図は 1 回しか来ない）', async () => {
  const { createLlmClient } = await import('../web/core/analysis/llm.js');
  const hang = await hangingLlm();
  try {
    const llm = createLlmClient({ baseUrl: hang.url, chatModel: 'x', embedModel: 'y' });
    const ctrl = new AbortController();
    ctrl.abort();
    const started = Date.now();
    await assert.rejects(llm.embed(['a'], { signal: ctrl.signal }), /中止しました/);
    await assert.rejects(llm.chatJson({ system: 's', user: 'u', signal: ctrl.signal }), /中止しました/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    await hang.close();
  }
});

test('失敗の理由に URL のパスワードが入っていても、画面に出す前に伏せる', async () => {
  await withServer(
    async ({ base, server }) => {
      await fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files: await sampleFiles() }) });
      await server.checkAutoAnalyze();
      await waitJob(base);
      const info = await (await fetch(`${base}/api/info`)).json();
      assert.ok(info.autoAnalysis.lastError);
      assert.doesNotMatch(info.autoAnalysis.lastError, /s3cret/);
      assert.match(info.autoAnalysis.lastError, /\/\/\*\*\*@/);
    },
    { llmUrl: 'http://user:s3cret@127.0.0.1:9' },
  );
});

test('自動の分析（recommend: keep）は、立体が変わっても前回のおすすめを残す（欲しい本の印を知らずに選び直さない）', async () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const llm = { chatModel: 'stub', chatJson: async (p) => (p.name === 'line' ? { name: `線${Math.random()}`, summary: '', insight: '', keywords: [] } : p.name === 'plane' ? { name: `面${Math.random()}`, summary: '' } : { title: '核', core: '', relations: [], principles: [], questions: [] }) };
  const previous = { ...(await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis, recommendations: [{ title: '前に選んだ本', kind: 'deepen', reason: '理由' }], recommendedAt: '2026-01-01T00:00:00.000Z' };
  const { analysis } = await analyzeLibrary({ library: lib, llm, previous, options: { recommend: 'keep', full: true } });
  assert.deepEqual(analysis.recommendations.map((r) => r.title), ['前に選んだ本']);
  assert.equal(analysis.recommendedAt, '2026-01-01T00:00:00.000Z');
  const none = (await analyzeLibrary({ library: lib, llm, options: { recommend: 'keep' } })).analysis;
  assert.deepEqual(none.recommendations, []);
  assert.match(none.recommendationNote, /自動の分析ではおすすめの本を選びません/);
});

test('前回作り直したときから点が 1.5 倍（かつ 40 件以上）に増えたら、引き継がずに作り直す（小さいうちの形に縛られない）', async () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const llm = { chatModel: 'stub', chatJson: async (p) => (p.name === 'line' ? { name: '線', summary: '', insight: '', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '' } : { title: '核', core: '', relations: [], principles: [], questions: [] }) };
  const small = (await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis;
  assert.equal(small.pointsAtFull, 48);
  // 48 点 → 49 点: 引き継ぐ
  mergeParsed(lib, [{ title: '一冊', source: 'kindle', highlights: [{ text: '一つ増えた点' }] }]);
  const next = (await analyzeLibrary({ library: lib, llm, previous: small, options: { recommend: false } })).analysis;
  assert.equal(next.incremental, true);
  assert.equal(next.pointsAtFull, 48);
  // 前回作り直したのが 8 点のときだったとすると、49 点は 1.5 倍かつ 40 件以上の増加: 作り直す
  const grown = (await analyzeLibrary({ library: lib, llm, previous: { ...next, pointsAtFull: 8 }, options: { recommend: false } })).analysis;
  assert.equal(grown.incremental, false);
  assert.equal(grown.changes.reason, 'grew');
  assert.equal(grown.pointsAtFull, 49);
});

test('自動の分析の設定: 空・null・真偽値は既定値に戻し、"false" や 0 は「オフ」と読む。未来の失敗時刻では待ち続けない', () => {
  assert.deepEqual(autoConfig({ maxHours: null, minPoints: '' }), { enabled: true, minPoints: 10, maxHours: 24 });
  assert.equal(autoConfig({ maxHours: false }).maxHours, 24);
  assert.equal(autoConfig({ maxHours: 0 }).maxHours, 24, '0 時間は使わない');
  assert.equal(autoConfig({ maxHours: '6' }).maxHours, 6);
  for (const off of [false, 'false', 0, 'off']) assert.equal(autoConfig({ enabled: off }).enabled, false);
  const now = new Date('2026-10-04T12:00:00.000Z');
  const points = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}` }));
  assert.equal(autoAnalyzeDue({ points, analysis: null, now, lastFailureAt: '2026-10-05T12:00:00.000Z' }).due, true, '時計を戻しても待ち続けない');
});

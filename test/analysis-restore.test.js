// NIH-7: 分析の履歴から、前の分析に戻す（戻した回が今の分析になり、次の分析はその回から引き継ぐ）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { restoreAnalysis } from '../web/core/analysis/restore.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { analysisStamp } from '../web/core/importing.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test/fixtures', name);
const NOW = '2026-10-10T12:00:00.000Z';

const past = (extra = {}) => ({
  version: 2,
  createdAt: '2026-10-04T10:00:00.000Z',
  recommendedAt: '2026-10-05T10:00:00.000Z',
  model: { chat: 'fake', embed: 'fake-embed' },
  stats: { points: 4, lines: 1, planes: 1, isolated: 0 },
  incremental: true,
  changes: { previousAt: '2026-10-03T00:00:00.000Z', addedLines: [], grownLines: [], removedLines: [], connectedPoints: [] },
  lines: [{ id: 'l1', name: '線', summary: '', keywords: [], highlightIds: ['a', 'b'] }],
  planes: [{ id: 'p1', name: '面', summary: '', lineIds: ['l1'] }],
  solid: { title: '核', core: '', relations: [], principles: [] },
  isolated: [],
  ...extra,
});

test('NIH-7: 戻した回は今の時刻の分析になる（同期で負けない）。元の回の時刻を restoredFrom に残し、前回からの変化は持たない', () => {
  const a = past();
  const r = restoreAnalysis(a, NOW);
  assert.equal(r.createdAt, NOW);
  assert.equal(r.restoredFrom, a.createdAt);
  assert.equal(r.changes, null, '元の回の「前回からの変化」は、戻した今の変化ではない');
  assert.equal(r.recommendedAt, a.recommendedAt, 'おすすめを選んだ時刻は元のまま');
  assert.deepEqual(r.lines, a.lines);
  assert.deepEqual(r.planes, a.planes);
  assert.deepEqual(r.solid, a.solid);
  assert.equal(analysisStamp(r), NOW, 'ほかの端末に残っている、戻す前の新しい分析より新しい');
  assert.equal(analysisShapeError(r, Date.parse(NOW)), '');
  assert.equal(a.createdAt, '2026-10-04T10:00:00.000Z', '元の回は変えない');
  // おすすめを選び直していない回は、分析した時刻をおすすめの時刻にする（おすすめの日付が戻した日にならない）
  assert.equal(restoreAnalysis(past({ recommendedAt: undefined }), NOW).recommendedAt, '2026-10-04T10:00:00.000Z');
  // 戻した回をもう一度戻すときも、元の回の時刻を残す
  assert.equal(restoreAnalysis(r, '2026-10-11T00:00:00.000Z').restoredFrom, a.createdAt);
  // 届いた分析の restoredFrom も形を確かめる
  assert.match(analysisShapeError({ ...r, restoredFrom: 'きのう' }, Date.parse(NOW)), /restoredFrom/);
});

async function withServer(fn, { llmUrl } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-restore-'));
  const fake = await startFakeLlm();
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: llmUrl || fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' } });
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response(JSON.stringify({ items: [] })), drive: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, server });
  } finally {
    server.close();
    await fake.close();
  }
}

const b64 = async (file) => (await readFile(file)).toString('base64');
const importFiles = (base, files) => fetch(`${base}/api/import`, { method: 'POST', body: JSON.stringify({ files }) }).then((r) => r.json());
const notebook = (texts) => ({ name: 'kindle-auto.json', base64: Buffer.from(JSON.stringify({ format: 'book-highlights/kindle-notebook', version: 1, books: [{ asin: 'B0AUTO0001', title: '増えた本', author: '著者', highlights: texts.map((text) => ({ text })) }] })).toString('base64') });
const restore = (base, id) => fetch(`${base}/api/history/${id}/restore`, { method: 'POST' });

async function waitJob(base) {
  for (let i = 0; i < 200; i++) {
    const job = await (await fetch(`${base}/api/analyze`)).json();
    if (!job.running) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('分析が終わらない');
}

test('NIH-7: PC で履歴の前の回に戻すと、今の分析がその回の線・面・立体になり、次の自動の分析はその回から引き継ぐ', async () => {
  await withServer(async ({ base, server, store }) => {
    await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }, { name: 'playbooks-ja.html', base64: await b64(fixture('playbooks-ja.html')) }]);
    await server.checkAutoAnalyze();
    await waitJob(base);
    // 「最初から作り直す」で、線の顔ぶれが変わった 2 回目を作る
    const first = await store.analysis();
    await store.saveAnalysis({ ...first, createdAt: new Date(Date.parse(first.createdAt) + 1000).toISOString(), lines: first.lines.slice(1), planes: first.planes.map((p) => ({ ...p, lineIds: p.lineIds.filter((id) => id !== first.lines[0].id) })), solid: { ...first.solid, title: '変わった核' } });
    const { items } = await (await fetch(`${base}/api/history`)).json();
    assert.equal(items.length, 2);
    const target = items[1];
    assert.equal(target.createdAt, first.createdAt);

    const res = await restore(base, target.id);
    assert.equal(res.status, 200);
    const restored = await res.json();
    assert.equal(restored.restoredFrom, first.createdAt);
    assert.deepEqual(restored.lines, first.lines);
    assert.deepEqual(restored.planes, first.planes);
    assert.deepEqual(restored.solid, first.solid);
    // PC の今の分析になり、履歴にも「戻した回」として残る
    const now = await (await fetch(`${base}/api/analysis`)).json();
    assert.equal(now.createdAt, restored.createdAt);
    assert.ok(now.createdAt > items[0].createdAt, '戻した回は、戻す前の最新より新しい');
    const after = (await (await fetch(`${base}/api/history`)).json()).items;
    assert.equal(after.length, 3);
    assert.equal(after[0].restoredFrom, first.createdAt);

    // 次の自動の分析は、戻した回の線を引き継ぐ（線の ID が変わらない）
    await importFiles(base, [notebook(Array.from({ length: 10 }, (_, i) => `My Clippings の線を言い換えた ${i}`))]);
    assert.equal((await server.checkAutoAnalyze()).started, true);
    await waitJob(base);
    const next = await (await fetch(`${base}/api/analysis`)).json();
    assert.equal(next.incremental, true);
    assert.equal(next.changes.previousAt, restored.createdAt, '戻した回からの変化');
    assert.ok(next.lines.some((l) => l.id === first.lines[0].id), '戻した回にだけあった線が続いている');
    assert.equal(next.restoredFrom, undefined, '分析し直した回は、戻した回ではない');

    // 無い回・形の違う ID は 404
    assert.equal((await restore(base, '20990101T000000000Z')).status, 404);
    assert.equal((await fetch(`${base}/api/history/..%2Fconfig/restore`, { method: 'POST' })).status, 404);
  });
});

test('NIH-7: PC が分析している間は戻さない（分析の保存で、戻した結果が上書きされないように）', async () => {
  // 返事をしない LLM（分析がずっと続く）
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    await withServer(
      async ({ base, store }) => {
        await store.saveAnalysis(past());
        await importFiles(base, [{ name: 'My Clippings.txt', base64: await b64(fixture('My Clippings.txt')) }]);
        const id = (await store.history())[0].id;
        assert.equal((await fetch(`${base}/api/analyze`, { method: 'POST', body: '{}' })).status, 202);
        const res = await restore(base, id);
        assert.equal(res.status, 409);
        assert.match((await res.json()).error, /分析しています/);
        assert.equal((await store.analysis()).createdAt, past().createdAt, '今の分析は変わらない');
        await fetch(`${base}/api/analyze`, { method: 'DELETE' });
        await waitJob(base);
      },
      { llmUrl: `http://127.0.0.1:${hang.address().port}` },
    );
  } finally {
    hang.closeAllConnections?.();
    hang.close();
  }
});

test('NIH-7: 過去の分析の画面に「この分析に戻す」があり、履歴・知識の画面に「戻した」と出る', async () => {
  const { knowledge, historyBody, changeSummary } = await import('../web/js/views/knowledge.js');
  const a = past();
  const st = (analysis) => ({ library: { highlights: {}, books: {}, thoughts: {} }, analysis, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo: null });
  const body = String(historyBody(a, { current: false }));
  assert.match(body, /<button type="button" class="btn small primary" data-action="restore-analysis" data-id="20261004T100000000Z">この分析に戻す<\/button>/);
  assert.doesNotMatch(String(historyBody(a, { current: true })), /data-action="restore-analysis"/, 'いま表示している回には出さない');
  assert.match(String(historyBody(a, { current: true })), /いま表示している分析です/);
  // 戻した回は、履歴の一覧と知識の画面で分かる
  assert.match(changeSummary(null, '2026-10-04T10:00:00.000Z'), /^10\/4 .* の分析に戻した$/);
  const out = String(knowledge.render({ state: st(restoreAnalysis(a, NOW)) }));
  assert.match(out, /<h2>前回からの変化<\/h2>[\s\S]*?10\/4 .* の分析に戻しました/);
  // 押したときの処理（PC に送り、手元の分析を差し替えて知識の画面へ）
  const app = readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');
  assert.match(app, /'restore-analysis'/);
  assert.match(readFileSync(path.join(ROOT, 'web/js/services.js'), 'utf8'), /restoreHistory: \(id\) => call\(`\/api\/history\/\$\{encodeURIComponent\(id\)\}\/restore`, \{ method: 'POST' \}\)/);
});

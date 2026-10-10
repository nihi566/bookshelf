// NIH-83: 永久ノートだけを書いた・直した日も、自動の分析が始まる（ノートが面・立体に届く）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { autoAnalyzeDue, notesChanged, notesKey } from '../web/core/auto-analysis.js';
import { addNote, deleteNote, notesForAnalysis, updateNote } from '../web/core/notes.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(ROOT, 'test/fixtures', name);
const pts = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }));
const NOW = new Date('2026-10-04T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const NOTE_ID = 'nabc123';

function libraryWithNote(at = hoursAgo(30), extra = {}) {
  const lib = { notes: {} };
  addNote(lib, { title: '人間がまとめた線', body: '自分の言葉', pointIds: ['h0'], ...extra }, at, NOTE_ID);
  return lib;
}
// 前回の分析（4 点すべてが線に入っている = 増えた点は無い）
const analysisAt = (createdAt, lib) => ({ createdAt, lines: [{ highlightIds: ['h0', 'h1', 'h2', 'h3'] }], isolated: [], ...(lib ? { notesKey: notesKey(notesForAnalysis(lib)) } : {}) });

test('NIH-83: 点は増えていないが永久ノートを直したとき、前回から 24 時間たっていれば分析を始める', () => {
  const lib = libraryWithNote();
  const analysis = analysisAt(hoursAgo(25), lib);
  assert.equal(notesChanged(lib, analysis), false, '分析したときのノートのまま');
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis, now: NOW, notesChanged: notesChanged(lib, analysis) }).due, false, '点もノートも変わっていない');

  updateNote(lib, NOTE_ID, { body: '書き直した自分の言葉' }, hoursAgo(2));
  assert.equal(notesChanged(lib, analysis), true);
  const r = autoAnalyzeDue({ points: pts(4), analysis, now: NOW, notesChanged: notesChanged(lib, analysis) });
  assert.equal(r.due, true, r.reason);
  assert.equal(r.pending, 0);
  assert.match(r.reason, /永久ノート/);

  // 前回から 24 時間たっていなければ待つ（書いている途中で始めない）。待っている理由にノートが出る
  const recent = analysisAt(hoursAgo(1), libraryWithNote());
  const wait = autoAnalyzeDue({ points: pts(4), analysis: recent, now: NOW, notesChanged: notesChanged(lib, recent) });
  assert.equal(wait.due, false);
  assert.match(wait.reason, /永久ノート/);
  // 切ってあれば始めない
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis, now: NOW, notesChanged: true, config: { enabled: false } }).due, false);
});

test('NIH-83: 新しく書いた・消したノートも数え、線から作って直していない下書きは数えない', () => {
  const analysis = analysisAt(hoursAgo(25), { notes: {} });
  const added = libraryWithNote(hoursAgo(2));
  assert.equal(notesChanged(added, analysis), true, '新しく書いた');

  const draft = libraryWithNote(hoursAgo(2), { from: { kind: 'line', id: 'l1', name: '線' } });
  assert.equal(notesChanged(draft, analysis), false, '線の下書きのまま（AI に渡さない）');

  const lib = libraryWithNote();
  const base = analysisAt(hoursAgo(25), lib);
  deleteNote(lib, NOTE_ID, hoursAgo(2));
  assert.equal(notesChanged(lib, base), true, '消した');
});

test('NIH-83: ノートの指紋を持たない古い分析では、分析の時刻より後に直したノートを数える', () => {
  const old = analysisAt(hoursAgo(25));
  assert.equal(notesChanged(libraryWithNote(hoursAgo(30)), old), false, '分析より前のノート');
  assert.equal(notesChanged(libraryWithNote(hoursAgo(2)), old), true, '分析より後に書いた');
  assert.equal(notesChanged(libraryWithNote(hoursAgo(2)), null), false, 'まだ分析していなければ点の数で決める');
});

test('NIH-83: bh serve は永久ノートだけを直した日にも自動で分析し、分析にノートの指紋を残す', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-auto-notes-'));
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
    const lib = await store.library();
    const pointId = Object.keys(lib.highlights)[0];
    addNote(lib, { title: '人間がまとめた線', body: '自分の言葉', pointIds: [pointId] }, new Date().toISOString(), NOTE_ID);
    await store.saveLibrary(lib);
    assert.equal((await server.checkAutoAnalyze()).started, true);
    assert.equal((await waitJob()).stage, 'done');
    const first = await store.analysis();
    assert.equal(typeof first.notesKey, 'string', '分析にノートの指紋を残す');
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    assert.equal((await server.checkAutoAnalyze(tomorrow)).started, false, '点もノートも変わっていなければ始めない');

    const edited = await store.library();
    updateNote(edited, NOTE_ID, { body: '書き直した自分の言葉' });
    await store.saveLibrary(edited);
    const info = await (await fetch(`${base}/api/info`)).json();
    assert.equal(info.autoAnalysis.notesChanged, true, '知識の画面に、直したノートを待っていることを出せる');
    assert.equal((await server.checkAutoAnalyze()).started, false, '前回から 24 時間たつまでは待つ');
    const r = await server.checkAutoAnalyze(tomorrow);
    assert.equal(r.started, true, r.reason);
    assert.equal((await waitJob()).stage, 'done');
    assert.notEqual((await store.analysis()).notesKey, first.notesKey, '直したノートで面・立体を作り直した');
  } finally {
    server.close();
    await fake.close();
  }
});

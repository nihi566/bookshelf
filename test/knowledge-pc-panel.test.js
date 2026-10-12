// NIH-284: PC の分析の欄（分析し直す・おすすめを選び直す・自動の分析の状態）は月に 1 回使うかどうかなので、
// 普段は 1 行にたたみ、注意が要るとき（分析中・失敗・未分析・点が足りない・AI が未設定）だけ開いて出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

function analysisOf(lib) {
  const [a, b, c, d] = Object.keys(lib.highlights);
  return {
    version: 2,
    createdAt: '2026-10-04T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48, lines: 2, planes: 1, isolated: 0, calls: { chat: 1, embed: 2 } },
    lines: [
      { id: 'l1', name: '仕組みの線', summary: '要約', insight: '', keywords: [], highlightIds: [a, b], bookIds: [] },
      { id: 'l2', name: '注意の線', summary: '要約', insight: '', keywords: [], highlightIds: [c, d], bookIds: [] },
    ],
    planes: [{ id: 'p1', name: '面', summary: '要約', lineIds: ['l1', 'l2'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: ['原則'], questions: [] },
    isolated: [],
    recommendations: [],
  };
}

const AUTO = { enabled: true, minPoints: 10, maxHours: 24, lastSuccessAt: '2026-10-04T10:00:00.000Z', lastError: '', lastTrigger: 'auto' };
const st = (library, analysis, { job = null, autoAnalysis = AUTO, ai = { mode: 'companion', companionUrl: '' } } = {}) => ({
  library,
  analysis,
  settings: { ai },
  servedByCompanion: true,
  job,
  pcInfo: { autoAnalysis },
});

const panel = (out) => out.match(/<details class="card pc-panel" id="pc-analysis"( open)?>/);

test('NIH-284: 分析の結果があり注意が要らないとき、PC の分析の欄はたたんだ 1 行で出し、中の操作はそのまま使える', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const out = String(knowledge.render({ state: st(lib, analysisOf(lib)) }));
  const m = panel(out);
  assert.ok(m, 'PC の分析の欄がある');
  assert.equal(m[1], undefined, 'たたんで出す');
  assert.match(out, /<summary id="pc-analysis-head"><span>PC の分析 <span class="small muted"><span class="nowrap">前回の分析 2026-10-04<\/span>・<span class="nowrap">自動の分析 オン<\/span><\/span><\/span><\/summary>/);
  // 中には今までの操作がすべてある
  const inside = out.slice(out.indexOf('id="pc-analysis"'), out.indexOf('</div></details>', out.indexOf('id="pc-analysis"')));
  for (const action of ['run-analysis"', 'rerun-recommend', 'run-analysis-full']) assert.match(inside, new RegExp(`data-action="${action}`));
  assert.match(inside, /<div id="auto-status">/);
  // 知識（立体・前回からの変化など）より前に、操作の欄が大きく場所を取らない（欄は先頭の 1 行だけ）
  assert.ok(out.indexOf('id="pc-analysis"') < out.indexOf('class="solid-link"'));
});

test('NIH-284: 自動の分析がオフなら、たたんだ行に「自動の分析 オフ」と出す（PC の情報が無ければ自動の分析は出さない）', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  assert.match(String(knowledge.render({ state: st(lib, analysisOf(lib), { autoAnalysis: { ...AUTO, enabled: false } }) })), /前回の分析 2026-10-04<\/span>・<span class="nowrap">自動の分析 オフ<\/span>/);
  assert.match(String(knowledge.render({ state: { ...st(lib, analysisOf(lib)), pcInfo: null } })), /<summary id="pc-analysis-head"><span>PC の分析 <span class="small muted"><span class="nowrap">前回の分析 2026-10-04<\/span><\/span><\/span><\/summary>/);
});

test('NIH-284: PC の情報が後から届いたら、たたんだ行だけ差し替えて自動の分析の入切を出す（app.js は注意が要れば欄を開く）', async () => {
  const { pcPanelHead, pcPanelNeedsAttention } = await import('../web/js/views/knowledge.js');
  const { PC_INFO_BOXES } = await import('../web/js/routes.js');
  assert.deepEqual(PC_INFO_BOXES['/knowledge'].find(([sel]) => sel === '#pc-analysis-head'), ['#pc-analysis-head', pcPanelHead]);
  const lib = sample();
  const before = { ...st(lib, analysisOf(lib)), pcInfo: null };
  assert.doesNotMatch(String(pcPanelHead(before)), /自動の分析/);
  assert.equal(pcPanelNeedsAttention(before), false);
  const failed = st(lib, analysisOf(lib), { autoAnalysis: { ...AUTO, lastError: '失敗', lastErrorAt: '2026-10-05T00:00:00.000Z' } });
  assert.match(String(pcPanelHead(failed)), /自動の分析 オン/);
  assert.equal(pcPanelNeedsAttention(failed), true);
  // 直接（ブラウザ → LLM）の設定では、自動の分析の入切は出さない
  assert.doesNotMatch(String(pcPanelHead(st(lib, analysisOf(lib), { ai: { mode: 'direct', baseUrl: 'http://x', chatModel: 'm' } }))), /自動の分析/);
});

test('NIH-284: 注意が要るときは、PC の分析の欄を開いて出す', async () => {
  const { knowledge, pcPanelNeedsAttention } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib);
  const cases = {
    分析中: st(lib, a, { job: { running: true, where: 'pc', stage: 'lines', done: 1, total: 4 } }),
    分析の失敗: st(lib, a, { job: { running: false, stage: 'error', error: '失敗しました' } }),
    状況不明: st(lib, a, { job: { running: false, lost: true } }),
    自動の分析の失敗: st(lib, a, { autoAnalysis: { ...AUTO, lastError: 'LLM サーバに接続できません', lastErrorAt: '2026-10-05T00:00:00.000Z' } }),
    まだ分析していない: st(lib, null),
    点が足りない: st(emptyLibrary(), a),
    AIが未設定: st(lib, a, { ai: { mode: 'direct', baseUrl: 'http://localhost:11434', chatModel: '' } }),
  };
  for (const [name, state] of Object.entries(cases)) {
    assert.equal(pcPanelNeedsAttention(state), true, name);
    assert.equal(panel(String(knowledge.render({ state })))?.[1], ' open', name);
  }
  // 分析が終わって結果を出しているあいだも開いたまま（押した操作の結果がたたまれて見えなくならない）
  assert.equal(pcPanelNeedsAttention(st(lib, a, { job: { running: false, stage: 'done' } })), true);
  assert.equal(pcPanelNeedsAttention(st(lib, a)), false);
  // 失敗のあとに成功していれば、注意は要らない
  assert.equal(pcPanelNeedsAttention(st(lib, a, { autoAnalysis: { ...AUTO, lastError: '', lastErrorAt: '2026-10-03T00:00:00.000Z' } })), false);
});

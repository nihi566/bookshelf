// NIH-135: 前回の分析に入っていた点が消えたとき（本を技術書にした・消した）、「増えた点 N 件」の案内に「減った点 N 件」を添える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { analysisPoints } from '../web/core/points.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

// 今の点に、今は無い点 gone 件を足した分析（線 1 本 + まだつながらない点 1 件）
function analysisWith(lib, gone = 0) {
  const ids = [...analysisPoints(lib).map((p) => p.id), ...Array.from({ length: gone }, (_, i) => `gone-${i}`)];
  return {
    version: 2,
    createdAt: '2026-10-09T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: ids.length, lines: 1, planes: 1, isolated: 1 },
    lines: [{ id: 'l1', name: '線1', summary: '', insight: '', keywords: [], highlightIds: ids.slice(0, -1), bookIds: [] }],
    planes: [{ id: 'p1', name: '面', summary: '', lineIds: ['l1'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: [], questions: [] },
    isolated: ids.slice(-1),
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo: null });
// NIH-152 から件数は消えた点の一覧へのリンク
const REMOVED = /減った点 <a href="#\/knowledge\/removed"[^>]*><b>(\d+)<\/b> 件<\/a>/;

test('NIH-135: 消えた点が 1 件以上あるとき、知識の画面とホームの案内に「減った点 N 件」が出る', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const a = analysisWith(lib, 3);
  assert.equal(String(knowledge.render({ state: st(lib, a) })).match(REMOVED)?.[1], '3');
  // ホームは増えた点が 0 件でも、減った点があれば案内を出す
  const out = String(home.render({ state: st(lib, a), shuffle: 0 }));
  assert.equal(out.match(REMOVED)?.[1], '3');
  assert.match(out, /href="#\/knowledge">分析し直す/);
});

test('NIH-135: 増えた点と減った点が両方あれば、増えた点の案内のあとに「減った点 N 件」を続ける', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisWith(lib, 2);
  // 今の点の最後の 1 件を前回の分析から外す（増えた点 1 件）
  a.lines[0].highlightIds = a.lines[0].highlightIds.filter((id) => id !== analysisPoints(lib).at(-1).id);
  const out = String(knowledge.render({ state: st(lib, a) }));
  assert.match(out, /<b>1<\/b> 件<\/a>（まだ線につながっていません）。減った点 <a [^>]*><b>2<\/b> 件<\/a>（次の分析で線から外れます）/);
});

test('NIH-135: 消えた点が 0 件なら「減った点」は出さない', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const a = analysisWith(lib, 0);
  assert.doesNotMatch(String(knowledge.render({ state: st(lib, a) })), /減った点/);
  const out = String(home.render({ state: st(lib, a), shuffle: 0 }));
  assert.doesNotMatch(out, /減った点/);
  assert.doesNotMatch(out, /pending-nudge/, 'ホームは増えた点も減った点も 0 件なら案内を出さない');
  // 増えた点だけなら、これまでどおりの案内（減った点は出さない）
  a.lines[0].highlightIds = a.lines[0].highlightIds.slice(1);
  const only = String(knowledge.render({ state: st(lib, a) }));
  assert.match(only, /<b>1<\/b> 件<\/a>（まだ線につながっていません）。「分析し直す」/);
  assert.doesNotMatch(only, /減った点/);
});

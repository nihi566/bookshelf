// NIH-21: 知識の画面とホームの立体の欄に「前回の分析のあとに増えた点 N 件（まだ線につながっていません）」を出し、「分析し直す」へ導く
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { analysisPoints } from '../web/core/points.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

// 今の点のうち、最後の skip 件を含まない分析（線 2 本 + まだつながらない点 1 件）
function analysisOf(lib, skip = 0) {
  const ids = analysisPoints(lib).map((p) => p.id);
  const used = ids.slice(0, ids.length - skip);
  const half = Math.floor(used.length / 2);
  return {
    version: 2,
    createdAt: '2026-10-09T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: used.length, lines: 2, planes: 1, isolated: 1 },
    lines: [
      { id: 'l1', name: '線1', summary: '', insight: '', keywords: [], highlightIds: used.slice(0, half), bookIds: [] },
      { id: 'l2', name: '線2', summary: '', insight: '', keywords: [], highlightIds: used.slice(half, -1), bookIds: [] },
    ],
    planes: [{ id: 'p1', name: '面', summary: '', lineIds: ['l1', 'l2'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: [], questions: [] },
    isolated: used.slice(-1),
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo: null });
const NUDGE = /前回の分析のあとに増えた点 <b>(\d+)<\/b> 件（まだ線につながっていません）/;

test('NIH-21: ホームの立体の欄に、増えた点の数と「分析し直す」への導線が出る', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const out = String(home.render({ state: st(lib, analysisOf(lib, 3)), shuffle: 0 }));
  assert.equal(out.match(NUDGE)?.[1], '3');
  assert.match(out, /<a [^>]*href="#\/knowledge"[^>]*>分析し直す<\/a>/);
  // 立体の欄（立体のカードの後・最近の点の前）に出る
  assert.ok(out.indexOf('solid-card') < out.search(NUDGE) && out.search(NUDGE) < out.indexOf('最近の点'));
});

test('NIH-21: 増えた点が 0 件なら、ホームには出さない', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const out = String(home.render({ state: st(lib, analysisOf(lib, 0)), shuffle: 0 }));
  assert.doesNotMatch(out, /まだ線につながっていません/);
});

test('NIH-21: 知識の画面の「前回の分析」の行に、増えた点の数と「分析し直す」への案内が出る', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const out = String(knowledge.render({ state: st(lib, analysisOf(lib, 2)) }));
  assert.equal(out.match(NUDGE)?.[1], '2');
  assert.match(out, /「分析し直す」で、変わったところだけ作り直します/);
  assert.ok(out.indexOf('前回の分析: ') < out.search(NUDGE), '「前回の分析」の行の下に出る');
  // 0 件なら案内の文は出さない（件数だけ）
  const zero = String(knowledge.render({ state: st(lib, analysisOf(lib, 0)) }));
  assert.match(zero, /前回の分析のあとに増えた点 <b>0<\/b> 件/);
  assert.doesNotMatch(zero, /まだ線につながっていません/);
});

test('NIH-21: 点を消して別の点を足しても、数が打ち消し合わない（ID で数える）', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  const a = analysisOf(lib, 0);
  delete lib.highlights[a.lines[0].highlightIds[0]];
  addThought(lib, { text: '分析のあとの思いつき' }, '2026-10-10T00:00:00.000Z');
  assert.equal(analysisPoints(lib).length, a.stats.points, '点の総数は前回と同じ（差し引きでは 0 件になる）');
  const out = String(home.render({ state: st(lib, a), shuffle: 0 }));
  assert.equal(out.match(NUDGE)?.[1], '1');
});

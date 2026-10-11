// NIH-103: 「前回の分析のあとに増えた点 N 件」を押すと、その N 件の点が点のカードで並ぶ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { analysisPoints } from '../web/core/points.js';
import { pendingPointList, pendingPoints } from '../web/core/auto-analysis.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

// 今の点のうち、最後の skip 件を含まない分析（線 1 本 + まだつながらない点 1 件）
function analysisOf(lib, skip = 0) {
  const ids = analysisPoints(lib).map((p) => p.id);
  const used = ids.slice(0, ids.length - skip);
  return {
    version: 2,
    createdAt: '2026-10-09T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: used.length, lines: 1, planes: 1, isolated: 1 },
    lines: [{ id: 'l1', name: '線1', summary: '', insight: '', keywords: [], highlightIds: used.slice(0, -1), bookIds: [] }],
    planes: [{ id: 'p1', name: '面', summary: '', lineIds: ['l1'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: [], questions: [] },
    isolated: used.slice(-1),
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo: null });
const LINK = /<a [^>]*href="#\/knowledge\/pending"[^>]*><b>(\d+)<\/b> 件<\/a>/;
const cards = (out, ids) => ids.filter((id) => out.includes(`#/point/${id}`)).length;

test('NIH-103: 増えた点の一覧は pendingPoints が数える点と一致する', () => {
  const lib = sample();
  const a = analysisOf(lib, 3);
  addThought(lib, { text: '分析のあとの思いつき' }, '2026-10-10T00:00:00.000Z');
  const list = pendingPointList(analysisPoints(lib), a);
  assert.equal(list.length, pendingPoints(analysisPoints(lib), a));
  assert.equal(list.length, 4);
  const seen = new Set([...a.lines.flatMap((l) => l.highlightIds), ...a.isolated]);
  assert.ok(list.every((p) => !seen.has(p.id)), '前回の分析に入っていた点は含まない');
  // 前回が無ければすべて
  assert.equal(pendingPointList(analysisPoints(lib), null).length, analysisPoints(lib).length);
});

test('NIH-103: 知識の画面とホームの「N 件」が一覧へのリンクになる（0 件ならリンクにしない）', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  assert.equal(String(knowledge.render({ state: st(lib, analysisOf(lib, 2)) })).match(LINK)?.[1], '2');
  assert.equal(String(home.render({ state: st(lib, analysisOf(lib, 2)), shuffle: 0 })).match(LINK)?.[1], '2');
  assert.doesNotMatch(String(knowledge.render({ state: st(lib, analysisOf(lib, 0)) })), /#\/knowledge\/pending/);
});

test('NIH-103: 一覧の画面に、増えた N 件の点が点のカードで並ぶ', async () => {
  const { pendingView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib, 3);
  const pending = pendingPointList(analysisPoints(lib), a).map((p) => p.id);
  const out = String(pendingView.render({ state: st(lib, a) }));
  assert.equal(cards(out, pending), 3);
  const others = analysisPoints(lib).map((p) => p.id).filter((id) => !pending.includes(id));
  assert.equal(cards(out, others), 0, '前回の分析に入っていた点は並ばない');
  assert.match(out, /<a class="back" href="#\/knowledge">/);
  // 0 件・分析が無いとき
  assert.match(String(pendingView.render({ state: st(lib, analysisOf(lib, 0)) })), /増えた点はありません/);
  assert.match(String(pendingView.render({ state: st(lib, null) })), /まだ分析していません/);
});

test('NIH-103: 一覧の画面のルートがある', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const { pendingView } = await import('../web/js/views/knowledge.js');
  assert.deepEqual([matchRoute('/knowledge/pending').view, matchRoute('/knowledge/pending').tab], [pendingView, 'knowledge']);
});

// NIH-121: 一覧の画面から、そのまま「分析し直す」を押せる（知識の画面のボタンと同じ data-action）
const RERUN = /<button class="btn primary" data-action="run-analysis" (disabled)?>分析し直す<\/button>/;

test('NIH-121: 一覧の画面の下に「分析し直す」がある（分析中・点 4 件未満は押せない）', async () => {
  const { pendingView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib, 3);
  const out = String(pendingView.render({ state: st(lib, a) }));
  assert.ok(RERUN.test(out), 'ボタンがある');
  assert.equal(out.match(RERUN)[1], undefined, '押せる');
  assert.ok(out.indexOf('data-action="run-analysis"') > out.lastIndexOf('#/point/'), '一覧の下に置く');
  const job = { running: true, stage: 'embed', message: '埋め込みを作っています', done: 1, total: 4 };
  const running = String(pendingView.render({ state: { ...st(lib, a), job } }));
  assert.equal(running.match(RERUN)?.[1], 'disabled', '分析中は押せない');
  assert.match(running, /埋め込みを作っています/, '進み具合が見える');
  const few = emptyLibrary();
  for (const text of ['一つ目の思いつき', '二つ目の思いつき', '三つ目の思いつき']) addThought(few, { text }, '2026-10-10T00:00:00.000Z');
  const fewOut = String(pendingView.render({ state: st(few, analysisOf(few, 2)) }));
  assert.equal(fewOut.match(RERUN)?.[1], 'disabled', '点が 4 件未満なら押せない');
});

test('NIH-121: 増えた点が 0 件・未分析なら「分析し直す」を出さない', async () => {
  const { pendingView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  assert.doesNotMatch(String(pendingView.render({ state: st(lib, analysisOf(lib, 0)) })), /data-action="run-analysis"/);
  assert.doesNotMatch(String(pendingView.render({ state: st(lib, null) })), /data-action="run-analysis"/);
});

test('NIH-121: 分析の進み具合が変わると、知識の画面と一覧の画面を描き直す', async () => {
  const { JOB_PATHS } = await import('../web/js/routes.js');
  assert.deepEqual(JOB_PATHS, ['/knowledge', '/knowledge/pending']);
});

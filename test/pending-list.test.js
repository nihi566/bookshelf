// NIH-103: 「前回の分析のあとに増えた点 N 件」を押すと、その N 件の点が点のカードで並ぶ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('NIH-103: 一覧の画面のルートがある', () => {
  const src = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  assert.match(src, /\\\/knowledge\\\/pending\$\/, pendingView/);
});

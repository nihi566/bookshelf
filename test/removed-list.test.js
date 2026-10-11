// NIH-152: 「減った点 N 件」を押すと、前回の分析に入っていて今は無い点が並び、点ごとに理由と戻す画面への入口が出る
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookHighlights, deleteBook, emptyLibrary, joinHighlights, mergeParsed, updateBook, updateHighlight } from '../web/core/model.js';
import { addThought, deleteThought, updateThought } from '../web/core/thoughts.js';
import { analysisPoints } from '../web/core/points.js';
import { removedPointList, removedPoints } from '../web/core/auto-analysis.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const NOW = '2026-10-10T00:00:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

// 今の点すべてと extra の ID を含む分析（線 1 本 + まだつながらない点 1 件）
function analysisOf(lib, extra = []) {
  const ids = [...analysisPoints(lib).map((p) => p.id), ...extra];
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

// 分析のあとに、技術書にする・点を削除する・本ごと削除する・思いつきを捨てる・思いつきを削除する
function changed() {
  const lib = sample();
  const [tech, del, gone] = Object.keys(lib.books);
  const kept = addThought(lib, { text: 'あとで捨てる思いつき' }, NOW);
  const erased = addThought(lib, { text: 'あとで削除する思いつき' }, NOW);
  const a = analysisOf(lib, ['h-not-here']);
  const delId = bookHighlights(lib, del)[0].id;
  updateBook(lib, tech, { technical: true }, NOW);
  updateHighlight(lib, delId, { deleted: true }, NOW);
  deleteBook(lib, gone, NOW);
  updateThought(lib, kept.id, { status: 'discarded' }, NOW);
  deleteThought(lib, erased.id, NOW);
  return { lib, a, tech, del, gone, delId, kept, erased };
}

test('NIH-152: 消えた点の一覧は removedPoints の件数と一致し、点ごとに理由が付く', () => {
  const { lib, a, tech, gone, delId, kept, erased } = changed();
  const list = removedPointList(lib, a);
  assert.equal(list.length, removedPoints(analysisPoints(lib), a));
  const byReason = (r) => list.filter((x) => x.reason === r);
  assert.equal(byReason('technical').length, 6);
  assert.ok(byReason('technical').every((x) => x.point.bookId === tech && x.book.id === tech));
  assert.deepEqual(byReason('deleted').map((x) => x.id), [delId]);
  assert.equal(byReason('book-deleted').length, 6);
  assert.ok(byReason('book-deleted').every((x) => x.book.id === gone));
  assert.deepEqual(byReason('discarded').map((x) => x.id), [kept.id]);
  assert.deepEqual(byReason('thought-deleted').map((x) => x.id), [erased.id]);
  assert.deepEqual(byReason('missing').map((x) => x.id), ['h-not-here']);
  // 前回が無ければ空
  assert.deepEqual(removedPointList(lib, null), []);
});

test('NIH-152: 取り込み・つなげたことで置き換わった点は、置き換え先を指す', () => {
  const lib = sample();
  const a = analysisOf(lib);
  const [first, second] = bookHighlights(lib, Object.keys(lib.books)[0]);
  joinHighlights(lib, first.id, second.id, NOW);
  const list = removedPointList(lib, a);
  assert.equal(list.length, removedPoints(analysisPoints(lib), a));
  const x = list.find((r) => r.id === second.id);
  assert.equal(x.reason, 'replaced');
  assert.equal(x.replacedBy, first.id);
});

test('NIH-152: 「減った点 N 件」が消えた点の一覧へのリンクになる（知識の画面・ホーム）', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { home } = await import('../web/js/views/library.js');
  const { lib, a } = changed();
  const n = removedPoints(analysisPoints(lib), a);
  const LINK = /減った点 <a [^>]*href="#\/knowledge\/removed"[^>]*><b>(\d+)<\/b> 件<\/a>/;
  assert.equal(String(knowledge.render({ state: st(lib, a) })).match(LINK)?.[1], String(n));
  assert.equal(String(home.render({ state: st(lib, a), shuffle: 0 })).match(LINK)?.[1], String(n));
});

test('NIH-152: 一覧の画面に、消えた点が理由と戻す画面への入口つきで並ぶ', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const { lib, a, tech, del, delId, kept } = changed();
  const { view } = matchRoute('/knowledge/removed');
  const out = String(view.render({ state: st(lib, a), query: new URLSearchParams() }));
  // 技術書にした本: 本の画面（本の情報を編集）へ
  assert.match(out, /技術書にした本の点/);
  assert.match(out, new RegExp(`href="#/book/${tech}"[^>]*>本の情報を編集`));
  // 削除した点・削除した本: 削除した点の画面へ
  assert.match(out, /削除した点/);
  assert.match(out, /削除した本の点/);
  assert.match(out, /href="#\/trash"/);
  assert.ok(out.includes(lib.highlights[delId].text), '削除した点の文が出る');
  assert.ok(out.includes(lib.books[del].title), 'どの本の点かが出る');
  // 捨てた思いつき: 捨てたメモの一覧へ
  assert.match(out, /捨てた思いつき/);
  assert.match(out, /href="#\/thoughts\?status=discarded"/);
  assert.ok(out.includes(kept.text));
  // 件数
  assert.match(out, new RegExp(`${removedPoints(analysisPoints(lib), a)} 件`));
});

test('NIH-152: 消えた点が無い・まだ分析していないときは、その旨を出す', async () => {
  const { matchRoute } = await import('../web/js/routes.js');
  const { view } = matchRoute('/knowledge/removed');
  const lib = sample();
  assert.match(String(view.render({ state: st(lib, analysisOf(lib)), query: new URLSearchParams() })), /消えた点はありません/);
  assert.match(String(view.render({ state: st(lib, null), query: new URLSearchParams() })), /まだ分析していません/);
});

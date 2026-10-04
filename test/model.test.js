import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bookHighlights, dailyPicks, deleteBook, emptyLibrary, highlightIdFor, bookIdFor, libraryStats, listBooks, mergeLibraries, mergeParsed, searchHighlights, updateHighlight } from '../web/core/model.js';
import { layoutKnowledgeMap } from '../web/core/knowledge-map.js';
import { createZip, readZip } from '../web/core/zip.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-02-01T00:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  return lib;
}

test('mergeParsed: 取り込み・再取り込みで重複しない・空欄を補う', () => {
  const lib = emptyLibrary();
  const parsed = [{ title: '本A', author: '著者', source: 'kindle', highlights: [{ text: '一つ目', location: 10 }, { text: '二つ目' }] }];
  const s1 = mergeParsed(lib, parsed, { now: T1 });
  assert.deepEqual([s1.added, s1.booksAdded], [2, 1]);
  const s2 = mergeParsed(lib, [{ ...parsed[0], highlights: [{ text: '一つ目', location: 10, note: '後から付いたメモ' }] }], { now: T2 });
  assert.deepEqual([s2.added, s2.updated], [0, 1]);
  const id = highlightIdFor(bookIdFor('本A'), '一つ目');
  assert.equal(lib.highlights[id].note, '後から付いたメモ');
  assert.equal(libraryStats(lib).highlights, 2);
});

test('mergeParsed: Kindle で伸ばしたハイライトは古い方を置き換え、ユーザーの編集を引き継ぐ', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '短い文', location: 100, locationEnd: 101 }] }], { now: T1 });
  const shortId = Object.keys(lib.highlights)[0];
  updateHighlight(lib, shortId, { favorite: true, tags: ['#大事', ' 大事 ', 'x'], userNote: '覚える' }, T1);
  assert.deepEqual(lib.highlights[shortId].tags, ['大事', 'x']);
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '短い文を伸ばした', location: 100, locationEnd: 104 }] }], { now: T2 });
  const live = bookHighlights(lib, bookIdFor('本'));
  assert.equal(live.length, 1);
  assert.equal(live[0].text, '短い文を伸ばした');
  assert.equal(live[0].favorite, true);
  assert.equal(live[0].userNote, '覚える');
  // 古い短い版を再取り込みしても復活しない
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '短い文', location: 100, locationEnd: 101 }] }], { now: T2 });
  assert.equal(bookHighlights(lib, bookIdFor('本')).length, 1);
});

test('削除（墓標）は再取り込みで復活しない・同期では新しい方が勝つ', () => {
  const lib = sampleLibrary();
  const [first] = listBooks(lib);
  const hl = bookHighlights(lib, first.id)[0];
  updateHighlight(lib, hl.id, { deleted: true }, T2);
  mergeParsed(lib, SAMPLE_BOOKS, { now: T2 });
  assert.equal(lib.highlights[hl.id].deleted, true);

  const phone = structuredClone(lib);
  updateHighlight(phone, hl.id, { deleted: false, favorite: true }, '2025-03-01T00:00:00.000Z');
  const merged = mergeLibraries(lib, phone);
  assert.equal(merged.highlights[hl.id].deleted, false);
  assert.equal(merged.highlights[hl.id].favorite, true);
  const reverse = mergeLibraries(phone, lib);
  assert.equal(reverse.highlights[hl.id].favorite, true, 'どちら向きに統合しても新しい編集が残る');

  deleteBook(lib, first.id, T2);
  assert.ok(!listBooks(lib).some((b) => b.id === first.id));
});

test('検索・一覧・今日の点', () => {
  const lib = sampleLibrary();
  assert.equal(listBooks(lib).length, 8);
  assert.equal(libraryStats(lib).highlights, 48);
  assert.deepEqual(libraryStats(lib).bySource, { kindle: 24, playbooks: 24 });
  // 語は本文・メモ・書名・著者のどこかにあればよい（AND 検索）
  const hits = searchHighlights(lib, '集中 深い');
  assert.equal(hits.length, 6);
  assert.ok(hits.every((h) => lib.books[h.bookId].title === '深い集中'));
  assert.equal(searchHighlights(lib, '集中 退屈').length, 1);
  assert.ok(searchHighlights(lib, '山田').length === 6, '著者名でも探せる');
  assert.equal(searchHighlights(lib, '', { source: 'playbooks' }).length, 24);
  const id = searchHighlights(lib, '注意は最も希少')[0].id;
  updateHighlight(lib, id, { tags: ['注意'] });
  assert.equal(searchHighlights(lib, '#注意')[0].id, id);
  const d = new Date(2025, 5, 1);
  assert.deepEqual(dailyPicks(lib, 3, d).map((h) => h.id), dailyPicks(lib, 3, d).map((h) => h.id));
});

test('今日の点の「別の点」は日付ではなく渡した種で選ぶ（翌日の今日の点と同じ組にならない）', () => {
  const lib = sampleLibrary();
  const d = new Date(2025, 5, 1);
  const ids = (seed) => dailyPicks(lib, 3, d, seed).map((h) => h.id).join();
  assert.equal(ids('abc'), ids('abc'), '同じ種なら同じ組');
  assert.ok(new Set(['s1', 's2', 's3', 's4', 's5'].map(ids)).size > 1, '種が違えば違う組が出る');
  const nextDay = dailyPicks(lib, 3, new Date(2025, 5, 2)).map((h) => h.id).join();
  assert.notEqual(ids('s1'), nextDay, '種を渡したら翌日の今日の点とは別の組');
});

function fakeAnalysis(lib) {
  const hs = Object.values(lib.highlights);
  return {
    createdAt: T2,
    model: { chat: 'fake', embed: 'tfidf' },
    stats: { points: hs.length, lines: 2, planes: 1 },
    lines: [
      { id: 'l1', name: '仕組み: 環境', summary: '仕組みが行動をつくる。', insight: '問い', keywords: ['仕組み'], highlightIds: [hs[0].id, hs[7].id], bookIds: [] },
      { id: 'l2', name: '注意の管理', summary: '注意は資源。', insight: '', keywords: [], highlightIds: [hs[6].id, hs[8].id], bookIds: [] },
    ],
    planes: [{ id: 'p1', name: '自己の設計', summary: '行動と注意を設計する。', lineIds: ['l1', 'l2'] }],
    solid: { title: '核', core: '小さな仕組み。', relations: [], principles: ['原則'], questions: ['問い'] },
    isolated: [hs[1].id],
    recommendations: [{ title: '次の本', author: '誰か', reason: '理由', kind: 'deepen', planeId: 'p1', verified: false }],
  };
}

test('layoutKnowledgeMap: 核・面・線をすべて有限の座標に置き、核→面→線をつなぐ', () => {
  const lib = sampleLibrary();
  const analysis = fakeAnalysis(lib);
  const layout = layoutKnowledgeMap(analysis);
  assert.equal(layout.nodes.length, 1 + 1 + 2);
  assert.ok(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.equal(layout.edges.length, 3);
});

test('zip: 書き出しと読み込みの往復、system unzip でも検証', async () => {
  const files = [
    { name: 'Highlights/Books/日本語の本.md', content: '# こんにちは\n' },
    { name: 'Highlights/Index.md', content: 'x'.repeat(1000) },
  ];
  const zip = createZip(files);
  const back = await readZip(zip);
  assert.deepEqual(back.map((e) => [e.name, new TextDecoder().decode(e.bytes)]), files.map((f) => [f.name, f.content]));
  let hasUnzip = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    hasUnzip = false;
  }
  if (hasUnzip) {
    const dir = mkdtempSync(path.join(tmpdir(), 'bh-zip-'));
    const p = path.join(dir, 'vault.zip');
    writeFileSync(p, zip);
    const out = execFileSync('unzip', ['-t', p]).toString();
    assert.match(out, /No errors detected/);
  }
});

test('レビュー指摘の回帰: 削除した本の再取り込み・改行入りの書名', () => {
  const lib = emptyLibrary();
  const parsed = [{ title: '本\n# 見出しの注入', author: '著者\nX', source: 'kindle', highlights: [{ text: '点A' }, { text: '```dataviewjs\nalert(1)\n```' }] }];
  mergeParsed(lib, parsed, { now: T1 });
  const [b] = listBooks(lib);
  assert.equal(b.title, '本 # 見出しの注入');
  assert.equal(b.author, '著者 X');
  // 本を削除してから再取り込みすると、本と一緒に消えた点も戻る（個別に消した点は戻らない）
  const [h1, h2] = bookHighlights(lib, b.id);
  updateHighlight(lib, h2.id, { deleted: true }, T1);
  deleteBook(lib, b.id, T2);
  mergeParsed(lib, parsed, { now: T2 });
  assert.deepEqual(bookHighlights(lib, b.id).map((h) => h.id), [h1.id]);
});

test('mergeParsed: 自動取り込み（reviveDeleted: false）では削除した本を復活させない', () => {
  const lib = emptyLibrary();
  const parsed = [{ title: '消した本', author: '著者', source: 'kindle', highlights: [{ text: '点A' }] }];
  mergeParsed(lib, parsed, { now: T1 });
  const [b] = listBooks(lib);
  deleteBook(lib, b.id, T2);
  const stats = mergeParsed(lib, [{ ...parsed[0], highlights: [{ text: '点A' }, { text: '点B' }] }], { now: T2, reviveDeleted: false });
  assert.equal(stats.skippedDeletedBooks, 1);
  assert.equal(stats.added, 0);
  assert.ok(lib.books[b.id].deleted);
  assert.equal(listBooks(lib).length, 0);
});

test('HTML: 検索語の強調はエスケープを壊さない・外部 URL は https のみ', async () => {
  const { mark, safeUrl } = await import('../web/js/html.js');
  assert.equal(String(mark('a < b & lt', 'lt')), 'a &lt; b &amp; <mark>lt</mark>');
  assert.equal(String(mark('<script>', 'script')), '&lt;<mark>script</mark>&gt;');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://books.google.com/x'), 'https://books.google.com/x');
});

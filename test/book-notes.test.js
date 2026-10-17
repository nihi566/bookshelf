import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed, updateHighlight, bookIdFor, liveHighlights } from '../web/core/model.js';
import { applyBookNote, bookNoteFileName, parseBookNote, renderBookNote } from '../web/core/book-notes.js';

const NOW = '2026-10-18T00:00:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, [
    {
      title: '考える技術: 第2版',
      author: '著者A',
      source: 'kindle',
      highlights: [
        { text: '一行目\n二行目', chapter: '第1章' },
        { text: '- 箇条書きに見える文', chapter: '第1章' },
        { text: '別の章の文', chapter: '第2章' },
      ],
    },
  ], { now: NOW });
  return lib;
}

test('ファイル名は書名で、使えない文字だけ置き換える', () => {
  assert.equal(bookNoteFileName('考える技術'), '考える技術.md');
  assert.equal(bookNoteFileName('A/B: C?'), 'A_B_ C_.md');
  assert.equal(bookNoteFileName('   '), '無題.md');
});

test('書き出して読み直すと、何も変わらない', () => {
  const lib = sample();
  const id = liveHighlights(lib)[0].id;
  updateHighlight(lib, id, { userNote: '自分のメモ', tags: ['a', 'b'], favorite: true }, NOW);
  const md = renderBookNote(lib, bookIdFor('考える技術: 第2版'));
  const parsed = parseBookNote(md);
  assert.equal(parsed.points.length, 3);
  const copy = structuredClone(lib);
  const stat = applyBookNote(copy, parsed, '', NOW);
  assert.deepEqual({ changed: stat.changed, added: stat.added }, { changed: 0, added: 0 });
  assert.deepEqual(copy.highlights, lib.highlights);
});

test('空行・「- 」「#」で始まる行・複数行のメモがあっても、往復で変わらない', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '段落1\n\n段落2\n- 箇条\n# 見出しに見える\n  - メモ: に見える' }] }], { now: NOW });
  const id = liveHighlights(lib)[0].id;
  updateHighlight(lib, id, { userNote: '一行目\n二行目', tags: ['a b'] }, NOW);
  const copy = structuredClone(lib);
  const stat = applyBookNote(copy, parseBookNote(renderBookNote(lib, bookIdFor('本'))), '', NOW);
  assert.deepEqual({ changed: stat.changed, added: stat.added }, { changed: 0, added: 0 });
  assert.deepEqual(copy.highlights, lib.highlights);
});

test('Markdown で直した文・メモ・タグ・★がライブラリに入る', () => {
  const lib = sample();
  const bookId = bookIdFor('考える技術: 第2版');
  const md = renderBookNote(lib, bookId)
    .replace('別の章の文', '別の章の文を直した')
    .replace(/(\^h[0-9a-z]+)\n\n## 第2章/, '$1\n  - メモ: 足したメモ\n  - タグ: #x\n  - ★\n\n## 第2章');
  const stat = applyBookNote(lib, parseBookNote(md), '', NOW);
  assert.equal(stat.changed, 2);
  const texts = liveHighlights(lib).map((h) => h.text);
  assert.ok(texts.includes('別の章の文を直した'));
  const starred = liveHighlights(lib).find((h) => h.favorite);
  assert.equal(starred.userNote, '足したメモ');
  assert.deepEqual(starred.tags, ['x']);
});

test('ID の無い箇条書きは新しい点になり、Markdown から消えた点は消さない', () => {
  const lib = sample();
  const bookId = bookIdFor('考える技術: 第2版');
  const md = renderBookNote(lib, bookId).split('## 第2章')[0] + '\n- Obsidian で足した点\n  - ★\n';
  const stat = applyBookNote(lib, parseBookNote(md), '', NOW);
  assert.equal(stat.added, 1);
  assert.equal(liveHighlights(lib).length, 4);
  assert.ok(liveHighlights(lib).find((h) => h.text === 'Obsidian で足した点').favorite);
});

test('手元に無い本のファイルは、ファイル名の書名で本を足す', () => {
  const lib = emptyLibrary();
  const stat = applyBookNote(lib, parseBookNote('- 最初の点\n'), '新しい本', NOW);
  assert.equal(stat.added, 1);
  assert.equal(lib.books[bookIdFor('新しい本')].title, '新しい本');
});

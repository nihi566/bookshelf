// 紙の本・読書メモの取り込みのレビュー（2026-10-04）で見つかった問題の再発防止
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookIdFor, emptyLibrary, mergeLibraries, mergeParsed, registerBook, updateBook } from '../web/core/model.js';
import { parseReadingNote } from '../web/core/parsers/reading-notes.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';
const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';
const texts = (book) => book.highlights.map((h) => h.text);

test('parseReadingNote: Play ブックスのリンクの直後の塊だけをつなぎ、自分で書いた箇条書きや英文はつながない', () => {
  const url = 'https://www.google.com/url?q=http://play.google.com/books/reader?id%3Dabc%26source%3Dbooks-notes-export&sa=D';
  const md = `Hello world is nice\nsecond line here\n\n${url}\n- 断片の前半\n- と後半\n- end of an English\n- line continues\n\n- 自分の箇条 a\n- 自分の箇条 b\n`;
  assert.deepEqual(texts(parseReadingNote(md, 'x')), [
    'Hello world is nice\nsecond line here',
    '断片の前半と後半end of an English line continues',
    '自分の箇条 a',
    '自分の箇条 b',
  ]);
});

test('parseReadingNote: タグだけの行・Markdown の画像・先頭の区切り線を正しく扱う', () => {
  const md = '---\n\n#読書 #本\n本文の一文目。\n\n![図](https://example.com/a.png)\n\n---\n\n二つ目の段落。\n';
  const book = parseReadingNote(md, 'x');
  assert.deepEqual(texts(book), ['本文の一文目。', '二つ目の段落。']);
  assert.deepEqual(book.images, ['https://example.com/a.png']);
  // 本物の front matter（キー: 値）は外す
  assert.deepEqual(texts(parseReadingNote('---\ntags: [a]\naliases: x\n---\n本文。\n', 'x')), ['本文。']);
});

test('parseReadingNote: とても長い行でも時間がかからない', () => {
  const start = Date.now();
  parseReadingNote('['.repeat(200000) + '\n' + '![['.repeat(50000) + '\n' + '[['.repeat(50000) + '|', 'x');
  assert.ok(Date.now() - start < 2000, `${Date.now() - start}ms`);
});

test('mergeParsed（読書メモ）: 短い文は既にある線に含まれていても落とさない。書名を合わせた本は結果で分かる', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '新版 ハマトンの知的生活', source: 'kindle', highlights: [{ text: '習慣こそが知的生活の土台である' }] }]);
  const stats = mergeParsed(lib, [{ title: 'ハマトン', source: 'memo', highlights: [{ text: '習慣' }, { text: '習慣こそが知的生活の土台' }] }]);
  assert.equal(stats.added, 1);
  assert.equal(stats.unchanged, 1);
  assert.deepEqual(stats.memoTitles, [{ from: 'ハマトン', to: '新版 ハマトンの知的生活' }]);
});

test('updateBook: 著者だけを直しても、表紙・技術書の編集時刻は進めない（別の端末の表紙を消さない）', () => {
  const base = emptyLibrary();
  registerBook(base, { title: '読書について' }, T1);
  const id = bookIdFor('読書について');
  const a = structuredClone(base);
  const b = structuredClone(base);
  updateBook(a, id, { cover: COVER }, T2);
  updateBook(b, id, { author: 'ショーペンハウアー' }, T3);
  for (const m of [mergeLibraries(a, b), mergeLibraries(b, a)]) {
    assert.equal(m.books[id].cover, COVER);
    assert.equal(m.books[id].author, 'ショーペンハウアー');
  }
});

test('mergeLibraries: 同期で届いた表紙が画像の data URL でなければ捨てる', () => {
  const base = emptyLibrary();
  registerBook(base, { title: '本' }, T1);
  const evil = structuredClone(base);
  const id = bookIdFor('本');
  Object.assign(evil.books[id], { cover: 'data:text/html;base64,PGI+', userUpdatedAt: T3, updatedAt: T3 });
  assert.equal('cover' in mergeLibraries(base, evil).books[id], false);
});

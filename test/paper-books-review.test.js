// 紙の本・読書メモの取り込みのレビュー（2026-10-04）で見つかった問題の再発防止
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookIdFor, emptyLibrary, mergeLibraries, mergeParsed, registerBook, updateBook } from '../web/core/model.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';
const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';
const texts = (book) => book.highlights.map((h) => h.text);

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

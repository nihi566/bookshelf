import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addHighlight,
  bookIdFor,
  dailyPicks,
  emptyLibrary,
  guessTechnical,
  isTechnicalBook,
  libraryStats,
  listBooks,
  mergeLibraries,
  mergeParsed,
  pointHighlights,
  registerBook,
  updateBook,
} from '../web/core/model.js';
import { bookCoverUrl, isUploadedCover } from '../web/core/covers.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';
const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/';

test('guessTechnical: IT の教科書の書名だけを技術書と推定する', () => {
  for (const t of ['独習PHP 第4版', 'SQL 第2版 ゼロからはじめるデータベース操作', 'Webを支える技術 ―― HTTP，URI，HTML，そしてREST', '難しく考えないGit＆GitHub vol.1', 'Linuxで動かしながら学ぶTCP/IPネットワーク入門', '新人エンジニアのためのインフラ入門', '図解まるわかり AIのしくみ', 'ちょうぜつソフトウェア設計入門', 'フロントエンドの知識地図', '【図解】はじめての上流工程(要件定義・システム設計)入門', 'MySQL 徹底入門', 'Python 1年生']) {
    assert.equal(guessTechnical(t), true, t);
  }
  for (const t of ['ロジカル・シンキング', '「技術書」の読書術', 'エンジニアの知的生産術', '人間の条件 (ちくま学芸文庫)', 'ONE PIECE 1 (ジャンプコミックスDIGITAL)', '［新版］グロービスＭＢＡ経営戦略', 'マックス・ウェーバーを読む', 'javanese の料理', 'だれとも打ち解けられない人 (PHP新書)', '働かないおじさんが御社をダメにする (PHP新書)', '道は開ける (PHP文庫)']) {
    assert.equal(guessTechnical(t), false, t);
  }
});

test('isTechnicalBook: 本に決めた値があればそれを、無ければ書名から推定する', () => {
  assert.equal(isTechnicalBook({ title: '独習PHP' }), true);
  assert.equal(isTechnicalBook({ title: '独習PHP', technical: false }), false);
  assert.equal(isTechnicalBook({ title: '人間の条件', technical: true }), true);
  assert.equal(isTechnicalBook(null), false);
});

function libraryWithTechBook() {
  const lib = emptyLibrary();
  mergeParsed(lib, [
    { title: '人間の条件', source: 'kindle', highlights: [{ text: '活動的生活' }, { text: '労働と仕事' }] },
    { title: '独習PHP 第4版', source: 'kindle', highlights: [{ text: '変数は $ で始める' }, { text: '配列の関数' }, { text: 'クラスの継承' }] },
  ], { now: T1 });
  return lib;
}

test('技術書の線は点に数えない（件数・今日の点・分析の対象から外す）', () => {
  const lib = libraryWithTechBook();
  assert.equal(pointHighlights(lib).length, 2);
  const s = libraryStats(lib);
  assert.equal(s.highlights, 2);
  assert.equal(s.technical, 3);
  assert.equal(s.books, 2);
  assert.ok(dailyPicks(lib, 5).every((h) => lib.books[h.bookId].title === '人間の条件'));
  // 本の一覧では技術書も見える（数えないだけ）
  const php = listBooks(lib).find((b) => b.title === '独習PHP 第4版');
  assert.equal(php.count, 3);
  assert.equal(php.isTechnical, true);
  // 技術書ではないと決めれば数える
  updateBook(lib, bookIdFor('独習PHP 第4版'), { technical: false }, T2);
  assert.equal(libraryStats(lib).highlights, 5);
});

test('registerBook: 紙の本を書名・著者・表紙・技術書で登録する（点が 0 でも一覧に出せる）', () => {
  const lib = emptyLibrary();
  const b = registerBook(lib, { title: ' 読書について ', author: 'ショーペンハウアー', cover: COVER, technical: false }, T1);
  assert.equal(b.id, bookIdFor('読書について'));
  assert.equal(b.title, '読書について');
  assert.deepEqual(b.sources, ['paper']);
  assert.equal(b.cover, COVER);
  assert.equal(b.technical, false);
  assert.equal(b.userUpdatedAt, T1);
  assert.equal(listBooks(lib).length, 0);
  const shown = listBooks(lib, { includeEmpty: true });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].count, 0);
  // 技術書を決めなければ書名からの推定に任せる（値を持たない）
  const auto = registerBook(lib, { title: '独習Python' }, T1);
  assert.equal('technical' in auto, false);
  assert.equal(isTechnicalBook(auto), true);
});

test('registerBook: 書名が空・表紙が画像の data URL でないときは登録しない', () => {
  const lib = emptyLibrary();
  assert.throws(() => registerBook(lib, { title: '  ' }), /書名/);
  assert.throws(() => registerBook(lib, { title: '本', cover: 'javascript:alert(1)' }), /表紙/);
  assert.throws(() => registerBook(lib, { title: '本', cover: 'data:image/svg+xml;base64,PHN2Zz4=' }), /表紙/);
  assert.equal(Object.keys(lib.books).length, 0);
});

test('registerBook: 同じ書名の本が既にあれば、その本に紙の本を足す（線は消えない）', () => {
  const lib = libraryWithTechBook();
  const b = registerBook(lib, { title: '人間の条件', cover: COVER }, T2);
  assert.deepEqual(b.sources, ['kindle', 'paper']);
  assert.equal(b.cover, COVER);
  assert.equal(listBooks(lib).find((x) => x.id === b.id).count, 2);
});

test('addHighlight: 紙の本に点を手で足す。同じ文は増やさず、消した文は戻す', () => {
  const lib = emptyLibrary();
  const b = registerBook(lib, { title: '読書について' }, T1);
  const r = addHighlight(lib, b.id, { text: ' 読書とは他人にものを考えてもらうことである ', page: '12', chapter: '読書について', note: '耳が痛い' }, T2);
  assert.equal(r.added, true);
  assert.equal(r.highlight.source, 'paper');
  assert.equal(r.highlight.text, '読書とは他人にものを考えてもらうことである');
  assert.equal(r.highlight.page, '12');
  assert.equal(r.highlight.chapter, '読書について');
  assert.equal(r.highlight.note, '耳が痛い');
  assert.equal(r.highlight.createdAt, T2);
  assert.equal(libraryStats(lib).highlights, 1);
  assert.equal(addHighlight(lib, b.id, { text: '読書とは他人にものを考えてもらうことである' }, T2).added, false);
  lib.highlights[r.highlight.id].deleted = true;
  const again = addHighlight(lib, b.id, { text: '読書とは他人にものを考えてもらうことである' }, T3);
  assert.equal(again.added, true);
  assert.equal(lib.highlights[r.highlight.id].deleted, undefined);
  assert.throws(() => addHighlight(lib, b.id, { text: '   ' }), /文/);
  assert.throws(() => addHighlight(lib, 'bnone', { text: 'x' }), /本/);
});

test('updateBook: 著者・表紙・技術書を変える。技術書は null で自動に戻す', () => {
  const lib = emptyLibrary();
  const b = registerBook(lib, { title: '独習PHP' }, T1);
  updateBook(lib, b.id, { author: '山田', cover: COVER, technical: false }, T2);
  assert.deepEqual([b.author, b.cover, b.technical, b.userUpdatedAt, b.updatedAt], ['山田', COVER, false, T2, T2]);
  updateBook(lib, b.id, { cover: '', technical: null }, T3);
  assert.equal('cover' in b, false);
  assert.equal('technical' in b, false);
  assert.throws(() => updateBook(lib, b.id, { cover: 'https://example.com/a.jpg' }), /表紙/);
});

test('mergeLibraries: 表紙と技術書は、あとで編集した端末の値が残る（どちら向きでも同じ）', () => {
  const base = emptyLibrary();
  registerBook(base, { title: '独習PHP' }, T1);
  const phone = structuredClone(base);
  const pc = structuredClone(base);
  const id = bookIdFor('独習PHP');
  updateBook(phone, id, { technical: false, cover: COVER }, T3);
  // PC では後から取り込みがあった（利用者の編集ではない）
  mergeParsed(pc, [{ title: '独習PHP', source: 'kindle', highlights: [{ text: '変数' }] }], { now: '2026-04-01T00:00:00.000Z' });
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(m.books[id].technical, false);
    assert.equal(m.books[id].cover, COVER);
    assert.deepEqual(m.books[id].sources, ['kindle', 'paper']);
  }
});

test('bookCoverUrl: アップロードした表紙を先に使い、安全な画像の data URL だけを通す', () => {
  assert.equal(bookCoverUrl({ cover: COVER, asin: 'B000000000' }), COVER);
  assert.equal(bookCoverUrl({ cover: 'data:text/html;base64,PGI+', asin: 'B000000000' }), 'https://images-na.ssl-images-amazon.com/images/P/B000000000.09.MZZZZZZZ.jpg');
  assert.equal(isUploadedCover(COVER), true);
  assert.equal(isUploadedCover('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isUploadedCover('data:image/png;base64,"><script>'), false);
  assert.equal(isUploadedCover('data:image/jpeg;base64,' + 'A'.repeat(600000)), false);
});

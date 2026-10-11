// NIH-139 本ごと削除した本も、削除した点の画面（ゴミ箱）から点ごと戻せる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteBook, deletedBooks, deletedHighlights, emptyLibrary, listBooks, liveHighlights, mergeLibraries, mergeParsed, restoreBook, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const T1 = '2026-10-10T00:01:00.000Z';
const T2 = '2026-10-10T00:02:00.000Z';
const T3 = '2026-10-10T00:03:00.000Z';
const T4 = '2026-10-10T00:04:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

const st = (library) => ({ library, analysis: null, settings: { ai: { mode: 'companion', companionUrl: '', token: '', baseUrl: '', chatModel: '', embedModel: '' }, autoSync: false }, servedByCompanion: false, lastSync: null });

/** 本の点の 1 つに自分のメモ・タグ・★を付け、別の 1 つは先に点だけ削除してから、本を削除する */
function withDeletedBook() {
  const lib = sample();
  const book = listBooks(lib)[0];
  const [edited, alone, ...rest] = liveHighlights(lib).filter((h) => h.bookId === book.id);
  updateHighlight(lib, edited.id, { userNote: '自分のメモ', tags: ['習慣'], favorite: true }, T1);
  updateHighlight(lib, alone.id, { deleted: true }, T1);
  deleteBook(lib, book.id, T2);
  return { lib, book, edited, alone, rest };
}

test('deletedBooks: 削除した本と、本といっしょに削除した点の数を、削除した時刻の新しい順に返す', () => {
  const lib = sample();
  const [a, b, c] = listBooks(lib);
  const count = (id) => liveHighlights(lib).filter((h) => h.bookId === id).length;
  const counts = [a, b, c].map((x) => count(x.id));
  deleteBook(lib, a.id, T1);
  deleteBook(lib, b.id, T3);
  deleteBook(lib, c.id, T2);
  assert.deepEqual(
    deletedBooks(lib).map(({ book, count }) => [book.id, count]),
    [
      [b.id, counts[1]],
      [c.id, counts[2]],
      [a.id, counts[0]],
    ],
  );
});

test('deletedBooks: 本を削除する前に点だけ削除していた点は、本の点の数に入れない', () => {
  const { lib, book, rest } = withDeletedBook();
  assert.deepEqual(deletedBooks(lib).map(({ book, count }) => [book.id, count]), [[book.id, rest.length + 1]]);
});

test('restoreBook: 本と、本といっしょに削除した点をメモ・タグ・★ごと戻す。先に点だけ削除していた点は削除したまま', () => {
  const { lib, book, edited, alone, rest } = withDeletedBook();
  assert.equal(restoreBook(lib, book.id, T3), rest.length + 1);
  assert.ok(!lib.books[book.id].deleted);
  assert.equal(lib.books[book.id].userUpdatedAt, T3, '同期で戻した方が勝つよう時刻を進める');
  for (const h of [edited, ...rest]) {
    const back = lib.highlights[h.id];
    assert.ok(!back.deleted && !back.deletedWithBook);
    assert.equal(back.userUpdatedAt, T3);
  }
  const back = lib.highlights[edited.id];
  assert.deepEqual([back.userNote, back.tags, back.favorite], ['自分のメモ', ['習慣'], true]);
  assert.ok(lib.highlights[alone.id].deleted, '本より前に削除した点は戻さない');
  assert.deepEqual(deletedBooks(lib), []);
  assert.deepEqual(deletedHighlights(lib).map((h) => h.id), [alone.id], '本が戻ったので、点だけ削除した点は一覧に出る');
  assert.equal(lib.updatedAt, T3);
});

test('restoreBook: 見つからない本・削除していない本には何もせず null を返す', () => {
  const lib = sample();
  const book = listBooks(lib)[0];
  const before = JSON.stringify(lib);
  assert.equal(restoreBook(lib, 'bnone', T3), null);
  assert.equal(restoreBook(lib, book.id, T3), null);
  assert.equal(JSON.stringify(lib), before);
});

test('戻した本と点は、同期（統合）で削除したままの端末にも戻る', () => {
  const { lib: pc, book, edited, rest } = withDeletedBook();
  const phone = structuredClone(pc);
  restoreBook(phone, book.id, T3);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.ok(!merged.books[book.id].deleted, '戻した方（新しい方）が勝つ');
    for (const h of [edited, ...rest]) assert.ok(!merged.highlights[h.id].deleted && !merged.highlights[h.id].deletedWithBook);
    const back = merged.highlights[edited.id];
    assert.deepEqual([back.userNote, back.tags, back.favorite], ['自分のメモ', ['習慣'], true]);
    assert.deepEqual(deletedBooks(merged), []);
  }
});

test('戻した後に別の端末で本を削除し直したら、新しい方の削除が勝つ', () => {
  const { lib: pc, book } = withDeletedBook();
  restoreBook(pc, book.id, T3);
  const phone = structuredClone(pc);
  deleteBook(phone, book.id, T4);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.ok(merged.books[book.id].deleted);
    assert.equal(deletedBooks(merged).length, 1);
  }
});

test('取り込み直しで本が復活する処理も同じ（本といっしょに削除した点だけ戻る）', () => {
  const { lib, book, edited, alone } = withDeletedBook();
  mergeParsed(lib, SAMPLE_BOOKS.filter((b) => b.title === book.title), { now: T3 });
  assert.ok(!lib.books[book.id].deleted);
  assert.ok(!lib.highlights[edited.id].deleted);
  assert.ok(lib.highlights[alone.id].deleted);
});

test('ゴミ箱の画面: 削除した本の書名・著者・点の数と「元に戻す」を出す', async () => {
  const { trashView } = await import('../web/js/views/trash.js');
  const { lib, book, rest } = withDeletedBook();
  const out = String(trashView.render({ state: st(lib) }));
  assert.match(out, /<h2>削除した本<\/h2>/);
  assert.ok(out.includes(book.title), '書名');
  if (book.author) assert.ok(out.includes(book.author), '著者');
  assert.ok(out.includes(`点 ${rest.length + 1} 件`), '点の数');
  assert.match(out, new RegExp(`<button type="button" class="btn small" data-action="restore-book" data-id="${book.id}">元に戻す</button>`));
  // 削除した本は本の画面を開けないので、書名はリンクにしない
  assert.ok(!out.includes(`href="#/book/${book.id}"`));
});

test('ゴミ箱の画面: 削除した本だけがあるときも「削除した点はありません」と出さない', async () => {
  const { trashView } = await import('../web/js/views/trash.js');
  const lib = sample();
  deleteBook(lib, listBooks(lib)[0].id, T1);
  const out = String(trashView.render({ state: st(lib) }));
  assert.doesNotMatch(out, /削除した点はありません/);
  assert.doesNotMatch(out, /<h2>削除した点<\/h2>/, '削除した点が無ければ点の節は出さない');
  assert.match(out, /data-action="restore-book"/);
});

test('設定の「データ」の件数は、削除した点と削除した本を合わせて数える', async (t) => {
  globalThis.location = { origin: 'http://localhost:8787' };
  t.after(() => delete globalThis.location);
  const { settingsView } = await import('../web/js/views/settings.js');
  const { lib } = withDeletedBook();
  const out = String(settingsView.render({ state: st(lib) }));
  assert.match(out, /<a class="row spread" href="#\/trash"><b>削除した点<\/b><span class="muted">本 1 冊 ›<\/span><\/a>/);
  const other = liveHighlights(lib)[0];
  updateHighlight(lib, other.id, { deleted: true }, T3);
  const out2 = String(settingsView.render({ state: st(lib) }));
  assert.match(out2, /<span class="muted">1 件・本 1 冊 ›<\/span>/);
});

test('一覧の「元に戻す」（本）: 本と点を戻し、端末に保存してから描き直し・同期・通知する', async () => {
  const { fakeApp, button } = await import('./helpers/app-actions.js');
  const { lib, book, rest } = withDeletedBook();
  const app = fakeApp({ library: lib, loaded: true });
  await app.actions['restore-book'](button({ id: book.id }));
  assert.ok(!lib.books[book.id].deleted);
  assert.deepEqual(app.log, ['persist', 'render', 'sync', 'toast']);
  assert.equal(app.toasts[0].message, `『${book.title}』と点 ${rest.length + 1} 件を元に戻しました`);
});

test('一覧の「元に戻す」（本）: 本が見つからない・もう戻っていたら理由を投げる', async () => {
  const { fakeApp, button } = await import('./helpers/app-actions.js');
  const app = fakeApp({ library: sample(), loaded: true });
  await assert.rejects(() => app.actions['restore-book'](button({ id: 'bnone' })), /この本はもう見つかりません/);
  assert.deepEqual(app.log, []);
});

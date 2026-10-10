import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { booksNeedingIsbn, fillMissingIsbns, findIsbn, titleCandidates } from '../cli/covers.js';
import { bookCoverUrl, isbn10 } from '../web/core/covers.js';
import { emptyLibrary, mergeLibraries } from '../web/core/model.js';

const AMAZON = (id) => `https://images-na.ssl-images-amazon.com/images/P/${id}.09.MZZZZZZZ.jpg`;

/** 国立国会図書館サーチの OpenSearch（RSS）の偽物。books: [{ title, creator, isbn }] */
function fakeNdl(books, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://ndlsearch.ndl.go.jp/api/opensearch');
    calls.push(Object.fromEntries(u.searchParams));
    if (status !== 200) return new Response('error', { status });
    // 本物の検索と同じく、全角・半角の違いは同じものとして探す
    const title = u.searchParams.get('title').normalize('NFKC');
    const items = books
      .filter((b) => b.title.normalize('NFKC').includes(title))
      .map((b) => `<item><category>図書</category><dc:title>${b.title}</dc:title><dc:creator>${b.creator}</dc:creator>${b.isbn ? `<dc:identifier xsi:type="dcndl:ISBN">${b.isbn}</dc:identifier>` : ''}</item>`);
    return new Response(`<rss><channel>${items.join('')}</channel></rss>`);
  };
  return { fetchImpl, calls };
}

test('isbn10: 978 で始まる ISBN-13 を ISBN-10 にする（チェック数字 X も）。979・形の違う値は空', () => {
  assert.equal(isbn10('9784297145712'), '4297145715');
  assert.equal(isbn10('978-4-7993-2443-1'), '4799324438');
  assert.equal(isbn10('9780804429573'), '080442957X');
  assert.equal(isbn10('4492531122'), '4492531122');
  assert.equal(isbn10('9791234567896'), '');
  assert.equal(isbn10('abc'), '');
  assert.equal(isbn10(undefined), '');
});

test('bookCoverUrl: ISBN があれば Amazon の表紙（ISBN-10）を Play ブックスの書籍 ID より優先する。ASIN とアップロードした表紙はさらに優先', () => {
  assert.equal(bookCoverUrl({ isbn: '9784297145712', volumeId: 'f211OQAAAEAJ' }), AMAZON('4297145715'));
  assert.equal(bookCoverUrl({ isbn: '9784297145712', asin: 'B0D8N5G9GT' }), AMAZON('B0D8N5G9GT'));
  const uploaded = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(bookCoverUrl({ isbn: '9784297145712', cover: uploaded }), uploaded);
  // ISBN-10 にできない・形の違う ISBN は使わず、書籍 ID の表紙に戻る
  assert.match(bookCoverUrl({ isbn: '9791234567896', volumeId: 'f211OQAAAEAJ' }), /books\.google\.com/);
  assert.match(bookCoverUrl({ isbn: '"><img', volumeId: 'f211OQAAAEAJ' }), /books\.google\.com/);
});

test('titleCandidates: 書名そのまま → 括弧を除く → 副題を除く → 空白で区切った最も長い語 の順（重複なし）', () => {
  assert.deepEqual(titleCandidates('新！働く理由'), ['新！働く理由']);
  assert.deepEqual(titleCandidates('マキァヴェッリ 『君主論』をよむ (岩波新書)'), ['マキァヴェッリ 『君主論』をよむ (岩波新書)', 'マキァヴェッリ 『君主論』をよむ', '『君主論』をよむ']);
  assert.deepEqual(titleCandidates('難しく考えないGit＆GitHub vol.1: Git＆GitHubの基本'), ['難しく考えないGit＆GitHub vol.1: Git＆GitHubの基本', '難しく考えないGit＆GitHub vol.1', '難しく考えないGit＆GitHub']);
  assert.deepEqual(titleCandidates('新版 問題解決プロフェッショナル'), ['新版 問題解決プロフェッショナル', '問題解決プロフェッショナル']);
});

test('findIsbn: 書名と著者が一致する本の ISBN を返す。長い書名は短くして探し直す。無ければ空', async () => {
  const ndl = fakeNdl([
    { title: '新!働く理由', creator: '戸田, 智弘, 1960-', isbn: '978-4-7993-2443-1' },
    { title: 'プロジェクトマネジメントの基本が全部わかる本', creator: '橋本, 将功', isbn: '9784798160832' },
    { title: '別の人の働く理由', creator: '別人', isbn: '9784000000000' },
  ]);
  assert.equal(await findIsbn({ title: '新！働く理由', author: '戸田智弘' }, { fetchImpl: ndl.fetchImpl }), '9784799324431');
  assert.equal(await findIsbn({ title: 'プロジェクトマネジメントの基本が全部わかる本 交渉・タスクマネジメント', author: '橋本 将功' }, { fetchImpl: ndl.fetchImpl }), '9784798160832');
  // 著者が合わない本は採らない
  assert.equal(await findIsbn({ title: '別の人の働く理由', author: '戸田智弘' }, { fetchImpl: ndl.fetchImpl }), '');
  // 著者で絞って探す（姓だけ）
  assert.equal(ndl.calls[0].creator, '戸田智弘');
  assert.equal(ndl.calls[0].mediatype, 'books');
});

test('findIsbn: ISBN の無い・ISBN-10 にできない版は飛ばす。通信できなければ例外', async () => {
  const ndl = fakeNdl([
    { title: '夜と霧', creator: 'フランクル', isbn: '' },
    { title: '夜と霧', creator: 'フランクル', isbn: '9791234567896' },
    { title: '夜と霧', creator: 'フランクル', isbn: '4622039702' },
  ]);
  assert.equal(await findIsbn({ title: '夜と霧', author: 'フランクル' }, { fetchImpl: ndl.fetchImpl }), '4622039702');
  await assert.rejects(findIsbn({ title: '夜と霧', author: '' }, { fetchImpl: fakeNdl([], { status: 503 }).fetchImpl }), /HTTP 503/);
});

function libraryWith(books) {
  const lib = emptyLibrary();
  for (const b of books) lib.books[b.id] = { sources: ['playbooks'], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...b };
  return lib;
}

test('booksNeedingIsbn: Play ブックスの本で、アップロードした表紙・ASIN・ISBN が無く、まだ探していない本だけ', () => {
  const lib = libraryWith([
    { id: 'b1', title: '探す本', volumeId: 'f211OQAAAEAJ' },
    { id: 'b2', title: 'ISBN あり', isbn: '9784297145712' },
    { id: 'b3', title: 'ASIN あり', asin: 'B0D8N5G9GT' },
    { id: 'b4', title: '表紙あり', cover: 'data:image/png;base64,iVBORw0KGgo=' },
    { id: 'b5', title: '削除した本', deleted: true },
    { id: 'b6', title: 'Kindle の本', sources: ['kindle'] },
    { id: 'b7', title: '探した本' },
  ]);
  assert.deepEqual(booksNeedingIsbn(lib, { b7: '2026-10-01T00:00:00.000Z' }).map((b) => b.id), ['b1']);
});

test('fillMissingIsbns: 見つかった ISBN を本に付け、探した本は記録して二度探さない。通信できなければ記録しない', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-cover-')));
  await store.saveLibrary(libraryWith([
    { id: 'b1', title: '新！働く理由', author: '戸田智弘', volumeId: 'f211OQAAAEAJ' },
    { id: 'b2', title: '見つからない本', author: '誰か' },
  ]));
  await store.saveState({ kindleSync: { ok: true } });

  // 通信できない → 何も付けず、記録もしない（次の確認で探し直す）
  const down = await fillMissingIsbns({ store, fetchImpl: fakeNdl([], { status: 503 }).fetchImpl });
  assert.deepEqual(down, { checked: 0, found: 0 });
  assert.equal((await store.state()).coverLookup, undefined);

  const ndl = fakeNdl([{ title: '新!働く理由', creator: '戸田, 智弘', isbn: '9784799324431' }]);
  const r = await fillMissingIsbns({ store, fetchImpl: ndl.fetchImpl });
  assert.deepEqual(r, { checked: 2, found: 1 });
  const lib = await store.library();
  assert.equal(lib.books.b1.isbn, '9784799324431');
  assert.ok(lib.books.b1.updatedAt > '2026-10-01T00:00:00.000Z', 'ほかの端末へ届くよう更新時刻を進める');
  assert.equal(lib.books.b2.isbn, undefined);
  assert.equal(bookCoverUrl(lib.books.b1), AMAZON('4799324438'));
  const st = await store.state();
  assert.deepEqual(Object.keys(st.coverLookup.tried).sort(), ['b1', 'b2']);
  assert.deepEqual(st.kindleSync, { ok: true }, 'state.json のほかの記録は残す');

  const calls = ndl.calls.length;
  assert.deepEqual(await fillMissingIsbns({ store, fetchImpl: ndl.fetchImpl }), { checked: 0, found: 0 });
  assert.equal(ndl.calls.length, calls, '探した本はもう探さない');
});

test('fillMissingIsbns: 1 回に探すのは max 冊まで（残りは次の確認で）', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-cover-')));
  await store.saveLibrary(libraryWith([1, 2, 3].map((n) => ({ id: `b${n}`, title: `本${n}` }))));
  const ndl = fakeNdl([]);
  assert.equal((await fillMissingIsbns({ store, fetchImpl: ndl.fetchImpl, max: 2 })).checked, 2);
  assert.equal((await fillMissingIsbns({ store, fetchImpl: ndl.fetchImpl, max: 2 })).checked, 1);
});

test('mergeLibraries: PC が付けた ISBN はスマホ側へ届く', () => {
  const phone = libraryWith([{ id: 'b1', title: '新！働く理由' }]);
  const pc = libraryWith([{ id: 'b1', title: '新！働く理由', isbn: '9784799324431', updatedAt: '2026-10-11T00:00:00.000Z' }]);
  assert.equal(mergeLibraries(phone, pc).books.b1.isbn, '9784799324431');
});

// 境界・異常系のテスト（欲しい本 / PC 側の CLI・サーバ・保存 / 拡張の共通部分 / html.js）
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  amazonKindleUrl,
  applyImportedMarks,
  bookmeterUrl,
  collectMarks,
  filterWishlist,
  findWishlistBook,
  formatPrice,
  loadMarks,
  memoryStore,
  parseMarksFile,
  parseWishlist,
  priceChange,
  priceSparkline,
  priceTotal,
  readingLookup,
  searchWishlist,
  titleKey,
  wishlistForRecommend,
  wishlistSummary,
} from '../web/core/wishlist.js';
import { esc, html, mark, raw, safeUrl } from '../web/js/html.js';
import { chunk, importBody, isReachableCompanionUrl, pickBooksToFetch, statusReport, toBase64Utf8 } from '../extension/sync-core.js';
import { createStore, historyId } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { createGoogleClient, isFolderId, startDriveWatcher } from '../cli/google.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BH = path.join(ROOT, 'cli/bh.js');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

const wl = (books, extra = {}) => parseWishlist({ format: 'kindle-wishlist', version: 1, books, ...extra });
const items = (books) => wl(books).books.map((book) => ({ book, marks: { ...book.saved } }));

// ---------------------------------------------------------------- wishlist.js

test('edge wishlist: 形式の違うデータ・版違いは理由つきで失敗する', () => {
  for (const bad of [null, undefined, 0, 'x', [], {}, { format: 'kindle-wishlist' }, { format: 'kindle-wishlist', books: {} }, { format: 'other', version: 1, books: [] }]) {
    assert.throws(() => parseWishlist(bad), /形式ではありません/);
  }
  assert.throws(() => parseWishlist({ format: 'kindle-wishlist', books: [] }), /版（undefined）/);
  assert.throws(() => parseWishlist({ format: 'kindle-wishlist', version: '1', books: [] }), /版/);
  assert.throws(() => parseWishlist({ format: 'kindle-wishlist', version: 2, books: [] }), /版（2）/);
});

test('edge wishlist: 空の一覧・壊れた行でも落ちず既定値になる', () => {
  const empty = wl([]);
  assert.deepEqual(empty, { lastScraped: null, books: [] });
  assert.equal(wl([], { last_scraped: 12345 }).lastScraped, null);
  const { books } = wl([null, undefined, 42, 'str', [], {}]);
  assert.equal(books.length, 6);
  for (const [i, b] of books.entries()) {
    assert.equal(b.asin, '');
    assert.equal(typeof b.title, 'string');
    assert.equal(b.price, null);
    assert.equal(b.trend, null);
    assert.deepEqual(b.history, []);
    assert.deepEqual(b.saved, { tag: '', rating: '', kind: 'book' });
    assert.equal(b.index, i);
  }
  assert.equal(books[0].title, '');
});

test('edge wishlist: 価格は 0 以上の有限な数だけ（文字列・カンマ・円記号・負・NaN は価格なし）', () => {
  const prices = [0, 1200, -1, '1200', '1,200', '¥500', '￥500', NaN, Infinity, null, undefined, true, 12.5];
  const { books } = wl(prices.map((price, i) => ({ asin: `B00000000${i % 10}`, title: `t${i}`, price })));
  assert.deepEqual(
    books.map((b) => b.price),
    [0, 1200, null, null, null, null, null, null, null, null, null, null, 12.5],
  );
  // 価格 0 円は「価格あり」（合計・並べ替えに入り、表示は ¥0）
  assert.equal(formatPrice(books[0]), '¥0');
  assert.equal(formatPrice({ ku: false, price: 1234567 }), '¥1,234,567');
  assert.equal(formatPrice(wl([{ price_reason: '__proto__' }]).books[0]), '価格情報なし');
  const t = priceTotal(books.map((book) => ({ book })));
  assert.deepEqual(t, { total: 1212.5, priced: 3, unpriced: 10 });
  // KU は価格を持たない
  assert.equal(wl([{ price: 500, ku: true }]).books[0].price, null);
});

test('edge wishlist: 数値で来た ASIN・本 ID は文字列として扱わない', () => {
  const [b] = wl([{ asin: 1234567890, bookmeter_id: 123, title: 'x' }]).books;
  assert.equal(b.asin, '');
  assert.equal(b.bookmeterId, '');
  assert.equal(bookmeterUrl({ bookmeterId: 123 }), '');
  assert.equal(amazonKindleUrl({ asin: 1234567890, title: 'x' }), 'https://www.amazon.co.jp/s?k=x&i=digital-text');
  assert.deepEqual(wishlistForRecommend([{ title: 'x', asin: 1234567890 }])[0].asin, '');
  const imported = parseMarksFile({ format: 'kindle-marks', version: 1, items: [{ asin: 1234567890, tag: 'wanted' }] });
  assert.deepEqual(imported.entries, []);
  // 文字列の 10 桁（ISBN-10 の ASIN）は通る
  assert.equal(wl([{ asin: '4101010013' }]).books[0].asin, '4101010013');
});

test('edge wishlist: ★は「読んだ」の 1〜5 の整数だけ', () => {
  const rows = [5, 1, 0, 6, 5.5, '5', null].map((rating) => ({ tag: 'seen', rating }));
  assert.deepEqual(
    wl(rows).books.map((b) => b.saved.rating),
    ['5', '1', '', '', '', '', ''],
  );
  assert.equal(wl([{ tag: 'wanted', rating: 5 }]).books[0].saved.rating, '');
  assert.equal(wl([{ tag: 'unwanted' }]).books[0].saved.tag, '');
  assert.equal(wl([{ tag: 'toString' }]).books[0].saved.tag, '');
  assert.equal(wl([{ kind: 'MANGA' }]).books[0].saved.kind, 'book');
});

test('edge wishlist: 価格の履歴は日時のある行だけ・値動きは前回価格があるときだけ', () => {
  const [b] = wl([{ price: 800, price_prev: 1000, price_low: 'x', price_changed_at: 5, price_history: [null, { at: 1 }, { at: '2026-01-01', price: '9' }, { at: '2026-01-02', price: 800, ku: 'yes' }] }]).books;
  assert.deepEqual(b.history, [
    { at: '2026-01-01', price: null, ku: false },
    { at: '2026-01-02', price: 800, ku: false },
  ]);
  assert.deepEqual(b.trend, { prev: 1000, changedAt: null, low: null });
  assert.deepEqual(priceChange(b), { diff: -200, changedAt: null, lowest: false });
  assert.equal(wl([{ price_history: 'nope' }]).books[0].history.length, 0);
  assert.equal(priceChange(wl([{ price: 800 }]).books[0]), null);
});

test('edge wishlist: 価格のグラフ（点が足りない・同時刻・同じ価格・壊れた日時・逆順）', () => {
  assert.equal(priceSparkline(undefined), null);
  assert.equal(priceSparkline([]), null);
  assert.equal(priceSparkline([{ at: '2026-01-01', price: 100 }]), null);
  assert.equal(priceSparkline([{ at: 'bad', price: 100 }, { at: '2026-01-01', price: 200 }, null, { at: '2026-01-02', price: null }]), null);
  // 同じ時刻なら横は並び順、同じ価格なら縦は真ん中
  const same = priceSparkline([{ at: '2026-01-01', price: 100 }, { at: '2026-01-01', price: 100 }], { width: 100, height: 20, pad: 0 });
  assert.deepEqual(same.points, [[0, 10], [100, 10]]);
  // 逆順で来ても古い順に並べる。高い価格ほど上（y が小さい）
  const s = priceSparkline([{ at: '2026-01-03', price: 300 }, { at: '2026-01-01', price: 100 }], { width: 100, height: 20, pad: 0 });
  assert.equal(s.first, 100);
  assert.equal(s.last, 300);
  assert.deepEqual(s.points, [[0, 20], [100, 0]]);
  for (const [x, y] of s.points) assert.ok(Number.isFinite(x) && Number.isFinite(y));
});

test('edge wishlist: 並べ替えは同じ値なら元の順（安定）・価格なしはどちら向きでも後ろ', () => {
  const list = items([
    { title: 'B', price: 500 },
    { title: 'A', price: null },
    { title: 'B', price: 500 },
    { title: 'A', price: 0 },
    { title: 'C', ku: true, price: 100 },
  ]);
  const idx = (sort) => filterWishlist(list, { sort }).items.map((i) => i.book.index);
  assert.deepEqual(idx('title'), [1, 3, 0, 2, 4]);
  assert.deepEqual(idx('price-asc'), [3, 0, 2, 1, 4]);
  assert.deepEqual(idx('price-desc'), [0, 2, 3, 1, 4]);
  assert.deepEqual(idx('price-drop'), [0, 1, 2, 3, 4]);
  assert.deepEqual(idx('scraped-desc'), [0, 1, 2, 3, 4]);
  assert.deepEqual(idx('no-such-sort'), [0, 1, 2, 3, 4]);
  // 取得日時のある本が先、無い本は後ろ
  const dated = items([{ title: 'x' }, { title: 'y', scraped_at: '2026-01-01T00:00:00Z' }, { title: 'z', scraped_at: '2026-02-01T00:00:00Z' }]);
  assert.deepEqual(filterWishlist(dated, { sort: 'scraped-desc' }).items.map((i) => i.book.title), ['z', 'y', 'x']);
});

test('edge wishlist: 価格帯（0・上下逆・数字でない入力）と空の一覧', () => {
  const list = items([{ title: 'free', price: 0 }, { title: 'none' }, { title: 'mid', price: 800 }]);
  const titles = (f) => filterWishlist(list, f).items.map((i) => i.book.title);
  assert.deepEqual(titles({ min: '0' }), ['free', 'mid']);
  assert.deepEqual(titles({ max: '0' }), ['free']);
  assert.deepEqual(titles({ min: 'abc', max: '' }), ['free', 'none', 'mid']);
  const inv = filterWishlist(list, { min: '900', max: '100' });
  assert.equal(inv.priceRangeInvalid, true);
  assert.equal(inv.items.length, 3);
  assert.deepEqual(filterWishlist([], { q: 'x', sort: 'title' }), { items: [], priceRangeInvalid: false });
  assert.deepEqual(filterWishlist(list), { items: list, priceRangeInvalid: false });
  // 全角の語でも当たる
  assert.deepEqual(titles({ q: 'ＭＩＤ' }), ['mid']);
  assert.deepEqual(titles({ q: '   ' }), ['free', 'none', 'mid']);
});

test('edge wishlist: 検索・照合・要約の空入力', () => {
  const books = wl([{ title: '夜と霧' }, { title: null }, { title: '7つの習慣（完訳版）' }]).books;
  assert.deepEqual(searchWishlist(books, ''), []);
  assert.deepEqual(searchWishlist(books, '#tag'), []);
  assert.deepEqual(searchWishlist(books, null), []);
  assert.equal(findWishlistBook(books, []), undefined);
  assert.equal(findWishlistBook(books, ['', null, '（文庫）']), undefined);
  assert.equal(findWishlistBook(books, '夜'), undefined, '短い語の前方一致はしない');
  assert.equal(findWishlistBook(books, '7つの習慣').exact, true);
  assert.equal(findWishlistBook([], 'x'), undefined);
  assert.equal(titleKey(null), '');
  assert.equal(titleKey(undefined), '');
  assert.deepEqual(wishlistSummary([]), { total: 0, kuCount: 0, picks: [] });
  const look = readingLookup([{ asin: 'nope', title: '', count: 1 }]);
  assert.equal(look({ asin: '', title: '' }), null);
});

test('edge wishlist: おすすめに渡す欲しい本の確かめ（PC が受け取る値）', () => {
  for (const bad of [null, undefined, {}, 'x', 1]) assert.deepEqual(wishlistForRecommend(bad), []);
  assert.deepEqual(wishlistForRecommend([null, 1, 'x', { title: '' }, { title: '   ' }, { title: 5 }]), []);
  const [a, b] = wishlistForRecommend([{ title: `  ${'あ'.repeat(300)}  `, price: 12.5, skip: 'yes' }, { title: 'x', price: -1, ku: true }]);
  assert.equal(a.title.length, 200);
  assert.equal(a.price, null);
  assert.equal(a.skip, false);
  assert.deepEqual(b, { title: 'x', asin: '', price: null, ku: true, skip: false });
  assert.equal(wishlistForRecommend(Array.from({ length: 1500 }, (_, i) => ({ title: `t${i}` }))).length, 1000);
});

test('edge wishlist: 保存値の壊れた値は無視・同じ ASIN の重複は 1 冊として書き出す', () => {
  const [book] = wl([{ asin: 'B000000001', title: 'x', tag: 'wanted' }]).books;
  const store = memoryStore({ 'book-tag:B000000001': 'bogus', 'book-rating:B000000001': '9', 'book-kind:B000000001': 'zine' });
  assert.deepEqual(loadMarks(book, store), { tag: 'wanted', rating: '', kind: 'book' });

  const s2 = memoryStore({ 'book-tag:B000000001': 'seen', 'book-rating:B000000001': '4' });
  const dup = [book, { ...book, index: 1 }].map((b) => ({ book: b, marks: loadMarks(b, s2) }));
  const summary = collectMarks(dup, s2);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.seen, 1);
  assert.deepEqual(summary.items[0], { asin: 'B000000001', title: 'x', tag: 'seen', rating: 4 });

  // 取り込みでは同じ ASIN の行すべての状態を合わせる
  const r = applyImportedMarks(dup, memoryStore(), { exportedAt: 0, entries: [{ asin: 'B000000001', tag: 'purchased', rating: '' }, { asin: 'B999999999', kind: 'manga' }] }, 1000);
  assert.deepEqual(r, { applied: 1, skipped: 1, kept: 0 });
  assert.ok(dup.every((i) => i.marks.tag === 'purchased'));
});

test('edge wishlist: タグのファイルの読み込み（壊れた行・廃止したタグ・壊れた日時）', () => {
  for (const bad of [null, [], {}, { format: 'kindle-marks', items: {} }]) assert.throws(() => parseMarksFile(bad), /ではありません/);
  assert.throws(() => parseMarksFile({ format: 'kindle-marks', items: [] }), /版/);
  const r = parseMarksFile({
    format: 'kindle-marks',
    version: 1,
    exported_at: 'not a date',
    items: [null, 'x', { asin: 'b000000001', tag: 'seen' }, { asin: 'B000000001', tag: 'unwanted', rating: 5 }, { asin: 'B000000002', tag: 'seen', rating: 3.5 }, { asin: 'B000000003' }, { asin: 'B000000004', tag: 'nope', kind: 'manga' }],
  });
  assert.equal(r.exportedAt, 0);
  assert.deepEqual(r.entries, [
    { asin: 'B000000001', tag: '', rating: '' },
    { asin: 'B000000002', tag: 'seen', rating: '' },
    { asin: 'B000000004', kind: 'manga' },
  ]);
});

// ---------------------------------------------------------------- html.js

test('edge html: esc は & < > " \' をすべて置き換え、文字列以外も文字列にする', () => {
  assert.equal(esc(`<a href="x" onclick='y'>&amp;</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
  assert.equal(esc(NaN), 'NaN');
  assert.equal(esc({ toString: () => '<b>' }), '&lt;b&gt;');
  assert.equal(esc(['<a>', '"']), '&lt;a&gt;,&quot;');
  assert.equal(esc(Symbol.for('x').description), 'x');
});

test('edge html: html`` の埋め込み（0・null・false・入れ子の配列・raw）', () => {
  assert.equal(String(html`<p>${0}</p>`), '<p>0</p>');
  assert.equal(String(html`<p>${null}${undefined}${false}</p>`), '<p></p>');
  assert.equal(String(html`<p>${true}</p>`), '<p>true</p>');
  assert.equal(String(html`<ul>${[['<i>', raw('<b>')], html`<li>${'&'}</li>`]}</ul>`), '<ul>&lt;i&gt;<b><li>&amp;</li></ul>');
  assert.equal(String(html`<a title="${'" onmouseover="x'}">`), '<a title="&quot; onmouseover=&quot;x">');
  assert.equal(String(raw(null)), '');
  assert.equal(String(raw(5)), '5');
  assert.equal(String(html`x`), 'x');
});

test('edge html: mark は正規表現の記号を含む語・& を含む語でも安全にハイライトする', () => {
  assert.equal(String(mark('a.b*c (d) [e]', '.b* (d)')), 'a<mark>.b*</mark>c <mark>(d)</mark> [e]');
  assert.equal(String(mark('a&b<c>', '&')), 'a<mark>&amp;</mark>b&lt;c&gt;');
  assert.equal(String(mark('<script>', 'script')), '&lt;<mark>script</mark>&gt;');
  assert.equal(String(mark('x', '#tag')), 'x');
  assert.equal(String(mark(null, 'x')), '');
  assert.equal(String(mark(123, '2')), '1<mark>2</mark>3');
  assert.equal(String(mark('ABC abc', 'ｂ')), 'A<mark>B</mark>C a<mark>b</mark>c');
  assert.equal(String(mark('a\\b', '\\')), 'a<mark>\\</mark>b');
});

test('edge html: safeUrl は https だけ通す', () => {
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'http://x', 'data:text/html,x', '//x', '', null, undefined, 5, {}, 'https//x']) assert.equal(safeUrl(bad), '', String(bad));
  assert.equal(safeUrl('  https://example.com/a b'), 'https://example.com/a%20b');
  assert.equal(safeUrl('HTTPS://EXAMPLE.com'), 'https://example.com/');
});

// ---------------------------------------------------------------- extension/sync-core.js

test('edge sync-core: 取り込む本の選択・本文・URL・報告の境界', () => {
  assert.deepEqual(pickBooksToFetch([], {}), []);
  const books = [{ asin: 'A', lastAnnotated: '2026-01-02' }, { asin: 'B', lastAnnotated: '2026-01-01' }, { asin: 'C', lastAnnotated: '' }];
  assert.deepEqual(pickBooksToFetch(books, { A: '2026-01-02', B: '2026-01-01' }).map((b) => b.asin), ['A', 'C']);
  assert.deepEqual(pickBooksToFetch(books, { A: '2026-01-02', B: '2026-01-01', C: '' }, { lastTopDate: '2026-01-01' }).map((b) => b.asin), ['A', 'B']);

  const body = importBody([{ asin: 'A', highlights: [] }, { asin: 'B' }, { asin: 'C', title: '日本語😀', highlights: [{ text: 'x'.repeat(70000) }] }], new Date('2026-03-04T05:06:07Z'));
  assert.equal(body.auto, true);
  assert.equal(body.files[0].name, 'kindle-auto-2026-03-04.json');
  const decoded = JSON.parse(Buffer.from(body.files[0].base64, 'base64').toString('utf8'));
  assert.deepEqual(decoded.books.map((b) => b.asin), ['C']);
  assert.equal(decoded.books[0].title, '日本語😀');
  assert.equal(toBase64Utf8(''), '');

  for (const ok of ['http://localhost:8787', 'http://127.0.0.1', 'https://pc.tail1234.ts.net']) assert.equal(isReachableCompanionUrl(ok), true, ok);
  for (const bad of ['https://localhost', 'http://pc.ts.net', 'https://ts.net.evil.com', 'https://evil.com/.ts.net', 'http://0.0.0.0', '', null, 'not a url']) assert.equal(isReachableCompanionUrl(bad), false, String(bad));

  assert.deepEqual(statusReport({ ok: 1, added: -3, error: 'e'.repeat(500) }, { intervalMin: 'abc' }), { ok: true, needLogin: false, added: 0, intervalMin: 15, error: 'e'.repeat(300) });
  assert.deepEqual(statusReport({ added: 2.5, error: null }, { intervalMin: '30' }), { ok: false, needLogin: false, added: 0, intervalMin: 30, error: '' });
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

// ---------------------------------------------------------------- cli/store.js

test('edge store: 無いフォルダ・壊れたファイル・null の設定', async () => {
  const dir = path.join(tmp('bh-edge-store-'), 'nested', 'deeper');
  const store = createStore(dir);
  // 無いフォルダなら既定値を返し、保存するとフォルダを作る
  assert.equal((await store.library()).books !== undefined, true);
  assert.equal(await store.analysis(), null);
  assert.deepEqual(await store.history(), []);
  assert.equal((await store.config()).port, 8787);
  await store.saveState({ a: 1 });
  assert.deepEqual(await store.state(), { a: 1 });

  writeFileSync(path.join(dir, 'library.json'), '{ broken');
  await assert.rejects(store.library(), /library\.json を読めませんでした/);
  writeFileSync(path.join(dir, 'state.json'), '');
  await assert.rejects(store.state(), /state\.json を読めませんでした/);

  // JSON としては正しい null / 配列の設定でも既定値で読める
  writeFileSync(path.join(dir, 'config.json'), 'null');
  const cfg = await store.config();
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.llm.baseUrl, 'http://127.0.0.1:11434');
  writeFileSync(path.join(dir, 'config.json'), '{"llm": null, "google": null, "autoAnalyze": null}');
  const cfg2 = await store.config();
  assert.equal(cfg2.google.intervalSec, 60);
  assert.equal(typeof cfg2.autoAnalyze, 'object');
});

test('edge store: 履歴の ID はパスに使えない値を通さない', async () => {
  const store = createStore(tmp('bh-edge-hist-'));
  for (const bad of ['../config', '..%2f..', '2026/../../x', '', null, undefined, '12345', '2026-01-01T00:00:00.000Z', '1'.repeat(41), { toString: () => '../../etc' }]) {
    assert.equal(await store.historyEntry(bad), null, String(bad));
  }
  assert.equal(historyId({ createdAt: '../../2026' }), '');
  assert.equal(historyId(null), '');
  assert.equal(historyId({ createdAt: '2026-01-01T00:00:00.000Z' }), '20260101T000000000Z');
});

test('edge store: 同時の保存でも壊れず、一時ファイルを残さない', async () => {
  const dir = tmp('bh-edge-conc-');
  const store = createStore(dir);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.saveState({ i, pad: 'x'.repeat(i * 100) })));
  const st = await store.state();
  assert.equal(typeof st.i, 'number');
  assert.equal(st.pad.length, st.i * 100);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);

  // 分析を同時に 20 回保存しても、履歴の一覧と実際のファイルが合う（最大 12 回分）
  const analyses = Array.from({ length: 20 }, (_, i) => ({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), stats: { points: i } }));
  await Promise.all(analyses.map((a) => store.saveAnalysis(a)));
  const index = await store.history();
  assert.equal(index.length, 12);
  const files = readdirSync(path.join(dir, 'history')).filter((f) => f !== 'index.json');
  assert.deepEqual(files.sort(), index.map((h) => `${h.id}.json`).sort());
  assert.equal(index[0].stats.points, 19);

  // lock の中の処理が失敗しても、次の処理は進む
  await assert.rejects(store.lock(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await store.lock(async () => 'next'), 'next');
});

// ---------------------------------------------------------------- cli/server.js

async function withServer(fn, configure = {}) {
  const dataDir = tmp('bh-edge-srv-');
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: 'http://127.0.0.1:9', chatModel: '', embedModel: '' }, allowedOrigins: ['https://example.github.io'], ...configure });
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response('{}') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, port, store, dataDir });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** fetch はパスの ../ を詰めてしまうので、生のパスで送る */
function rawRequest(port, rawPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('edge server: パストラバーサル・NUL 文字・壊れたエンコードは web/ の外を読ませない', async () => {
  await withServer(async ({ port }) => {
    const secret = readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const paths = [
      '/../package.json',
      '/../../etc/passwd',
      '/%2e%2e/package.json',
      '/%2E%2E/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2fpackage.json',
      '/js/..%2f..%2fpackage.json',
      '/..%5cpackage.json',
      '/%252e%252e/package.json',
      '/.%2e/cli/store.js',
      '/index.html%00.js',
      '/%00',
      '/..%00/package.json',
      '//etc/passwd',
      '/%2fetc%2fpasswd',
    ];
    for (const p of paths) {
      const r = await rawRequest(port, p);
      assert.ok([400, 403, 404].includes(r.status) || (r.status === 200 && !r.body.includes('"name": "bookshelf"')), `${p} → ${r.status}`);
      assert.ok(!r.body.includes(secret), p);
      assert.ok(!r.body.includes('root:x:0:0'), p);
    }
    // 壊れた %エンコードは 400
    assert.equal((await rawRequest(port, '/%E0%A4%A')).status, 400);
    assert.equal((await rawRequest(port, '/%')).status, 400);
    // 日本語のファイル名（無いもの）は 404、ある物は配信する
    assert.equal((await rawRequest(port, `/${encodeURIComponent('日本語.html')}`)).status, 404);
    const index = await rawRequest(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    // クエリにトラバーサルを書いても関係ない
    assert.equal((await rawRequest(port, '/index.html?../../package.json')).status, 200);
  });
});

test('edge server: 不明な API・違うメソッド・OPTIONS・Host / Origin の拒否', async () => {
  await withServer(async ({ port, base }) => {
    const unknown = await rawRequest(port, '/api/nope');
    assert.equal(unknown.status, 404);
    assert.match(JSON.parse(unknown.body).error, /不明な API: GET \/api\/nope/);
    for (const method of ['PATCH', 'DELETE', 'PUT']) assert.equal((await rawRequest(port, '/api/info', { method })).status, 404, method);
    assert.equal((await rawRequest(port, '/api/library', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await rawRequest(port, '/api/', {})).status, 404);
    assert.equal((await rawRequest(port, '/api/history/..%2f..%2fconfig')).status, 404);
    assert.equal((await rawRequest(port, '/api/history/20260101T000000Z')).status, 404);
    assert.equal((await rawRequest(port, '/api/info', { method: 'OPTIONS' })).status, 204);
    assert.equal((await rawRequest(port, '/api/info', { headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await rawRequest(port, '/api/info', { headers: { Host: 'localhost.evil.example' } })).status, 403);
    assert.equal((await rawRequest(port, '/api/info', { headers: { Origin: 'https://example.github.io.evil.com' } })).status, 403);
    assert.equal((await rawRequest(port, '/api/info', { headers: { Origin: 'http://localhost.evil.com' } })).status, 403);
    assert.equal((await rawRequest(port, '/api/info', { headers: { Origin: 'null' } })).status, 403);
    const ok = await rawRequest(port, '/api/info', { headers: { Origin: 'https://example.github.io' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], 'https://example.github.io');
    assert.equal((await fetch(`${base}/api/info`)).status, 200);
  });
});

test('edge server: 壊れた本文・JSON の null / 配列・形の違うファイルは 4xx（500 にしない）', async () => {
  await withServer(async ({ port, store }) => {
    const post = (p, body, method = 'POST') => rawRequest(port, p, { method, body, headers: { 'Content-Type': 'application/json' } });
    for (const body of ['{', 'not json', '{"a":', '\u0000', ' ']) {
      for (const p of ['/api/library/merge', '/api/import', '/api/kindle-status']) assert.equal((await post(p, body)).status, 400, `${p} ${JSON.stringify(body)}`);
      assert.equal((await post('/api/analysis', body, 'PUT')).status, 400);
    }
    for (const body of ['null', '[]', '1', '"x"', 'true']) {
      for (const p of ['/api/library/merge', '/api/import', '/api/kindle-status']) {
        const r = await post(p, body);
        assert.ok(r.status >= 400 && r.status < 500, `${p} ${body} → ${r.status} ${r.body}`);
      }
      assert.equal((await post('/api/analysis', body, 'PUT')).status, 400);
      const a = await post('/api/analyze', body);
      assert.ok(a.status < 500, `analyze ${body} → ${a.status} ${a.body}`);
    }
    // 空の本文は {} 扱い（ファイルなしの取り込み）
    assert.equal((await post('/api/import', '')).status, 200);
    // files の形が違う
    for (const files of [{}, 'x', [null], [{ name: 'a.txt' }], [{ name: 'a.txt', base64: 5 }]]) {
      const r = await post('/api/import', JSON.stringify({ files }));
      assert.ok(r.status < 500, `files=${JSON.stringify(files)} → ${r.status} ${r.body}`);
    }
    // ライブラリは壊れていない
    assert.ok((await store.library()).books);
  });
});

test('edge server: 日本語・記号のファイル名、壊れた base64 の取り込み', async () => {
  await withServer(async ({ port }) => {
    const files = [
      { name: '日本語 メモ😀.md', base64: Buffer.from('# 本\n\n> 線\n').toString('base64') },
      { name: '../../evil.txt', base64: '!!!not base64!!!' },
      { name: '', base64: '' },
    ];
    const r = await rawRequest(port, '/api/import', { method: 'POST', body: JSON.stringify({ files }) });
    assert.equal(r.status, 200, r.body);
    const out = JSON.parse(r.body);
    assert.equal(out.results.length, 3);
  });
});

test('edge server: 大きすぎる本文は 413', async () => {
  await withServer(async ({ port }) => {
    const status = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/library/merge', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      // サーバが途中で切ることがある（413 を返した後は送り続けられない）
      req.on('error', () => resolve('reset'));
      const block = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (sent < 51) {
          sent++;
          if (!req.write(block)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    assert.ok(status === 413 || status === 'reset', String(status));
  });
});

test('edge server: トークンを設定したら API は要求し、静的ファイルは要求しない', async () => {
  await withServer(
    async ({ port }) => {
      assert.equal((await rawRequest(port, '/api/info')).status, 401);
      assert.equal((await rawRequest(port, '/api/info', { headers: { 'X-BH-Token': '' } })).status, 401);
      assert.equal((await rawRequest(port, '/api/info?token=s3cret%00')).status, 401);
      assert.equal((await rawRequest(port, '/api/info?token=s3cret')).status, 200);
      assert.equal((await rawRequest(port, '/llm/api/tags', { headers: { 'X-BH-Token': 'wrong' } })).status, 401);
      assert.equal((await rawRequest(port, '/')).status, 200);
    },
    { token: 's3cret' },
  );
});

// ---------------------------------------------------------------- cli/google.js

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function fakeDrive({ docs = [], tokenResponse } = {}) {
  const calls = { token: 0, exports: 0 };
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      calls.token++;
      return tokenResponse ? tokenResponse() : json({ access_token: 'at-1', expires_in: 'abc' });
    }
    if (u.pathname === '/drive/v3/files') {
      if (u.searchParams.get('q').includes('vnd.google-apps.folder')) return json({ files: [{ id: 'folder-1' }] });
      return json({ files: docs });
    }
    calls.exports++;
    return new Response('<html><body>not play books</body></html>');
  };
  return { fetchImpl, calls };
}

async function googleSetup(opts) {
  const store = createStore(tmp('bh-edge-google-'));
  await store.saveConfig({ google: { clientId: 'cid', clientSecret: 's' } });
  await store.saveGoogleToken({ refreshToken: 'rt' });
  const drive = fakeDrive(opts);
  return { store, drive, client: createGoogleClient({ store, fetchImpl: drive.fetchImpl }) };
}

test('edge google: 取り込み記録に files が無くても（壊れた・古い google-sync.json）落ちない', async () => {
  const { store, client } = await googleSetup({ docs: [{ id: 'd1', name: 'メモ', modifiedTime: '2026-01-01T00:00:00Z' }] });
  writeFileSync(path.join(store.dataDir, 'google-sync.json'), '{}');
  const r = await client.sync();
  assert.equal(r.checked, 1);
  assert.equal(r.changed, 1);
  assert.equal((await store.googleSync()).files.d1, '2026-01-01T00:00:00Z');
});

test('edge google: トークンの応答が JSON でない・Drive の一覧が空・folder ID の形', async () => {
  const { client } = await googleSetup({ tokenResponse: () => new Response('<html>oops</html>', { status: 500 }) });
  await assert.rejects(client.sync(), /HTTP 500/);
  const empty = await googleSetup({ docs: [] });
  assert.deepEqual(await empty.client.sync(), { checked: 0, changed: 0, added: 0, updated: 0, booksAdded: 0, errors: [], problems: [] });
  // 読めないドキュメントはエラーとして返し、落ちない
  const bad = await googleSetup({ docs: [{ id: 'd1', name: '../x', modifiedTime: 't' }] });
  const r = await bad.client.sync();
  assert.equal(r.changed, 1);
  assert.equal(r.errors.length, 1);
  for (const s of ['', null, undefined, 'short', "abcdefghij'or'1", 'abc def ghij k', '../../../../x']) assert.equal(isFolderId(s), false, String(s));
  assert.equal(isFolderId('1AbC-dEf_ghIJ'), true);
});

test('edge google: 設定を読んでいる最中に stop しても、次の確認を予約しない', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let syncs = 0;
    let releaseConfig;
    const configGate = new Promise((r) => (releaseConfig = r));
    const store = { config: async () => (await configGate, { google: { intervalSec: 15 } }) };
    const client = { sync: async () => (syncs++, { checked: 0, changed: 0, added: 0, updated: 0, errors: [] }) };
    const w = startDriveWatcher({ store, client, log: () => {} });
    // sync が終わり、finally で設定を待っている
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(syncs, 1);
    w.stop();
    releaseConfig();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    mock.timers.tick(60_000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(syncs, 1, 'stop した後は確認しない');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------- cli/bh.js

const bh = (args, env = {}) => run(process.execPath, [BH, ...args], { env: { ...process.env, ...env } });

test('edge bh: 設定の値の確かめ（ポート・不明なキー・空の値）', async () => {
  const data = tmp('bh-edge-cli-');
  const env = { BH_DATA: data };
  for (const bad of [['port', 'abc'], ['port', '70000'], ['port', '-1'], ['port', '80.5'], ['port']]) {
    await assert.rejects(bh(['config', ...bad], env), /エラー/, bad.join(' '));
  }
  assert.equal(existsSync(path.join(data, 'config.json')), false, '失敗したら保存しない');
  await bh(['config', 'port', '9000'], env);
  assert.equal(JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8')).port, 9000);
  await assert.rejects(bh(['config', 'nope', 'x'], env), /不明な設定: nope/);
  await assert.rejects(bh(['config', 'google-interval', '5'], env), /15 秒以上/);
  await assert.rejects(bh(['config', 'google-interval', 'NaN'], env), /15 秒以上/);
  await assert.rejects(bh(['config', 'auto-points', '1.5'], env), /整数/);
  await assert.rejects(bh(['config', 'auto-hours', '0'], env), /0 より大きい/);
  await assert.rejects(bh(['config', 'auto', 'maybe'], env), /on \| off/);
  await assert.rejects(bh(['config', 'google-folder', "x' or '1"], env), /フォルダ ID/);
  await assert.rejects(bh(['google', 'bogus'], env), /使い方: bh google/);
});

test('edge bh: --data=値 に = を含むパス・無いファイル・空のフォルダ・空の検索', async () => {
  const base = tmp('bh-edge-cli2-');
  const data = path.join(base, 'a=b');
  await bh(['config', 'model', 'm1', `--data=${data}`]);
  assert.equal(JSON.parse(readFileSync(path.join(data, 'config.json'), 'utf8')).llm.chatModel, 'm1');
  assert.equal(existsSync(path.join(base, 'a')), false);

  const env = { BH_DATA: path.join(base, 'd') };
  await assert.rejects(bh(['import'], env), /取り込むファイルかフォルダを指定/);
  await assert.rejects(bh(['import', path.join(base, 'missing.txt')], env), /エラー/);
  const emptyDir = path.join(base, 'empty');
  mkdirSync(path.join(emptyDir, '.hidden'), { recursive: true });
  writeFileSync(path.join(emptyDir, '.hidden', 'x.md'), '# x');
  writeFileSync(path.join(emptyDir, 'image.jpg'), 'x');
  await assert.rejects(bh(['import', emptyDir], env), /取り込めるファイルがありませんでした/);
  const { stdout } = await bh(['search', '<script>'], env);
  assert.match(stdout, /0 件/);
  const list = await bh(['list'], env);
  assert.match(list.stdout, /本 0 冊/);
  const help = await bh([], env);
  assert.match(help.stdout, /使い方: bh/);
});

// web/core の小さなユーティリティの境界値テスト（空・null・Unicode・壊れた入力・冪等性・入力を変えないこと）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, cleanText, bookKey, hash, randomId, isoDate, decodeEntities, htmlToText, parseLooseDate, seededRandom, truncate } from '../web/core/text.js';
import { crc32, isZip, readZip, createZip } from '../web/core/zip.js';
import { analysisPoints, pointById, analysisPointById, isThought, pointLabel, embedText, legacyEmbedText, searchPoints } from '../web/core/points.js';
import { newerItem, mergeCollections } from '../web/core/collections.js';
import { isUploadedCover, bookCoverUrl, COVER_MAX_LENGTH } from '../web/core/covers.js';
import { analysisStamp, makeBackup, applyImport, BACKUP_FORMAT } from '../web/core/importing.js';
import { followJob, pcJobOutcome } from '../web/core/jobs.js';
import { normalizeKindleReport, mergeKindleSync, kindleSyncState } from '../web/core/kindle-status.js';
import { emptyLibrary } from '../web/core/model.js';
import { makeDeflateZip } from './helpers/docx.js';

// ---- text.js ----

test('normalizeText: null・undefined・空白だけは空文字、全角英数・全角空白は半角に、ゼロ幅文字と BOM は消える', () => {
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(' \t\r\n　 '), '');
  assert.equal(normalizeText('ＡＢＣ　１２３'), 'abc 123');
  assert.equal(normalizeText('\uFEFFa\u200Bb\u200Dc'), 'abc');
  assert.equal(normalizeText(0), '0');
  // 結合文字（が = か + ゛）は合成済みの文字と同じになる
  assert.equal(normalizeText('か\u3099'), normalizeText('が'));
});

test('normalizeText / bookKey: 冪等（2 回かけても同じ）', () => {
  for (const s of ['  Ｈｅｌｌｏ　World!! ', 'ｶﾞｷﾞ\r\n本', '😀 絵文字 😀']) {
    assert.equal(normalizeText(normalizeText(s)), normalizeText(s));
    assert.equal(bookKey(bookKey(s)), bookKey(s));
  }
});

test('bookKey: 記号・空白の違いを無視、絵文字（記号）も落ちる、null は空', () => {
  assert.equal(bookKey('ＦＡＣＴＦＵＬＮＥＳＳ（ファクトフルネス）'), bookKey('Factfulness ファクトフルネス'));
  assert.equal(bookKey('『嫌われる勇気』'), bookKey('嫌われる勇気'));
  assert.equal(bookKey(null), '');
  assert.equal(bookKey('!!!'), '');
  assert.equal(bookKey('本😀'), '本');
});

test('cleanText: CRLF・CR は LF に、行末の空白を落とし、3 行以上の空行を 1 行に、BOM を消す', () => {
  assert.equal(cleanText('\uFEFF a \r\nb\rc '), 'a\nb\nc');
  assert.equal(cleanText('a  \n\n\n\nb'), 'a\n\nb');
  assert.equal(cleanText('a\n \n \n \nb'), 'a\n\nb');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText(undefined), '');
  const s = 'x\r\n\r\n\r\n\r\ny  ';
  assert.equal(cleanText(cleanText(s)), cleanText(s));
});

test('hash: 決まった値・空文字でも動く・seed で変わる・サロゲートペアも扱える', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
  assert.notEqual(hash('abc', 1), hash('abc'));
  assert.match(hash(''), /^[0-9a-z]+$/);
  assert.notEqual(hash('😀'), hash('😁'));
  assert.match(hash('x'.repeat(100000)), /^[0-9a-z]+$/);
});

test('randomId: 接頭辞 + 英数字で、続けて作っても重ならない', () => {
  const ids = new Set(Array.from({ length: 200 }, () => randomId('t')));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^t[0-9a-z]+$/);
});

test('isoDate: 空・null・不正は空文字、Date や時刻つき文字列は YYYY-MM-DD', () => {
  assert.equal(isoDate(''), '');
  assert.equal(isoDate(null), '');
  assert.equal(isoDate(undefined), '');
  assert.equal(isoDate('not a date'), '');
  assert.equal(isoDate(NaN), '');
  assert.equal(isoDate(new Date(2024, 1, 29, 12)), '2024-02-29');
  assert.match(isoDate('2023-01-02T12:00:00'), /^2023-01-02$/);
});

test('decodeEntities: 名前付き・10 進・16 進（大文字小文字）・Latin-1・知らない名前はそのまま', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(decodeEntities('&#65;&#x42;&#X43;&#x1F600;'), 'ABC😀');
  assert.equal(decodeEntities('&AMP; &eacute; &Eacute; &yuml;'), '& é É ÿ');
  assert.equal(decodeEntities('&unknownentity; & &;'), '&unknownentity; & &;');
  assert.equal(decodeEntities(null), '');
  // 二重にエスケープされたものは 1 段だけ戻す
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('decodeEntities: Unicode の範囲外の数値参照で落ちない（そのまま残す）', () => {
  assert.equal(decodeEntities('a&#99999999;b'), 'a&#99999999;b');
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;');
  assert.equal(decodeEntities('&#x' + 'f'.repeat(20) + ';'), '&#x' + 'f'.repeat(20) + ';');
  assert.equal(htmlToText('<p>x&#9999999999;</p>'), 'x&#9999999999;');
});

test('decodeEntities: Object の継承した名前（constructor・toString・__proto__ など）を文字参照と取り違えない', () => {
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    assert.equal(decodeEntities(`&${name};`), `&${name};`, name);
  }
  assert.equal(htmlToText('a &constructor; b'), 'a &constructor; b');
});

test('htmlToText: script・style を落とし、br・ブロック終わりを改行に、属性に > を含む壊れたタグでも落ちない', () => {
  assert.equal(htmlToText('<style>p{}</style><script>alert(1)</script><p>一</p><div>二<br/>三</div>'), '一\n二\n三');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText('<b>太字</b>&nbsp;&amp;'), '太字 &');
  assert.equal(htmlToText('閉じていない <b'), '閉じていない <b');
});

test('parseLooseDate: 空・null・不正は null', () => {
  assert.equal(parseLooseDate(''), null);
  assert.equal(parseLooseDate(null), null);
  assert.equal(parseLooseDate(undefined), null);
  assert.equal(parseLooseDate('きのう'), null);
});

test('parseLooseDate: 日本語の午前・午後 12 時、全角数字、時刻なし', () => {
  const local = (iso) => {
    const d = new Date(iso);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  };
  assert.deepEqual(local(parseLooseDate('2023年1月2日 午後3:04:05')), [2023, 1, 2, 15, 4, 5]);
  assert.deepEqual(local(parseLooseDate('2023年1月2日 午後12:30')), [2023, 1, 2, 12, 30, 0]);
  assert.deepEqual(local(parseLooseDate('2023年1月2日 午前12:30')), [2023, 1, 2, 0, 30, 0]);
  assert.deepEqual(local(parseLooseDate('２０２３年１月２日')), [2023, 1, 2, 0, 0, 0]);
  assert.deepEqual(local(parseLooseDate('2023/1/2 3:04')), [2023, 1, 2, 3, 4, 0]);
  assert.deepEqual(local(parseLooseDate('2024-02-29')), [2024, 2, 29, 0, 0, 0]);
});

test('parseLooseDate: 存在しない日付（13 月・2 月 30 日など）を別の日に繰り上げず null にする', () => {
  assert.equal(parseLooseDate('2023年13月1日'), null);
  assert.equal(parseLooseDate('2023年2月30日'), null);
  assert.equal(parseLooseDate('2023-02-29'), null);
  assert.equal(parseLooseDate('2023/00/10'), null);
  assert.equal(parseLooseDate('2023-01-32 10:00'), null);
});

test('seededRandom: 同じシードは同じ列、値は [0, 1)、シード 0 や負数でも動く', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.ok(seededRandom(0)() >= 0);
  assert.ok(seededRandom(-1)() < 1);
  assert.notEqual(seededRandom(1)(), seededRandom(2)());
});

test('truncate: 短い文字列はそのまま、絵文字（サロゲートペア）を半分に切らない、null は空', () => {
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'ab…');
  assert.equal(truncate(null, 3), '');
  assert.equal(truncate('😀😀😀', 3), '😀😀😀', 'length は 6 だが 3 文字');
  assert.equal(truncate('😀😀😀😀', 3), '😀😀…');
  assert.equal(truncate('abcd', 1), '…');
  const long = 'あ'.repeat(10000);
  assert.equal(Array.from(truncate(long, 100)).length, 100);
});

test('truncate: 0 以下の長さでも元の文字列の末尾を残さない', () => {
  assert.equal(truncate('abcd', 0), '');
  assert.equal(truncate('abcd', -1), '');
});

// ---- zip.js ----

test('crc32: 既知の値（空・"123456789"）', () => {
  assert.equal(crc32(new Uint8Array()), 0);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('isZip: 短いもの・別の形式は false', () => {
  assert.equal(isZip(new Uint8Array()), false);
  assert.equal(isZip(new Uint8Array([0x50, 0x4b, 3, 4])), false);
  assert.equal(isZip(new TextEncoder().encode('hello world')), false);
  assert.equal(isZip(createZip([{ name: 'a.txt', content: 'x' }])), true);
});

test('createZip → readZip: 日本語・絵文字のファイル名、空ファイル、バイナリ、ディレクトリは除く', async () => {
  const bin = new Uint8Array(256).map((_, i) => i);
  const zip = createZip([
    { name: 'メモ/読書😀.txt', content: '本文\r\n二行目' },
    { name: 'empty.txt', content: '' },
    { name: 'bin.dat', content: bin },
    { name: 'dir/', content: '' },
  ]);
  const out = await readZip(zip);
  assert.deepEqual(out.map((e) => e.name), ['メモ/読書😀.txt', 'empty.txt', 'bin.dat']);
  assert.equal(new TextDecoder().decode(out[0].bytes), '本文\r\n二行目');
  assert.equal(out[1].bytes.length, 0);
  assert.deepEqual([...out[2].bytes], [...bin]);
  // ArrayBuffer でも読める
  assert.equal((await readZip(zip.buffer)).length, 3);
});

test('readZip: 中身が空の zip は空の配列', async () => {
  assert.deepEqual(await readZip(createZip([])), []);
});

test('readZip: deflate の zip を読める', async () => {
  const out = await readZip(makeDeflateZip([{ name: 'a.txt', content: 'あいう'.repeat(1000) }]));
  assert.equal(new TextDecoder().decode(out[0].bytes), 'あいう'.repeat(1000));
});

test('readZip: zip でないもの・空・短すぎるものは分かる言葉の Error', async () => {
  await assert.rejects(readZip(new Uint8Array()), /zip ファイルとして読めませんでした/);
  await assert.rejects(readZip(new Uint8Array(10)), /zip ファイルとして読めませんでした/);
  await assert.rejects(readZip(new TextEncoder().encode('x'.repeat(1000))), /zip ファイルとして読めませんでした/);
});

test('readZip: 途中で切れた zip・中央ディレクトリの位置が範囲外の zip は RangeError ではなく分かる言葉の Error', async () => {
  const zip = createZip([{ name: 'a.txt', content: 'hello' }, { name: 'b.txt', content: 'world' }]);
  // 中央ディレクトリの位置を範囲外にする
  const bad = zip.slice();
  new DataView(bad.buffer).setUint32(bad.length - 22 + 16, 0xfffffff0, true);
  await assert.rejects(readZip(bad), (e) => !(e instanceof RangeError) && /zip/.test(e.message));
  // 件数だけ多く書かれている
  const more = zip.slice();
  new DataView(more.buffer).setUint16(more.length - 22 + 10, 50, true);
  await assert.rejects(readZip(more), (e) => !(e instanceof RangeError) && /zip/.test(e.message));
  // ローカルヘッダの位置が範囲外
  const cdStart = new DataView(zip.buffer).getUint32(zip.length - 22 + 16, true);
  const local = zip.slice();
  new DataView(local.buffer).setUint32(cdStart + 42, 0xfffffff0, true);
  await assert.rejects(readZip(local), (e) => !(e instanceof RangeError) && /zip/.test(e.message));
});

test('readZip: 壊れた deflate データは reject する（固まらない）', async () => {
  const zip = makeDeflateZip([{ name: 'a.txt', content: 'abcdefghij'.repeat(50) }]);
  const bad = zip.slice();
  // ローカルヘッダの直後（データ）を壊す
  for (let i = 30 + 5; i < 30 + 5 + 8; i++) bad[i] = 0xff;
  await assert.rejects(readZip(bad));
});

test('readZip: 入力の配列を変えない', async () => {
  const zip = createZip([{ name: 'a.txt', content: 'hello' }]);
  const copy = zip.slice();
  const out = await readZip(zip);
  out[0].bytes[0] = 0;
  assert.deepEqual(zip, copy);
});

// ---- points.js ----

const lib = () => {
  const l = emptyLibrary();
  l.books.b1 = { id: 'b1', title: '本1' };
  l.highlights.h2 = { id: 'h2', bookId: 'b1', text: '線2', createdAt: '2024-01-02T00:00:00Z', source: 'kindle' };
  l.highlights.h1 = { id: 'h1', bookId: 'b1', text: '線1', note: 'メモ', createdAt: '2024-01-01T00:00:00Z', source: 'kindle', favorite: true };
  l.highlights.h3 = { id: 'h3', bookId: 'b1', text: '消した', deleted: true, createdAt: '2024-01-03T00:00:00Z' };
  l.thoughts.t1 = { id: 't1', text: '思いつき1', status: 'inbox', createdAt: '2024-01-05T00:00:00Z', updatedAt: '2024-01-05T00:00:00Z' };
  l.thoughts.t2 = { id: 't2', text: '捨てた', status: 'discarded', createdAt: '2024-01-04T00:00:00Z', updatedAt: '2024-01-04T00:00:00Z' };
  return l;
};

test('pointById: 無い ID・消したもの・継承した名前（toString・__proto__）は null、捨てた思いつきは返す', () => {
  const l = lib();
  assert.equal(pointById(l, 'h1').text, '線1');
  assert.equal(pointById(l, 'h3'), null);
  assert.equal(pointById(l, 'hX'), null);
  assert.equal(pointById(l, 'toString'), null);
  assert.equal(pointById(l, '__proto__'), null);
  assert.equal(pointById(l, undefined), null);
  assert.equal(pointById({}, 'h1'), null);
  assert.equal(pointById({}, 't1'), null);
  assert.equal(pointById(l, 't2').text, '捨てた');
  assert.equal(analysisPointById(l, 't2'), null);
  assert.equal(analysisPointById(l, 't1').text, '思いつき1');
});

test('analysisPoints: 消した線・捨てた思いつきを除いて ID 順、ライブラリを変えない', () => {
  const l = lib();
  const before = structuredClone(l);
  assert.deepEqual(analysisPoints(l).map((p) => p.id), ['h1', 'h2', 't1']);
  assert.deepEqual(l, before);
  assert.deepEqual(analysisPoints(emptyLibrary()), []);
});

test('isThought / pointLabel / embedText / legacyEmbedText: 欠けた値でも落ちない', () => {
  assert.equal(isThought(null), false);
  assert.equal(isThought(undefined), false);
  assert.equal(isThought({ id: 't1' }), true);
  assert.equal(isThought({ id: 'h1' }), false);
  const l = lib();
  assert.equal(pointLabel(l, { id: 't1' }), '思いつき');
  assert.equal(pointLabel(l, { id: 'h1', bookId: 'b1' }), '本1');
  assert.equal(pointLabel(l, { id: 'h9', bookId: 'nope' }), '');
  assert.equal(pointLabel({}, { id: 'h9', bookId: 'b1' }), '');
  assert.equal(embedText({ id: 'h1', text: '線' }), '線');
  assert.equal(embedText({ id: 'h1', text: '線', note: '', userNote: 'u', tags: ['a', 'b'] }), '線\nu\n#a #b');
  assert.equal(embedText({ id: 'h1', text: '線', tags: [] }), '線');
  assert.equal(embedText({ id: 't1', text: '思い', tags: ['x'] }), '思い');
  assert.equal(legacyEmbedText({ text: '線' }), '線');
  assert.equal(legacyEmbedText({ text: '線', note: 'メモ' }), '線\nメモ');
});

test('searchPoints: 新しい順、source・favorite・thought の絞り込み、空のライブラリ', () => {
  const l = lib();
  assert.deepEqual(searchPoints(l).map((p) => p.id), ['t1', 'h2', 'h1']);
  assert.deepEqual(searchPoints(l, '', { source: 'thought' }).map((p) => p.id), ['t1']);
  assert.deepEqual(searchPoints(l, '', { source: 'kindle' }).map((p) => p.id), ['h2', 'h1']);
  assert.deepEqual(searchPoints(l, '', { favorite: true }).map((p) => p.id), ['h1']);
  assert.deepEqual(searchPoints(l, '　ＭＥＭＯ　'.toLowerCase()).map((p) => p.id), []);
  assert.deepEqual(searchPoints(l, 'メモ').map((p) => p.id), ['h1']);
  assert.deepEqual(searchPoints(l, '   ').map((p) => p.id), ['t1', 'h2', 'h1']);
  assert.deepEqual(searchPoints(emptyLibrary(), 'x'), []);
});

// ---- collections.js ----

test('newerItem: updatedAt が新しい方、片方が無ければある方、同じなら向きに依らない', () => {
  const a = { id: 'x', updatedAt: '2024-01-02', text: 'a' };
  const b = { id: 'x', updatedAt: '2024-01-01', text: 'b' };
  assert.equal(newerItem(a, b), a);
  assert.equal(newerItem(b, a), a);
  const c = { id: 'x', text: 'c' };
  assert.equal(newerItem(b, c), b);
  assert.equal(newerItem(c, b), b);
  const d = { id: 'x', updatedAt: '2024-01-01', text: 'd' };
  assert.equal(newerItem(b, d), newerItem(d, b));
});

test('mergeCollections: null・undefined・配列・壊れた項目を捨て、向きに依らず同じ結果、引数を変えない', () => {
  const base = { a: { updatedAt: '1', v: 1 }, b: { updatedAt: '2', v: 2 }, bad: null, arr: [1], str: 'x' };
  const inc = { a: { updatedAt: '3', v: 3 }, b: { updatedAt: '2', v: 9 }, c: { updatedAt: '1', v: 4 } };
  const b0 = structuredClone(base);
  const i0 = structuredClone(inc);
  const ab = mergeCollections(base, inc);
  const ba = mergeCollections(inc, base);
  assert.deepEqual(ab, ba);
  assert.deepEqual(Object.keys(ab).sort(), ['a', 'b', 'c']);
  assert.equal(ab.a.v, 3);
  assert.equal(ab.a.id, 'a');
  assert.deepEqual(base, b0);
  assert.deepEqual(inc, i0);
  ab.c.v = 100;
  assert.equal(inc.c.v, 4, '結果を変えても引数は変わらない');
  assert.deepEqual(mergeCollections(null, undefined), {});
  assert.deepEqual(mergeCollections({}, {}), {});
});

test('mergeCollections: 冪等（同じものを重ねても変わらない）', () => {
  const x = { a: { updatedAt: '1', v: 1 }, b: { updatedAt: '2', v: 2, deleted: true } };
  const once = mergeCollections(x, x, { stickyDelete: true });
  assert.deepEqual(mergeCollections(once, x, { stickyDelete: true }), once);
  assert.deepEqual(mergeCollections(once, once), once);
});

test('mergeCollections: stickyDelete は古い削除でも消えたまま、向きに依らない', () => {
  const del = { x: { updatedAt: '1', deleted: true } };
  const live = { x: { updatedAt: '9', text: '新しい' } };
  assert.equal(mergeCollections(del, live, { stickyDelete: true }).x.deleted, true);
  assert.equal(mergeCollections(live, del, { stickyDelete: true }).x.deleted, true);
  assert.equal(mergeCollections(del, live).x.deleted, undefined);
});

test('mergeCollections: __proto__・constructor・toString の鍵で入れ物を壊さない', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "toString": {"updatedAt": "1"}, "constructor": {"updatedAt": "1"}}');
  const out = mergeCollections({}, evil);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(out.toString.id, 'toString');
  assert.equal(out.constructor.id, 'constructor');
  const both = mergeCollections(evil, evil);
  assert.equal(both.toString.id, 'toString');
});

test('mergeCollections: normalize が null を返した項目は捨て、両方にある項目にも mergeItem を使う', () => {
  const out = mergeCollections({ a: { ok: false }, b: { ok: true, n: 1 } }, { b: { ok: true, n: 2 } }, {
    normalize: (x) => (x.ok ? x : null),
    mergeItem: (p, q) => ({ ...p, n: p.n + q.n }),
  });
  assert.deepEqual(out, { b: { ok: true, n: 3, id: 'b' } });
});

// ---- covers.js ----

test('isUploadedCover: ラスタ画像の base64 だけ、SVG・HTML・改行入り・長すぎるものは通さない', () => {
  assert.equal(isUploadedCover('data:image/png;base64,iVBORw0KGgo='), true);
  assert.equal(isUploadedCover('data:image/jpeg;base64,/9j/4AAQ'), true);
  assert.equal(isUploadedCover('data:image/svg+xml;base64,PHN2Zz4='), false);
  assert.equal(isUploadedCover('data:text/html;base64,PGI+'), false);
  assert.equal(isUploadedCover('data:image/png;base64,'), false);
  assert.equal(isUploadedCover('data:image/png;base64,AAAA\n'), false);
  assert.equal(isUploadedCover('data:image/png;base64,AA"onerror=x'), false);
  assert.equal(isUploadedCover(null), false);
  assert.equal(isUploadedCover(123), false);
  const head = 'data:image/png;base64,';
  assert.equal(isUploadedCover(head + 'A'.repeat(COVER_MAX_LENGTH - head.length)), true);
  assert.equal(isUploadedCover(head + 'A'.repeat(COVER_MAX_LENGTH - head.length + 1)), false);
});

test('bookCoverUrl: アップロードした表紙を優先、壊れた表紙なら ASIN に戻る、小文字・空白入り ASIN は使わない', () => {
  const cover = 'data:image/webp;base64,UklGR==';
  assert.equal(bookCoverUrl({ cover, asin: 'B0D8N5G9GT' }), cover);
  assert.match(bookCoverUrl({ cover: 'javascript:alert(1)', asin: 'B0D8N5G9GT' }), /amazon/);
  assert.equal(bookCoverUrl({ asin: ' B0D8N5G9GT' }), '');
  assert.equal(bookCoverUrl({ asin: 'B0D8N5G9G' }), '');
  assert.equal(bookCoverUrl({ volumeId: 'ab' }), '');
  assert.equal(bookCoverUrl({ volumeId: 'a'.repeat(25) }), '');
  assert.equal(bookCoverUrl({ volumeId: 'ab\ncd' }), '');
  assert.equal(bookCoverUrl(undefined), '');
  assert.equal(bookCoverUrl({}), '');
});

// ---- importing.js ----

test('analysisStamp: null・欠けた時刻・おすすめのほうが新しい', () => {
  assert.equal(analysisStamp(null), '');
  assert.equal(analysisStamp(undefined), '');
  assert.equal(analysisStamp({}), '');
  assert.equal(analysisStamp({ createdAt: '2024-01-01T00:00:00Z' }), '2024-01-01T00:00:00Z');
  assert.equal(analysisStamp({ createdAt: '2024-01-01T00:00:00Z', recommendedAt: '2024-02-01T00:00:00Z' }), '2024-02-01T00:00:00Z');
  assert.equal(analysisStamp({ recommendedAt: '2024-02-01T00:00:00Z' }), '2024-02-01T00:00:00Z');
});

test('makeBackup: 分析が無ければ null', () => {
  const b = makeBackup(emptyLibrary());
  assert.equal(b.format, BACKUP_FORMAT);
  assert.equal(b.analysis, null);
  assert.equal(makeBackup(emptyLibrary(), undefined).analysis, null);
});

test('applyImport: 何も取り込まなくても引数のライブラリを変えず、分析も変わらない', () => {
  const l = lib();
  const before = structuredClone(l);
  const r = applyImport({ library: l }, {});
  assert.deepEqual(l, before);
  assert.notEqual(r.library, l);
  assert.equal(r.analysis, null);
  assert.equal(r.analysisChanged, false);
  assert.equal(r.stats.backups, 0);
  assert.equal(r.stats.highlights, 2);
});

test('applyImport: 壊れた分析・古い分析のバックアップは採用しない、新しい分析は採用する', () => {
  const now = new Date().toISOString();
  const good = { createdAt: now, lines: [], planes: [], solid: {} };
  const old = { createdAt: '2020-01-01T00:00:00.000Z', lines: [], planes: [], solid: {} };
  const broken = { createdAt: '2099-01-01T00:00:00.000Z', lines: 'x', planes: [], solid: {} };
  const r1 = applyImport({ library: emptyLibrary(), analysis: good }, { backups: [{ library: emptyLibrary(), analysis: old }, { library: emptyLibrary(), analysis: broken }] });
  assert.equal(r1.analysis, good);
  assert.equal(r1.analysisChanged, false);
  const r2 = applyImport({ library: emptyLibrary(), analysis: old }, { backups: [{ library: emptyLibrary(), analysis: good }] });
  assert.equal(r2.analysis, good);
  assert.equal(r2.analysisChanged, true);
});

test('applyImport: 同じ本を 2 回取り込んでも増えない（冪等）、書名が空の本は飛ばす', () => {
  const books = [{ title: '本A', source: 'kindle', highlights: [{ text: '線' }] }, { title: '   ', source: 'kindle', highlights: [{ text: 'x' }] }];
  const r1 = applyImport({ library: emptyLibrary() }, { books }, { now: '2024-01-01T00:00:00.000Z' });
  const r2 = applyImport({ library: r1.library }, { books }, { now: '2024-01-02T00:00:00.000Z' });
  assert.equal(r1.stats.highlights, 1);
  assert.equal(r2.stats.highlights, 1);
  assert.equal(r2.stats.added, 0);
});

// ---- jobs.js ----

test('followJob: 終わっているジョブはすぐ返す、signal が中止済みなら fetchJob を呼ばない', async () => {
  let calls = 0;
  const job = await followJob({ fetchJob: async () => (calls++, { running: false, stage: 'done' }), sleep: async () => {} });
  assert.equal(job.stage, 'done');
  assert.equal(calls, 1);
  const ac = new AbortController();
  ac.abort();
  let called = false;
  assert.deepEqual(await followJob({ fetchJob: async () => (called = true), signal: ac.signal, sleep: async () => {} }), { stopped: true });
  assert.equal(called, false);
});

test('followJob: 失敗が続くと間隔を広げ（上限 30 秒）、maxFailures 回で lost、成功で数え直す', async () => {
  const waits = [];
  const seq = [new Error('a'), new Error('b'), { running: true }, new Error('c'), { running: false, stage: 'done' }];
  const updates = [];
  const job = await followJob({
    fetchJob: async () => {
      const x = seq.shift();
      if (x instanceof Error) throw x;
      return x;
    },
    onUpdate: (u) => updates.push(u),
    sleep: async (ms) => waits.push(ms),
    interval: 1000,
  });
  assert.equal(job.stage, 'done');
  assert.deepEqual(waits, [2000, 4000, 1000, 2000]);
  assert.deepEqual(updates.filter((u) => u.reconnecting).map((u) => u.reconnecting), [1, 2, 1]);
  const longWaits = [];
  const lost = await followJob({ fetchJob: async () => { throw new Error('down'); }, sleep: async (ms) => longWaits.push(ms), interval: 10000, maxFailures: 4 });
  assert.deepEqual(lost, { lost: true, error: 'down' });
  assert.deepEqual(longWaits, [20000, 30000, 30000]);
});

test('followJob: Error でない値（文字列・undefined）で失敗しても落ちずに再接続する', async () => {
  const seq = ['文字列で失敗', undefined, null];
  const updates = [];
  const r = await followJob({
    fetchJob: async () => {
      throw seq.shift();
    },
    onUpdate: (u) => updates.push(u),
    sleep: async () => {},
    maxFailures: 3,
  });
  assert.equal(r.lost, true);
  assert.equal(typeof r.error, 'string');
  assert.equal(updates[0].error, '文字列で失敗');
  assert.equal(updates.length, 2);
});

test('pcJobOutcome: error が空文字なら error 扱いにしない、stage が無いものは中断', () => {
  assert.equal(pcJobOutcome({ stage: 'done', error: '' }), 'done');
  assert.equal(pcJobOutcome({}), 'interrupted');
  assert.equal(pcJobOutcome({ stage: 'error' }), 'error');
  assert.equal(pcJobOutcome({ stage: 'done', startedAt: 'A' }, ''), 'done', '始めた時刻が空なら比べない');
});

// ---- kindle-status.js ----

test('normalizeKindleReport: 形の不正（null・配列・文字列・ok なし）は Error', () => {
  for (const b of [null, undefined, [], 'ok', 1, {}, { ok: 'true' }, { ok: 1 }]) assert.throws(() => normalizeKindleReport(b), Error, JSON.stringify(b));
});

test('normalizeKindleReport: 既定値・境界値・文字列の間隔・知らないキーを捨てる', () => {
  assert.deepEqual(normalizeKindleReport({ ok: true, extra: 'x' }), { ok: true, needLogin: false, added: 0, intervalMin: 15, error: '' });
  assert.equal(normalizeKindleReport({ ok: true, added: 100000 }).added, 100000);
  assert.equal(normalizeKindleReport({ ok: true, intervalMin: 1 }).intervalMin, 1);
  assert.equal(normalizeKindleReport({ ok: true, intervalMin: 1440 }).intervalMin, 1440);
  assert.equal(normalizeKindleReport({ ok: true, intervalMin: ' 30 ' }).intervalMin, 30);
  assert.equal(normalizeKindleReport({ ok: true, needLogin: null }).needLogin, false);
  for (const bad of [{ added: -1 }, { added: 1.5 }, { added: NaN }, { added: Infinity }, { added: '3' }, { added: 100001 }, { intervalMin: 0 }, { intervalMin: 1441 }, { intervalMin: '' }, { intervalMin: '   ' }, { intervalMin: 'abc' }, { intervalMin: 1.5 }, { intervalMin: NaN }, { needLogin: 'yes' }, { error: 42 }]) {
    assert.throws(() => normalizeKindleReport({ ok: true, ...bad }), Error, JSON.stringify(bad));
  }
});

test('normalizeKindleReport: error の制御文字を除き 300 文字で切る。絵文字を半分に切らない', () => {
  assert.equal(normalizeKindleReport({ ok: false, error: 'a\u0000b\nc\u007f\td' }).error, 'abcd');
  assert.equal(normalizeKindleReport({ ok: false, error: 'x'.repeat(1000) }).error.length, 300);
  const e = normalizeKindleReport({ ok: false, error: 'x' + '😀'.repeat(300) }).error;
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e), '孤立したサロゲートが無い');
  assert.ok(Array.from(e).length <= 300);
});

test('mergeKindleSync: 前回が無くても動き、失敗・0 件では前回の成功・新着を残す。前回を変えない', () => {
  const r = (o) => ({ ok: true, error: '', needLogin: false, added: 0, intervalMin: 15, ...o });
  const first = mergeKindleSync(undefined, r({ ok: false, error: 'x' }), 'T1');
  assert.deepEqual(first, { lastCheck: { at: 'T1', ok: false, error: 'x', needLogin: false, added: 0, intervalMin: 15 } });
  const second = mergeKindleSync(first, r({ added: 3 }), 'T2');
  assert.equal(second.lastSuccessAt, 'T2');
  assert.deepEqual(second.lastNew, { at: 'T2', added: 3 });
  const snapshot = structuredClone(second);
  const third = mergeKindleSync(second, r({ ok: false }), 'T3');
  assert.equal(third.lastSuccessAt, 'T2');
  assert.deepEqual(third.lastNew, { at: 'T2', added: 3 });
  assert.deepEqual(second, snapshot);
});

test('kindleSyncState: 境界（ちょうど 3 回分の間隔は stale でない）、未来の時刻、間隔なしは 15 分', () => {
  const at = '2024-01-01T00:00:00.000Z';
  const plus = (min) => new Date(Date.parse(at) + min * 60000).toISOString();
  const ks = (o) => ({ lastCheck: { at, ok: true, needLogin: false, intervalMin: 10, ...o } });
  assert.equal(kindleSyncState(null, at), 'none');
  assert.equal(kindleSyncState({}, at), 'none');
  assert.equal(kindleSyncState(ks(), plus(30)), 'ok');
  assert.equal(kindleSyncState(ks(), plus(30.001)), 'stale');
  assert.equal(kindleSyncState(ks(), plus(-60)), 'ok', '端末の時計のずれで未来でも stale にしない');
  assert.equal(kindleSyncState(ks({ intervalMin: undefined }), plus(45)), 'ok');
  assert.equal(kindleSyncState(ks({ intervalMin: undefined }), plus(46)), 'stale');
  assert.equal(kindleSyncState(ks({ needLogin: true, ok: false }), plus(1)), 'login');
  assert.equal(kindleSyncState(ks({ ok: false }), plus(1)), 'error');
  // stale が login より優先
  assert.equal(kindleSyncState(ks({ needLogin: true }), plus(100)), 'stale');
  assert.equal(kindleSyncState(ks(), Date.parse(plus(1))), 'ok', 'now は数値でもよい');
});

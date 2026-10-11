import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunk, importBody, isReachableCompanionUrl, pickBooksToFetch, statusReport, syncOutcome } from '../extension/sync-core.js';
import { parseFiles } from '../web/core/parsers/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SEP26 = 'Saturday September 26, 2026';
const SEP27 = 'Sunday September 27, 2026';
const SEP20 = 'Sunday September 20, 2026';

test('拡張: 日付が変わった本と、いちばん新しい日の本は何冊目でも読み直す', () => {
  // 朝 X を取り込み済み → 午後 X に線を追加し、夕方 A・B・C にも線を引いた（X は 4 冊目に下がる）
  const books = [
    { asin: 'C', lastAnnotated: SEP27 },
    { asin: 'B', lastAnnotated: SEP27 },
    { asin: 'A', lastAnnotated: SEP27 },
    { asin: 'X', lastAnnotated: SEP27 },
    { asin: 'OLD', lastAnnotated: SEP20 },
  ];
  const known = { X: SEP27, OLD: SEP20 };
  assert.deepEqual(pickBooksToFetch(books, known, { lastTopDate: SEP27 }).map((b) => b.asin), ['C', 'B', 'A', 'X']);
  // 初回（記録なし）は全冊
  assert.equal(pickBooksToFetch(books, {}).length, 5);
});

test('拡張: 日をまたいだ直後は、前回いちばん新しかった日の本も読み直す', () => {
  // 26 日の夜に Y を取り込んだ後、Y に線を追加。27 日に Z に線を引いた
  const books = [
    { asin: 'Z', lastAnnotated: SEP27 },
    { asin: 'Y', lastAnnotated: SEP26 },
    { asin: 'OLD', lastAnnotated: SEP20 },
  ];
  const known = { Y: SEP26, OLD: SEP20 };
  assert.deepEqual(pickBooksToFetch(books, known, { lastTopDate: SEP26 }).map((b) => b.asin), ['Z', 'Y']);
  // 取り込みが終わって前回の日付が 27 日になれば、Y は読み直さない
  assert.deepEqual(pickBooksToFetch(books, { ...known, Z: SEP27 }, { lastTopDate: SEP27 }).map((b) => b.asin), ['Z']);
});

test('拡張: 送る本文は既存の取り込み処理でそのまま読める（日本語・ハイライト無しの本は除く）', async () => {
  const body = importBody(
    [
      { asin: 'B1', title: '日本語の本', author: '著者', lastAnnotated: 'x', highlights: [{ text: '線を引いた箇所', note: 'メモ', location: '1,234', page: '', color: 'yellow' }] },
      { asin: 'B2', title: '空の本', author: '', lastAnnotated: 'x', highlights: [] },
    ],
    new Date('2026-09-27T00:00:00Z'),
  );
  assert.equal(body.auto, true);
  assert.equal(body.files[0].name, 'kindle-auto-2026-09-27.json');
  const { books, results } = await parseFiles(body.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.base64, 'base64') })));
  assert.equal(results[0].error, '');
  assert.equal(books.length, 1);
  assert.equal(books[0].title, '日本語の本');
  assert.equal(books[0].highlights[0].text, '線を引いた箇所');
  assert.equal(books[0].highlights[0].location, 1234);
});

test('拡張: PC の URL は host_permissions で届くものだけ受け付ける', () => {
  assert.ok(isReachableCompanionUrl('http://localhost:8787'));
  assert.ok(isReachableCompanionUrl('http://127.0.0.1:8787/'));
  assert.ok(isReachableCompanionUrl('https://my-pc.tail1234.ts.net'));
  assert.ok(!isReachableCompanionUrl('http://my-pc.tail1234.ts.net'));
  assert.ok(!isReachableCompanionUrl('https://example.com'));
  assert.ok(!isReachableCompanionUrl('not a url'));
});

test('拡張: manifest の host_permissions と URL の判定が食い違っていない', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes('http://localhost/*'));
  assert.ok(manifest.host_permissions.includes('https://*.ts.net/*'));
  assert.ok(manifest.host_permissions.includes('https://read.amazon.co.jp/*'));
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('拡張: PC への確認結果の報告には必要な項目だけを入れる', () => {
  const ok = statusReport({ ok: true, at: 'x', added: 3, fetched: 9, books: [1], error: '', token: 'secret' }, { intervalMin: '30', token: 'secret', companionUrl: 'http://localhost:8787' });
  assert.deepEqual(ok, { ok: true, needLogin: false, added: 3, fetched: 9, intervalMin: 30, error: '' });
  const ng = statusReport({ ok: false, needLogin: true, error: 'あ'.repeat(500) }, { intervalMin: 'abc' });
  assert.deepEqual(Object.keys(ng).sort(), ['added', 'error', 'fetched', 'intervalMin', 'needLogin', 'ok']);
  assert.equal(ng.fetched, 0);
  assert.equal(statusReport({ ok: true, fetched: -2 }, {}).fetched, 0);
  assert.equal(statusReport({ ok: true, fetched: 1.5 }, {}).fetched, 0);
  assert.equal(ng.intervalMin, 15);
  assert.equal(ng.added, 0);
  assert.equal(ng.needLogin, true);
  assert.equal(ng.error.length, 300);
  assert.equal(JSON.stringify(ng).includes('secret'), false);
});

test('拡張: 読み直した本がすべてハイライト 0 件なら、画面の形が変わった可能性として異常にする', () => {
  const allEmpty = syncOutcome({ failed: [], fetched: 3, withHighlights: 0 });
  assert.equal(allEmpty.ok, false);
  assert.match(allEmpty.error, /3 冊のハイライトがすべて 0 件/);
  assert.match(allEmpty.error, /画面の形が変わった可能性/);
  // 異常の間に読んだ本は既読になるので、直した後に取り込み直す手順を添える
  assert.match(allEmpty.error, /全ての本を取り込み直す/);
  // 1 冊でも読めれば今までどおり成功
  assert.deepEqual(syncOutcome({ failed: [], fetched: 3, withHighlights: 1 }), { ok: true, error: '' });
  // 読み直した本が無ければ成功（変化なし）
  assert.deepEqual(syncOutcome({ failed: [], fetched: 0, withHighlights: 0 }), { ok: true, error: '' });
});

test('拡張: 読めなかった本があるときは、その旨を理由にする（0 件の判定と重ねて出す）', () => {
  const some = syncOutcome({ failed: ['A', 'B', 'C', 'D'], fetched: 2, withHighlights: 1 });
  assert.equal(some.ok, false);
  assert.equal(some.error, '4 冊を読み取れませんでした（A、B、C ほか）。次回もう一度読みます。');
  const both = syncOutcome({ failed: ['A'], fetched: 2, withHighlights: 0 });
  assert.equal(both.ok, false);
  assert.match(both.error, /1 冊を読み取れませんでした/);
  assert.match(both.error, /画面の形が変わった可能性/);
  // 全部読めなかった（読み直せた本が 0 冊）なら 0 件の判定は出さない
  assert.doesNotMatch(syncOutcome({ failed: ['A'], fetched: 0, withHighlights: 0 }).error, /0 件/);
});

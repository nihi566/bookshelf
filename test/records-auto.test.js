import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, autoRecords, emptyRecordsFile, parseRecordsFile } from '../web/core/records.js';
import { emptyLibrary, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { parseKindleDate, parseNotebookJson } from '../web/core/parsers/kindle-notebook.js';

// 日本時間の 2026-08-15 0:00（Play ブックスのメモの日付はこの形で入る）
const AUG15_JST = '2026-08-14T15:00:00.000Z';

function libraryOf(parsedBooks, now = '2026-10-04T00:00:00.000Z') {
  const lib = emptyLibrary();
  mergeParsed(lib, parsedBooks, { now });
  return lib;
}

const play = (title, ...dates) => ({ title, author: '著者', source: 'playbooks', volumeId: 'vol123', highlights: dates.map((d, i) => ({ text: `${title}の線${i}`, createdAt: d })) });

test('parseKindleDate: Kindle のノートブックの日付（英語・日本語）を YYYY-MM-DD にする。読めなければ空', () => {
  assert.equal(parseKindleDate('Sunday September 27, 2026'), '2026-09-27');
  assert.equal(parseKindleDate('2026年9月7日 日曜日'), '2026-09-07');
  assert.equal(parseKindleDate('February 30, 2026'), '');
  assert.equal(parseKindleDate('x'), '');
  assert.equal(parseKindleDate(undefined), '');
});

test('Kindle: ノートブックの最終ハイライト日を本の annotatedOn に入れ、いちばん古い日を残す', () => {
  const nb = (date, text = '線') => parseNotebookJson({ format: 'book-highlights/kindle-notebook', books: [{ asin: 'B0D8N5G9GT', title: 'K本', author: 'A', lastAnnotated: date, highlights: [{ text }] }] });
  assert.equal(nb('Sunday September 27, 2026')[0].annotatedOn, '2026-09-27');
  const lib = libraryOf(nb('Sunday September 27, 2026'));
  const id = Object.keys(lib.books)[0];
  assert.equal(lib.books[id].annotatedOn, '2026-09-27');
  mergeParsed(lib, nb('Monday September 28, 2026', '別の線'), { now: '2026-10-05T00:00:00.000Z' });
  assert.equal(lib.books[id].annotatedOn, '2026-09-27', '後の同期で新しい日に置き換えない');

  // 端末どうしの同期でも古い方を残す
  const other = structuredClone(lib);
  other.books[id].annotatedOn = '2026-09-20';
  other.books[id].updatedAt = '2026-01-01T00:00:00.000Z';
  assert.equal(mergeLibraries(lib, other).books[id].annotatedOn, '2026-09-20');
  assert.equal(mergeLibraries(other, lib).books[id].annotatedOn, '2026-09-20');
});

test('autoRecords: 線が 1 本でもある本は読了。読んだ日は最初に線を引いた日（端末の日付）', () => {
  const lib = libraryOf([play('二本の本', '2026-09-03T03:00:00.000Z', AUG15_JST), play('一本の本', '2026-10-01T03:00:00.000Z')]);
  const { dated, undated } = autoRecords(lib, emptyRecordsFile());
  const byTitle = Object.fromEntries(Object.values(dated).map((r) => [r.title, r]));
  assert.equal(byTitle['二本の本'].read_on, '2026-08-15');
  assert.equal(byTitle['一本の本'].read_on, '2026-10-01');
  assert.equal(byTitle['一本の本'].auto, true);
  assert.equal(byTitle['一本の本'].pages, null);
  assert.equal(byTitle['一本の本'].volumeId, 'vol123');
  assert.deepEqual(undated, []);
});

test('autoRecords: 日付だけの createdAt はタイムゾーンでずらさずそのまま使う', () => {
  const lib = libraryOf([play('日付だけの本', '2026-08-15')]);
  assert.equal(Object.values(autoRecords(lib, emptyRecordsFile()).dated)[0].read_on, '2026-08-15');
});

test('autoRecords: 線に日付が無い本は Kindle の annotatedOn を使い、それも無ければ日付不明に回す', () => {
  const lib = libraryOf([
    { title: 'メモの本', author: '', source: 'memo', highlights: [{ text: 'メモ' }] },
    ...parseNotebookJson({ format: 'book-highlights/kindle-notebook', books: [{ asin: 'B0D8N5G9GT', title: 'K本', author: '', lastAnnotated: 'Sunday September 27, 2026', highlights: [{ text: '線' }] }] }),
  ]);
  const { dated, undated } = autoRecords(lib, emptyRecordsFile());
  assert.deepEqual(Object.values(dated).map((r) => [r.title, r.read_on]), [['K本', '2026-09-27']]);
  assert.deepEqual(undated.map((r) => r.title), ['メモの本']);
  assert.equal(undated[0].auto, true);
});

test('autoRecords: 手で付けた記録・記録から外した本・線を全部消した本・消した本は自動にしない', () => {
  const lib = libraryOf([play('手の本', AUG15_JST), play('外した本', AUG15_JST), play('消した本', AUG15_JST), play('線を消した本', AUG15_JST)]);
  const idOf = (title) => Object.values(lib.books).find((b) => b.title === title).id;
  lib.books[idOf('消した本')].deleted = true;
  for (const h of Object.values(lib.highlights)) if (h.bookId === idOf('線を消した本')) h.deleted = true;
  let file = applyChange(emptyRecordsFile(), { type: 'read', book_id: idOf('手の本'), title: '手の本', read_on: '2026-09-01', pages: 100 }, 'now');
  file = applyChange(file, { type: 'exclude', book_id: idOf('外した本') }, 'now');
  const { dated, undated } = autoRecords(lib, file);
  assert.deepEqual(Object.keys(dated), []);
  assert.deepEqual(undated, []);
});

test('applyChange exclude: 記録を消して外した本に入れる。後から手で記録すると外した本から戻す。未知のキーは残す', () => {
  let file = applyChange({ ...emptyRecordsFile(), extra: 1 }, { type: 'read', book_id: 'b1', title: 'B', read_on: '2026-09-01' }, 'now');
  file = applyChange(file, { type: 'exclude', book_id: 'b1' }, 't1');
  assert.equal(file.records.b1, undefined);
  assert.deepEqual(file.excluded, { b1: 't1' });
  assert.equal(file.extra, 1);
  assert.deepEqual(parseRecordsFile(file).excluded, { b1: 't1' });
  file = applyChange(file, { type: 'read', book_id: 'b1', title: 'B', read_on: '2026-09-02' }, 't2');
  assert.deepEqual(file.excluded, {});
  assert.equal(file.records.b1.read_on, '2026-09-02');
});

test('parseRecordsFile: excluded が無い・形が不正な古いファイルでも読める', () => {
  assert.deepEqual(parseRecordsFile({ records: {} }).excluded, {});
  assert.deepEqual(parseRecordsFile({ records: {}, excluded: [] }).excluded, {});
  assert.deepEqual(parseRecordsFile({ records: {}, excluded: { a: 'x', b: 3 } }).excluded, { a: 'x' });
});

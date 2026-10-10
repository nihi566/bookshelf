// NIH-13: ホームに今月の読書記録（冊数・ページ数）を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, emptyRecordsFile, monthReading, parseRecordsFile } from '../web/core/records.js';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const NOW = '2026-10-10T00:00:00.000Z';

function libraryOf(parsedBooks) {
  const lib = emptyLibrary();
  mergeParsed(lib, parsedBooks, { now: NOW });
  return lib;
}

const play = (title, date) => ({ title, author: '著者', source: 'playbooks', highlights: [{ text: `${title}の線`, createdAt: date }] });
const read = (file, book_id, read_on, pages = null) => applyChange(file, { type: 'read', book_id, title: `本 ${book_id}`, read_on, pages }, NOW);

test('monthReading: 手で付けた記録と、線から自動で付けた記録を合わせて、その月の冊数・ページ数を数える', () => {
  const lib = libraryOf([play('今月の線の本', '2026-10-02'), play('先月の線の本', '2026-09-20')]);
  let file = emptyRecordsFile();
  file = read(file, 'manual-a', '2026-10-03', 240);
  file = read(file, 'manual-b', '2026-10-08', 312);
  file = read(file, 'manual-c', '2026-09-30', 100);
  const r = monthReading(lib, parseRecordsFile(file), 2026, 10);
  assert.equal(r.count, 3, '手の 2 冊 + 線から自動の 1 冊（先月の本は数えない）');
  assert.equal(r.pages, 552, '自動の記録はページ数が無いので足さない');
  assert.equal(r.unknownCount, 1);
});

test('monthReading: 手で付けた記録が自動の記録より優先し、記録から外した本は数えない', () => {
  const lib = libraryOf([play('線の本 1', '2026-10-02'), play('線の本 2', '2026-10-04')]);
  const [id1, id2] = Object.keys(lib.books);
  let file = emptyRecordsFile();
  file = read(file, id1, '2026-09-28', 200); // 手で先月に直した → 今月には数えない
  file = applyChange(file, { type: 'exclude', book_id: id2 }, NOW);
  const r = monthReading(lib, parseRecordsFile(file), 2026, 10);
  assert.deepEqual([r.count, r.pages], [0, 0]);
  assert.deepEqual([monthReading(lib, parseRecordsFile(file), 2026, 9).count, monthReading(lib, parseRecordsFile(file), 2026, 9).pages], [1, 200]);
});

test('monthReading: 記録も線も無い月は 0 冊・0 ページ。引数を書き換えない', () => {
  const lib = libraryOf(SAMPLE_BOOKS);
  const file = parseRecordsFile(read(emptyRecordsFile(), 'manual-a', '2026-10-03', 240));
  const before = JSON.stringify([lib, file]);
  const r = monthReading(lib, file, 2030, 1);
  assert.deepEqual([r.count, r.pages, r.unknownCount], [0, 0, 0]);
  assert.equal(JSON.stringify([lib, file]), before);
});

test('ホーム: 今月の読書記録の行は、統計の下に置き場だけを用意する（中身は読めたときだけ後から入れる）', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = libraryOf(SAMPLE_BOOKS);
  const state = { library: lib, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
  const out = String(home.render({ state, shuffle: 0 }));
  const box = out.match(/<p id="home-records"[^>]*><\/p>/);
  assert.ok(box, '空の置き場がある（読めないときは何も出さない）');
  assert.ok(out.indexOf('class="stats"') < out.indexOf('id="home-records"') && out.indexOf('id="home-records"') < out.indexOf('class="today"'), '統計の下・今日の点の上');
});

test('ホーム: 今月の読書記録の 1 行は「今月 N 冊・N ページ（読書記録へ）」で、読書記録の画面へつながる', async () => {
  const { homeRecordsLine } = await import('../web/js/views/records.js');
  const line = String(homeRecordsLine({ year: 2026, month: 10, count: 3, pages: 1552, unknownCount: 1 }));
  assert.match(line, /今月 3 冊・1,552 ページ/);
  assert.match(line, /href="#\/records\?y=2026&amp;m=10"[^>]*>読書記録へ<\/a>/);
});

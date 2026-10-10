// 境界値・異常系のテスト（model / records / records-github / thoughts / sample / discovery-reads / auto-analysis）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addHighlight,
  bookHighlights,
  bookIdFor,
  compareInBook,
  dailyPicks,
  dedupeContained,
  deleteBook,
  emptyLibrary,
  feedbackByStatus,
  feedbackFor,
  guessTechnical,
  highlightIdFor,
  isTechnicalBook,
  libraryStats,
  listBooks,
  mergeLibraries,
  mergeParsed,
  registerBook,
  searchHighlights,
  setFeedback,
  updateBook,
  updateHighlight,
} from '../web/core/model.js';
import {
  addMonths,
  applyChange,
  assertRecordsShape,
  autoRecords,
  decodeBase64Utf8,
  emptyRecordsFile,
  encodeBase64Utf8,
  isManualId,
  isValidDate,
  MAX_PAGES,
  newManualId,
  parsePagesInput,
  parseRecordsFile,
  summarizeMonth,
  summarizeYear,
  todayLocal,
  weekdayLabel,
} from '../web/core/records.js';
import { BRANCH, fetchRecords, recordsErrorMessage, saveChange } from '../web/core/records-github.js';
import {
  addThought,
  deleteThought,
  inboxThoughts,
  isThoughtId,
  mergeThought,
  normalizeThought,
  pointThoughts,
  searchThoughts,
  THOUGHT_MAX_LENGTH,
  thoughtCounts,
  updateThought,
} from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { discoveriesOf, isRead, markDiscoveryRead, mergeReads, readsOf, unreadDiscoveries } from '../web/core/discovery-reads.js';
import { AUTO_DEFAULTS, AUTO_RETRY_MS, autoAnalyzeDue, autoConfig, pendingPoints } from '../web/core/auto-analysis.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

const kindle = (title, highlights, extra = {}) => ({ title, author: '著者', source: 'kindle', highlights, ...extra });
const play = (title, highlights, extra = {}) => ({ title, author: '著者', source: 'playbooks', highlights, ...extra });

function libWith(books, now = T1) {
  const lib = emptyLibrary();
  mergeParsed(lib, books, { now });
  return lib;
}

// ================= model.js =================

test('edge model: mergeParsed は空・空白だけの書名や本文を飛ばし、入力を変えない', () => {
  const lib = emptyLibrary();
  const input = [
    kindle('', [{ text: 'x' }]),
    kindle('   \n\t ', [{ text: 'x' }]),
    kindle('本A', [{ text: '' }, { text: '  \n ' }, { text: null }, { text: '本文', note: null }]),
  ];
  const snapshot = structuredClone(input);
  const stats = mergeParsed(lib, input, { now: T1 });
  assert.deepEqual(input, snapshot, '入力は変えない');
  assert.equal(Object.keys(lib.books).length, 1);
  assert.equal(stats.added, 1);
  const [h] = Object.values(lib.highlights);
  assert.equal(h.text, '本文');
  assert.equal(h.note, '');
});

test('edge model: 空の取り込みでも壊れない（updatedAt だけ進む）', () => {
  const lib = emptyLibrary();
  const stats = mergeParsed(lib, [], { now: T1 });
  assert.equal(stats.books, 0);
  assert.equal(lib.updatedAt, T1);
  assert.deepEqual(listBooks(lib), []);
  assert.deepEqual(dailyPicks(lib), []);
  assert.deepEqual(searchHighlights(lib, 'x'), []);
  assert.deepEqual(libraryStats(lib), { books: 0, highlights: 0, technical: 0, bySource: {}, favorites: 0, thoughts: 0, points: 0 });
});

test('edge model: 改行・連続空白の入った書名は 1 行にまとまり、表記ゆれは同じ本になる', () => {
  const lib = libWith([kindle('深い\n集中', [{ text: 'a' }]), play('深い　集中！', [{ text: 'b' }])]);
  const books = Object.values(lib.books);
  assert.equal(books.length, 1);
  assert.equal(books[0].title, '深い 集中');
  assert.deepEqual(books[0].sources, ['kindle', 'playbooks']);
});

test('edge model: 同じ取り込みを 2 回しても増えない（冪等）', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  const before = structuredClone(lib);
  const stats = mergeParsed(lib, SAMPLE_BOOKS, { now: T2 });
  assert.equal(stats.added, 0);
  assert.equal(stats.updated, 0);
  assert.equal(Object.keys(lib.highlights).length, Object.keys(before.highlights).length);
});

test('edge model: NFKC・大文字小文字・空白だけ違う本文は同じ点（ID が衝突してよい）', () => {
  assert.equal(highlightIdFor('b1', 'ＡＢＣ  def'), highlightIdFor('b1', 'abc def'));
  assert.notEqual(highlightIdFor('b1', 'abc'), highlightIdFor('b2', 'abc'));
  const lib = libWith([play('本', [{ text: 'ＡＢＣ def' }, { text: 'abc   def', note: 'メモ' }])]);
  const hs = Object.values(lib.highlights);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].note, 'メモ', '後から来た重複で空欄を埋める');
});

test('edge model: 位置が数でない・空の値は null、ページは文字列になる', () => {
  const lib = libWith([play('本', [{ text: 'a', location: 'abc', locationEnd: '', page: 12 }, { text: 'b', location: '15', page: 0 }])]);
  const [a, b] = ['a', 'b'].map((t) => lib.highlights[highlightIdFor(bookIdFor('本'), t)]);
  assert.equal(a.location, null);
  assert.equal(a.locationEnd, null);
  assert.equal(a.page, '12');
  assert.equal(b.location, 15);
  assert.equal(b.page, '0', 'ページ 0 も文字列で残す');
});

test('edge model: Kindle の伸ばしたハイライトは同じ取り込み内でも後の取り込みでも短い方を置き換え、編集を引き継ぐ', () => {
  const lib = libWith([kindle('本', [{ text: '短い文', location: 10 }])]);
  const shortId = highlightIdFor(bookIdFor('本'), '短い文');
  updateHighlight(lib, shortId, { favorite: true, tags: ['#t', 't', ' '] }, T2);
  assert.deepEqual(lib.highlights[shortId].tags, ['t']);
  mergeParsed(lib, [kindle('本', [{ text: '短い文を伸ばした', location: 10, locationEnd: 11 }])], { now: T3 });
  const longId = highlightIdFor(bookIdFor('本'), '短い文を伸ばした');
  assert.equal(lib.highlights[shortId].deleted, true);
  assert.equal(lib.highlights[shortId].supersededBy, longId);
  assert.equal(lib.highlights[longId].favorite, true);
  assert.deepEqual(lib.highlights[longId].tags, ['t']);
  // 短い方をもう一度取り込んでも戻らない
  const stats = mergeParsed(lib, [kindle('本', [{ text: '短い文', location: 10 }])], { now: T3 });
  assert.equal(stats.skippedDeleted, 1);
  assert.equal(bookHighlights(lib, bookIdFor('本')).length, 1);
});

test('edge model: dedupeContained は位置もページも無い線を消さず、入力を変えない', () => {
  const input = [{ text: '長い文章です' }, { text: '長い文章' }, { text: 'abc', location: 5 }, { text: 'ab', location: 5, note: 'n' }];
  const snapshot = structuredClone(input);
  const out = dedupeContained(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(out.map((h) => h.text), ['長い文章です', '長い文章', 'abc']);
  assert.equal(out[2].note, 'n', '消した短い線のメモは長い方へ移す');
  assert.deepEqual(dedupeContained([]), []);
});

test('edge model: annotatedOn は古い日を残し、新しい日では上書きしない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }], { annotatedOn: '2026-05-01' })]);
  mergeParsed(lib, [kindle('本', [{ text: 'a' }], { annotatedOn: '2026-06-01' })], { now: T2 });
  assert.equal(lib.books[bookIdFor('本')].annotatedOn, '2026-05-01');
  const stats = mergeParsed(lib, [kindle('本', [{ text: 'a' }], { annotatedOn: '2026-04-01' })], { now: T3 });
  assert.equal(lib.books[bookIdFor('本')].annotatedOn, '2026-04-01');
  assert.equal(stats.booksUpdated, 1);
});

test('edge model: reviveDeleted:false は削除した本を戻さず、既定では点ごと戻す', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }, { text: 'b' }])]);
  const id = bookIdFor('本');
  updateHighlight(lib, highlightIdFor(id, 'b'), { deleted: true }, T2);
  deleteBook(lib, id, T2);
  assert.equal(listBooks(lib).length, 0);
  const s1 = mergeParsed(lib, [kindle('本', [{ text: 'a' }])], { now: T3, reviveDeleted: false });
  assert.equal(s1.skippedDeletedBooks, 1);
  assert.equal(lib.books[id].deleted, true);
  mergeParsed(lib, [kindle('本', [{ text: 'c' }])], { now: T3 });
  assert.equal(lib.books[id].deleted, undefined);
  // 本と一緒に消した点だけ戻り、先に自分で消した点は消えたまま
  assert.deepEqual(bookHighlights(lib, id).map((h) => h.text).sort(), ['a', 'c']);
});

test('edge model: deleteBook・updateHighlight は存在しない ID で何もしない', () => {
  const lib = emptyLibrary();
  assert.equal(deleteBook(lib, 'nope', T1), undefined);
  assert.equal(updateHighlight(lib, 'nope', { favorite: true }, T1), null);
  assert.equal(lib.updatedAt, null);
});

test('edge model: updateHighlight は許可していない欄を変えない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  const id = highlightIdFor(bookIdFor('本'), 'a');
  // 文は直せる欄（NIH-56）。取り込んだときの文・直した時刻・出どころは直接書き換えさせない
  updateHighlight(lib, id, { source: 'paper', originalText: '改ざん', textEditedAt: T1, bookId: 'x', userNote: 'メモ' }, T2);
  assert.equal(lib.highlights[id].text, 'a');
  assert.equal(lib.highlights[id].source, 'kindle');
  assert.equal('originalText' in lib.highlights[id], false);
  assert.equal('textEditedAt' in lib.highlights[id], false);
  assert.equal(lib.highlights[id].bookId, bookIdFor('本'));
  assert.equal(lib.highlights[id].userNote, 'メモ');
  assert.equal(lib.highlights[id].userUpdatedAt, T2);
});

test('edge model: compareInBook は位置→ページ→日付の順で、位置が無いものを後ろにする', () => {
  const items = [
    { page: '12', createdAt: '2026-01-01' },
    { location: 5 },
    { createdAt: '2026-01-02' },
    { page: 'xii' },
    { location: 0 },
    { page: '3' },
  ];
  const sorted = [...items].sort(compareInBook);
  assert.deepEqual(sorted.map((x) => x.location ?? x.page ?? x.createdAt), [0, '3', 5, '12', 'xii', '2026-01-02']);
});

test('edge model: 技術書の推定は語の境界を見て、PHP 新書は除く。null でも落ちない', () => {
  assert.equal(guessTechnical('Digital Minimalism'), false);
  assert.equal(guessTechnical('Git 入門'), true);
  assert.equal(guessTechnical('ＰＹＴＨＯＮ 実践'), true, '全角でも');
  assert.equal(guessTechnical('PHP新書 心の整理'), false);
  assert.equal(guessTechnical(null), false);
  assert.equal(guessTechnical(undefined), false);
  assert.equal(isTechnicalBook(null), false);
  assert.equal(isTechnicalBook({ title: 'Python', technical: false }), false);
});

test('edge model: setFeedback は同じ反応で外し、feedbackByStatus は外した反応を数えない', () => {
  const lib = emptyLibrary();
  delete lib.feedback;
  setFeedback(lib, { title: '本 A' }, 'want', T1);
  assert.equal(feedbackFor(lib, '本A').status, 'want', '表記ゆれでも同じ本');
  setFeedback(lib, { title: '本A', author: '' }, 'want', T2);
  assert.equal(feedbackFor(lib, '本A'), null);
  assert.deepEqual(feedbackByStatus(lib), { read: [], want: [], no: [] });
  assert.throws(() => setFeedback(lib, { title: 'x' }, 'bogus', T1));
  assert.throws(() => setFeedback(lib, { title: 'x' }, 'toString', T1));
});

test('edge model: feedbackByStatus は継承した名前の状態（同期で届いた壊れた値）で落ちない', () => {
  const lib = emptyLibrary();
  lib.feedback = { a: { key: 'a', title: 'a', status: 'constructor', updatedAt: T1 }, b: { key: 'b', title: 'b', status: 'read', updatedAt: T1 } };
  const out = feedbackByStatus(lib);
  assert.deepEqual(out.read.map((f) => f.key), ['b']);
});

test('edge model: registerBook は空の書名・不正な表紙を拒み、同じ書名なら紙の本を足すだけ', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  assert.throws(() => registerBook(lib, { title: '  ' }, T2));
  assert.throws(() => registerBook(lib, { title: 'x', cover: 'javascript:alert(1)' }, T2));
  assert.equal(Object.keys(lib.books).length, 1, '拒んだときは本を作らない');
  const b = registerBook(lib, { title: '本', technical: true }, T2);
  assert.deepEqual(b.sources, ['kindle', 'paper']);
  assert.equal(b.technical, true);
  assert.equal(Object.keys(lib.highlights).length, 1);
  updateBook(lib, b.id, { technical: null }, T3);
  assert.equal('technical' in lib.books[b.id], false);
});

test('edge model: registerBook の空の紙の本は includeEmpty でだけ一覧に出る', () => {
  const lib = emptyLibrary();
  registerBook(lib, { title: '紙の本' }, T1);
  assert.equal(listBooks(lib).length, 0);
  const [b] = listBooks(lib, { includeEmpty: true });
  assert.equal(b.count, 0);
  assert.equal(b.lastHighlightedAt, T1);
});

test('edge model: addHighlight は空文字を拒み、同じ文は増やさず、消した文は戻す', () => {
  const lib = emptyLibrary();
  const book = registerBook(lib, { title: '紙' }, T1);
  assert.throws(() => addHighlight(lib, book.id, { text: ' \n ' }, T1));
  assert.throws(() => addHighlight(lib, 'nope', { text: 'x' }, T1));
  const first = addHighlight(lib, book.id, { text: ' 線の文 ', page: 3 }, T1);
  assert.equal(first.added, true);
  assert.equal(first.highlight.text, '線の文');
  assert.equal(first.highlight.page, '3');
  const again = addHighlight(lib, book.id, { text: '線の文' }, T2);
  assert.equal(again.added, false);
  updateHighlight(lib, first.highlight.id, { deleted: true }, T2);
  const back = addHighlight(lib, book.id, { text: '線の文' }, T3);
  assert.equal(back.added, true);
  assert.equal(back.highlight.deleted, undefined);
  assert.equal(bookHighlights(lib, book.id).length, 1);
  // 削除した本には足せない
  deleteBook(lib, book.id, T3);
  assert.throws(() => addHighlight(lib, book.id, { text: '別' }, T3));
});

test('edge model: dailyPicks は同じ日に同じ結果、件数より点が少なければあるだけ', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }, { text: 'b' }])]);
  const d = new Date(2026, 9, 4, 23, 59);
  assert.deepEqual(dailyPicks(lib, 3, d).map((h) => h.id), dailyPicks(lib, 3, new Date(2026, 9, 4, 0, 1)).map((h) => h.id));
  assert.equal(dailyPicks(lib, 5, d).length, 2);
  assert.equal(dailyPicks(lib, 0, d).length, 0);
});

test('edge model: searchHighlights は空白だけの検索で全件、タグ・著者でも当たり、大文字小文字を区別しない', () => {
  const lib = libWith([kindle('Deep Work', [{ text: 'Focus Matters' }, { text: 'other' }])]);
  const id = highlightIdFor(bookIdFor('Deep Work'), 'other');
  updateHighlight(lib, id, { tags: ['習慣'] }, T2);
  assert.equal(searchHighlights(lib, '   ').length, 2);
  assert.equal(searchHighlights(lib, 'focus').length, 1);
  assert.equal(searchHighlights(lib, 'ＦＯＣＵＳ').length, 1);
  assert.equal(searchHighlights(lib, '#習慣').length, 1);
  assert.equal(searchHighlights(lib, '著者 deep').length, 2);
  assert.equal(searchHighlights(lib, 'focus nothing').length, 0);
});

// ---- mergeLibraries ----

function deviceLibs() {
  const a = libWith(SAMPLE_BOOKS, T1);
  const b = structuredClone(a);
  const ids = Object.keys(a.highlights).sort();
  return { a, b, ids };
}

test('edge model: mergeLibraries は向きに依らない（衝突する編集・同時刻・片方だけの項目）', () => {
  const { a, b, ids } = deviceLibs();
  updateHighlight(a, ids[0], { favorite: true }, T2);
  updateHighlight(b, ids[0], { userNote: 'スマホ' }, T3);
  updateHighlight(a, ids[1], { tags: ['x'] }, T2);
  updateHighlight(b, ids[1], { tags: ['y'] }, T2); // 同時刻
  updateHighlight(b, ids[2], { deleted: true }, T2);
  mergeParsed(b, [kindle('スマホだけの本', [{ text: 'z' }])], { now: T2 });
  setFeedback(a, { title: 'お勧め' }, 'read', T2);
  setFeedback(b, { title: 'お勧め' }, 'no', T2); // 同時刻
  addThought(a, { text: '思いつき A' }, T2, 'ta1');
  addThought(b, { text: '思いつき B' }, T2, 'ta1'); // 同じ ID・同時刻
  markDiscoveryRead(a, 'd1', T3);
  markDiscoveryRead(b, 'd1', T2);
  const ab = mergeLibraries(a, b);
  const ba = mergeLibraries(b, a);
  assert.deepEqual(ab, ba);
  assert.equal(ab.highlights[ids[0]].userNote, 'スマホ');
  assert.equal(ab.highlights[ids[2]].deleted, true);
  assert.equal(ab.discoveryReads.d1, T2, '既読の時刻は早い方');
  assert.ok(ab.books[bookIdFor('スマホだけの本')]);
});

test('edge model: mergeLibraries は冪等で、引数を変えず、結果は引数と参照を共有しない', () => {
  const { a, b, ids } = deviceLibs();
  updateHighlight(b, ids[0], { tags: ['t'] }, T2);
  setFeedback(a, { title: '甲' }, 'want', T2);
  setFeedback(b, { title: '乙' }, 'read', T2);
  addThought(a, { text: 'メモ' }, T2, 'tx');
  const sa = structuredClone(a);
  const sb = structuredClone(b);
  const m = mergeLibraries(a, b);
  assert.deepEqual(a, sa);
  assert.deepEqual(b, sb);
  assert.deepEqual(mergeLibraries(m, b), m);
  assert.deepEqual(mergeLibraries(m, m), m);
  // 結果を変えても引数に響かない
  for (const f of Object.values(m.feedback)) f.status = 'changed';
  for (const t of Object.values(m.thoughts)) t.text = 'changed';
  m.highlights[ids[0]].tags.push('changed');
  assert.deepEqual(a, sa);
  assert.deepEqual(b, sb);
});

test('edge model: mergeLibraries は古い版のデータ（欄の無いライブラリ）でも落ちない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  const old = { version: 1, books: {}, highlights: {} };
  const m1 = mergeLibraries(lib, old);
  const m2 = mergeLibraries(old, lib);
  assert.deepEqual(m1.books, m2.books);
  assert.deepEqual(m1.highlights, m2.highlights);
  assert.deepEqual(m1.thoughts, {});
  assert.deepEqual(m1.discoveryReads, {});
  const m3 = mergeLibraries({}, {});
  assert.deepEqual(m3.books, {});
  assert.equal(m3.updatedAt, null);
});

test('edge model: 削除した本と、もう一方の端末での追加取り込みの統合（利用者の削除が新しければ消えたまま）', () => {
  const { a, b } = deviceLibs();
  const id = bookIdFor(SAMPLE_BOOKS[0].title);
  deleteBook(a, id, T3);
  mergeParsed(b, [{ ...SAMPLE_BOOKS[0], highlights: [{ text: '新しい線' }] }], { now: T2 });
  const m = mergeLibraries(a, b);
  assert.deepEqual(m, mergeLibraries(b, a));
  assert.equal(m.books[id].deleted, true);
  assert.equal(bookHighlights(m, id).length, 0);
});

test('edge model: 不正な表紙はどちらの端末から来ても持たない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  const other = structuredClone(lib);
  other.books[bookIdFor('本')].cover = 'https://evil.example/x.png';
  other.books[bookIdFor('本')].userUpdatedAt = T3;
  const m = mergeLibraries(lib, other);
  assert.equal('cover' in m.books[bookIdFor('本')], false);
  const only = mergeLibraries(emptyLibrary(), other);
  assert.equal('cover' in only.books[bookIdFor('本')], false);
});

// ================= records.js =================

test('edge records: isValidDate はうるう年・月末・形の違いを見分ける', () => {
  assert.ok(isValidDate('2024-02-29'));
  assert.ok(!isValidDate('2023-02-29'));
  assert.ok(isValidDate('2000-02-29'));
  assert.ok(!isValidDate('1900-02-29'));
  assert.ok(!isValidDate('2026-13-01'));
  assert.ok(!isValidDate('2026-00-10'));
  assert.ok(!isValidDate('2026-01-00'));
  assert.ok(!isValidDate('2026-04-31'));
  assert.ok(!isValidDate(' 2026-01-01'));
  assert.ok(!isValidDate('2026-01-01T00:00:00Z'));
  assert.ok(!isValidDate('２０２６-01-01'));
  assert.ok(!isValidDate(20260101));
  assert.ok(!isValidDate(undefined));
});

test('edge records: parsePagesInput は全角・前後の空白を受け、範囲外・小数・文字を拒む', () => {
  assert.equal(parsePagesInput(''), null);
  assert.equal(parsePagesInput(null), null);
  assert.equal(parsePagesInput(undefined), null);
  assert.equal(parsePagesInput('  '), null);
  assert.equal(parsePagesInput(' ３２０ '), 320);
  assert.equal(parsePagesInput(1), 1);
  assert.equal(parsePagesInput(String(MAX_PAGES)), MAX_PAGES);
  for (const bad of ['0', '-1', '1.5', 'abc', String(MAX_PAGES + 1), 'Infinity', 'NaN', '1e100']) {
    assert.throws(() => parsePagesInput(bad), undefined, bad);
  }
});

test('edge records: parseRecordsFile は壊れた項目を捨て、値を安全な既定へ倒す', () => {
  assert.throws(() => parseRecordsFile(null), (e) => e.kind === 'parse');
  assert.throws(() => parseRecordsFile([]), (e) => e.kind === 'parse');
  assert.throws(() => parseRecordsFile({ records: [] }), (e) => e.kind === 'parse');
  assert.throws(() => assertRecordsShape({ records: null }), (e) => e.kind === 'parse');
  const parsed = parseRecordsFile({
    records: {
      ok: { title: ' 書名\n改行 ', author: 123, asin: 'b0d8n5g9gt', volumeId: 'ok_id-1', read_on: '2026-10-04', pages: 0, updated_at: 5 },
      bigPages: { title: 'x', read_on: '2026-10-04', pages: MAX_PAGES + 1 },
      strPages: { title: 'x', read_on: '2026-10-04', pages: '100' },
      badDate: { title: 'x', read_on: '2026-02-30' },
      notObj: 'x',
      arr: [],
      nul: null,
    },
    excluded: { a: '2026-01-01', b: 5, c: null },
  });
  assert.deepEqual(Object.keys(parsed.records).sort(), ['bigPages', 'ok', 'strPages']);
  assert.deepEqual(parsed.records.ok, { title: '書名 改行', author: '123', asin: '', volumeId: 'ok_id-1', read_on: '2026-10-04', pages: null, updated_at: '' });
  assert.equal(parsed.records.bigPages.pages, null);
  assert.equal(parsed.records.strPages.pages, null);
  assert.deepEqual(parsed.excluded, { a: '2026-01-01' });
  assert.equal(parsed.version, 1);
});

test('edge records: parseRecordsFile は __proto__ の鍵で入れ物の継承元を書き換えない', () => {
  const json = JSON.parse('{"records":{"__proto__":{"title":"x","read_on":"2026-10-04"},"ok":{"title":"y","read_on":"2026-10-04"}},"excluded":{"__proto__":"2026-01-01"}}');
  const parsed = parseRecordsFile(json);
  assert.equal(Object.getPrototypeOf(parsed.records), Object.prototype);
  assert.equal(Object.getPrototypeOf(parsed.excluded), Object.prototype);
  assert.equal(parsed.records.title, undefined);
  assert.deepEqual(Object.keys(parsed.records), ['ok']);
});

test('edge records: parseRecordsFile は冪等（読み直しても同じ）', () => {
  const once = parseRecordsFile({ records: { a: { title: ' t ', read_on: '2026-01-01', pages: 10, extra: 1 } }, excluded: { b: 'x' } });
  assert.deepEqual(parseRecordsFile(once), once);
  assert.deepEqual(parseRecordsFile(JSON.parse(JSON.stringify(once))), once);
});

test('edge records: applyChange の異常系（ID 無し・未知の種類・不正な値）は例外にし、元を変えない', () => {
  const file = emptyRecordsFile();
  const snap = structuredClone(file);
  assert.throws(() => applyChange(file, null, T1), /book_id/);
  assert.throws(() => applyChange(file, { type: 'read', book_id: '' }, T1), /book_id/);
  assert.throws(() => applyChange(file, { type: 'zap', book_id: 'a' }, T1), /未知/);
  assert.throws(() => applyChange(file, { type: 'read', book_id: 'a', title: 't', read_on: '2026-02-30' }, T1), /読んだ日/);
  assert.throws(() => applyChange(file, { type: 'read', book_id: 'a', title: 't', read_on: '2026-02-03', pages: 0 }, T1), /ページ/);
  assert.throws(() => applyChange(file, { type: 'read', book_id: 'a', title: 't', read_on: '2026-02-03', pages: 1.5 }, T1), /ページ/);
  assert.throws(() => applyChange(file, { type: 'read', book_id: 'a', title: ' \n ', read_on: '2026-02-03' }, T1), /書名/);
  assert.deepEqual(file, snap);
});

test('edge records: exclude → read で外した印が消え、read → exclude で記録が消える。元のファイルは変えない', () => {
  const base = { version: 1, records: {}, excluded: { a: 'old' } };
  const snap = structuredClone(base);
  const r = applyChange(base, { type: 'read', book_id: 'a', title: 't', read_on: '2026-10-04' }, T1);
  assert.deepEqual(base, snap);
  assert.deepEqual(r.excluded, {});
  assert.equal(r.records.a.pages, null);
  const e = applyChange(r, { type: 'exclude', book_id: 'a' }, T2);
  assert.deepEqual(e.records, {});
  assert.deepEqual(e.excluded, { a: T2 });
  assert.equal(r.records.a.title, 't', '前のファイルも変えない');
  // excluded の無い古いファイルでも
  const old = applyChange({ version: 1, records: {} }, { type: 'remove', book_id: 'zzz' }, T1);
  assert.deepEqual(old.excluded, {});
  // 数値の book_id は文字列にする
  const n = applyChange(emptyRecordsFile(), { type: 'read', book_id: 42, title: 't', read_on: '2026-10-04' }, T1);
  assert.ok(Object.hasOwn(n.records, '42'));
});

test('edge records: 書名・著者は空白を詰めて長さを切る', () => {
  const f = applyChange(emptyRecordsFile(), { type: 'read', book_id: 'a', title: 'あ'.repeat(500), author: ' x\n\ty ', read_on: '2026-10-04' }, T1);
  assert.equal(f.records.a.title.length, 200);
  assert.equal(f.records.a.author, 'x y');
});

test('edge records: newManualId / isManualId', () => {
  const id = newManualId(0, () => 0);
  assert.equal(id, 'manual-00000');
  assert.ok(isManualId(id));
  assert.ok(!isManualId('bxyz'));
  assert.ok(!isManualId(null));
  const hi = newManualId(Date.UTC(2026, 9, 4), () => 0.999999999);
  assert.match(hi, /^manual-[0-9a-z]+$/);
  assert.notEqual(newManualId(1, () => 0.1), newManualId(1, () => 0.2));
});

test('edge records: base64 の往復（日本語・絵文字・空・改行入りの base64）', () => {
  for (const s of ['', 'abc', '読書記録 📚 𠮷野家', JSON.stringify({ a: '\u0000\n"' })]) {
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(s)), s);
  }
  const enc = encodeBase64Utf8('x'.repeat(200));
  const wrapped = enc.replace(/(.{60})/g, '$1\n');
  assert.equal(decodeBase64Utf8(wrapped), 'x'.repeat(200), 'GitHub の改行入り base64 も読む');
  const big = 'あ'.repeat(300000);
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(big)), big);
});

test('edge records: todayLocal / weekdayLabel / addMonths の境界', () => {
  assert.equal(todayLocal(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01');
  assert.equal(todayLocal(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  assert.equal(weekdayLabel('2026-10-04'), '日');
  assert.equal(weekdayLabel('2024-02-29'), '木');
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths(2026, 3, -27), { year: 2023, month: 12 });
  assert.deepEqual(addMonths(2026, 3, 0), { year: 2026, month: 3 });
  assert.deepEqual(addMonths(2026, 6, 120), { year: 2036, month: 6 });
});

test('edge records: summarizeMonth / summarizeYear の空・境界・ページ不明', () => {
  assert.deepEqual(summarizeMonth({}, 2026, 10), { count: 0, pages: 0, unknownCount: 0, days: [] });
  assert.deepEqual(summarizeMonth(undefined, 2026, 10).days, []);
  const year = summarizeYear(null, 2026);
  assert.equal(year.count, 0);
  assert.equal(year.months.length, 12);
  const records = {
    a: { title: 'い', read_on: '2026-10-01', pages: 100 },
    b: { title: 'あ', read_on: '2026-10-01', pages: null },
    c: { title: 'c', read_on: '2026-10-31', pages: 20000 },
    d: { title: 'd', read_on: '2026-09-30', pages: 1 },
    e: { title: 'e', read_on: '2026-11-01', pages: 1 },
    f: { title: 'f', read_on: '2025-10-15', pages: 1 },
    g: { title: 'g', read_on: '2026-01-05', pages: 3, auto: true },
  };
  const m = summarizeMonth(records, 2026, 10);
  assert.equal(m.count, 3);
  assert.equal(m.pages, 20100);
  assert.equal(m.unknownCount, 1);
  assert.deepEqual(m.days.map((d) => d.date), ['2026-10-31', '2026-10-01']);
  assert.deepEqual(m.days[1].items.map((i) => i.title), ['あ', 'い']);
  assert.equal(m.days[1].items[0].book_id, 'b');
  const y = summarizeYear(records, 2026);
  assert.equal(y.count, 6);
  assert.equal(y.months[0].count, 1);
  assert.equal(y.months[9].pages, 20100);
  assert.equal(y.months[10].count, 1);
  // 1 桁の月でも 2026-1 が 2026-10〜12 と混ざらない
  assert.equal(summarizeMonth(records, 2026, 1).count, 1);
});

test('edge records: autoRecords は日本時間の日付で、日付の無い本は undated、手の記録・外した本・削除した本は除く', () => {
  const lib = libWith([
    play('境界', [{ text: 'a', createdAt: '2026-10-03T15:00:00.000Z' }, { text: 'b', createdAt: '2026-10-05T00:00:00.000Z' }]),
    play('日付だけ', [{ text: 'c', createdAt: '2026-10-01' }]),
    play('壊れた日付', [{ text: 'd', createdAt: 'not a date' }]),
    kindle('Kindle', [{ text: 'e' }], { annotatedOn: '2026-07-07' }),
    kindle('Kindle 不正', [{ text: 'f' }], { annotatedOn: '2026-02-30' }),
    play('手で記録', [{ text: 'g', createdAt: T1 }]),
    play('外した', [{ text: 'h', createdAt: T1 }]),
    play('削除', [{ text: 'i', createdAt: T1 }]),
  ]);
  deleteBook(lib, bookIdFor('削除'), T2);
  const file = { records: { [bookIdFor('手で記録')]: { title: 'x', read_on: '2026-01-01' } }, excluded: { [bookIdFor('外した')]: T1 } };
  const { dated, undated } = autoRecords(lib, file);
  assert.equal(dated[bookIdFor('境界')].read_on, '2026-10-04', 'UTC 15 時は日本時間の翌日');
  assert.equal(dated[bookIdFor('日付だけ')].read_on, '2026-10-01');
  assert.equal(dated[bookIdFor('Kindle')].read_on, '2026-07-07');
  assert.deepEqual(undated.map((u) => u.title).sort(), ['Kindle 不正', '壊れた日付'].sort());
  assert.ok(!dated[bookIdFor('手で記録')] && !dated[bookIdFor('外した')] && !dated[bookIdFor('削除')]);
  assert.ok(Object.values(dated).every((r) => r.auto === true && r.pages === null));
  // excluded の無いファイルでも
  assert.ok(autoRecords(lib, { records: {} }).dated[bookIdFor('外した')]);
  // 空のライブラリ
  assert.deepEqual(autoRecords(emptyLibrary(), emptyRecordsFile()), { dated: {}, undated: [] });
});

test('edge records: autoRecords は消した線の日付を使わない', () => {
  const lib = libWith([play('本', [{ text: 'a', createdAt: '2026-01-01T03:00:00Z' }, { text: 'b', createdAt: '2026-05-01T03:00:00Z' }])]);
  updateHighlight(lib, highlightIdFor(bookIdFor('本'), 'a'), { deleted: true }, T2);
  assert.equal(autoRecords(lib, emptyRecordsFile()).dated[bookIdFor('本')].read_on, '2026-05-01');
});

// ================= records-github.js =================

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

const contentBody = (obj, sha = 'sha1') => JSON.stringify({ content: encodeBase64Utf8(JSON.stringify(obj)), sha });

test('edge github: 2xx でも本文が JSON でない・null・中身が壊れているときは parse として扱う', async () => {
  for (const body of ['not json', 'null', '[]', '{}', JSON.stringify({ content: '!!!' }), JSON.stringify({ content: encodeBase64Utf8('{"records": []}') }), JSON.stringify({ content: encodeBase64Utf8('') })]) {
    const { fetchImpl } = stubFetch(() => new Response(body, { status: 200 }));
    await assert.rejects(fetchRecords('', { fetchImpl }), (e) => e.kind === 'parse', body);
  }
});

test('edge github: HTTP の状態ごとのエラーの種類（403 の上限・500・429）', async () => {
  const cases = [
    [401, {}, 'auth'],
    [403, { 'x-ratelimit-remaining': '0' }, 'ratelimit'],
    [403, {}, 'forbidden'],
    [404, {}, 'notfound'],
    [409, {}, 'conflict'],
    [422, {}, 'conflict'],
    [500, {}, 'http'],
    [429, {}, 'http'],
  ];
  for (const [status, headers, kind] of cases) {
    const { fetchImpl } = stubFetch(() => new Response('{}', { status, headers }));
    await assert.rejects(fetchRecords('', { fetchImpl }), (e) => e.kind === kind && (e.status === status) && e.message === recordsErrorMessage({ kind }), `${status}`);
  }
});

test('edge github: トークンは Authorization だけに入り、URL・エラーに出ない。未認証なら Authorization を付けない', async () => {
  const token = 'ghp_SECRET123';
  const { calls, fetchImpl } = stubFetch(() => new Response('{}', { status: 500 }));
  await assert.rejects(fetchRecords(token, { fetchImpl }), (e) => !e.message.includes(token) && !String(e.stack).includes(token));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.ok(!calls[0].url.includes(token));
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].url.endsWith(`?ref=${BRANCH}`));
  const anon = stubFetch(() => new Response(contentBody({ records: {} }), { status: 200 }));
  await fetchRecords('', { fetchImpl: anon.fetchImpl });
  assert.equal('Authorization' in anon.calls[0].init.headers, false);
});

test('edge github: 未認証でファイルが無ければ notfound、トークンありなら空の記録', async () => {
  const nf = () => new Response('{}', { status: 404 });
  await assert.rejects(fetchRecords('', { fetchImpl: stubFetch(nf).fetchImpl }), (e) => e.kind === 'notfound');
  assert.deepEqual(await fetchRecords('t', { fetchImpl: stubFetch(nf).fetchImpl }), { version: 1, records: {}, excluded: {} });
});

test('edge github: saveChange はトークンが無ければ通信せず auth、不正な変更は保存しない', async () => {
  const { calls, fetchImpl } = stubFetch(() => new Response(contentBody({ records: {} }), { status: 200 }));
  await assert.rejects(saveChange('', { type: 'remove', book_id: 'a' }, { fetchImpl }), (e) => e.kind === 'auth');
  assert.equal(calls.length, 0);
  await assert.rejects(saveChange('t', { type: 'read', book_id: 'a', title: 't', read_on: 'bad' }, { fetchImpl }), /読んだ日/);
  assert.ok(calls.every((c) => c.init.method !== 'PUT'), 'PUT しない');
});

test('edge github: saveChange は未知のキーを残し、ファイルが無いときは sha 無しで作る', async () => {
  let putBody;
  const remote = { version: 1, records: { keep: { title: 'k', read_on: '2026-01-01' } }, future: { x: 1 } };
  const { fetchImpl } = stubFetch((url, init) => {
    if (init.method === 'PUT') {
      putBody = JSON.parse(init.body);
      return new Response('{"content":{}}', { status: 200 });
    }
    return new Response(contentBody(remote, 'abc'), { status: 200 });
  });
  const result = await saveChange('t', { type: 'read', book_id: 'n', title: '新', read_on: '2026-10-04' }, { fetchImpl, now: () => T1 });
  const written = JSON.parse(decodeBase64Utf8(putBody.content));
  assert.deepEqual(written.future, { x: 1 });
  assert.deepEqual(written.records.keep, remote.records.keep);
  assert.equal(putBody.sha, 'abc');
  assert.equal(putBody.branch, BRANCH);
  assert.equal(result.records.n.updated_at, T1);

  let put2;
  const missing = stubFetch((url, init) => {
    if (init.method === 'PUT') {
      put2 = JSON.parse(init.body);
      return new Response('{}', { status: 201 });
    }
    return new Response('{}', { status: 404 });
  });
  await saveChange('t', { type: 'exclude', book_id: 'x' }, { fetchImpl: missing.fetchImpl, now: () => T1 });
  assert.equal('sha' in put2, false);
  assert.deepEqual(JSON.parse(decodeBase64Utf8(put2.content)).excluded, { x: T1 });
});

test('edge github: 競合したら取り直して 1 回だけ再送（2 回目は最新の sha と内容で）。競合以外は再送しない', async () => {
  let gets = 0;
  const puts = [];
  const { fetchImpl } = stubFetch((url, init) => {
    if (init.method === 'PUT') {
      puts.push(JSON.parse(init.body));
      return puts.length === 1 ? new Response('{}', { status: 409 }) : new Response('{}', { status: 200 });
    }
    gets += 1;
    const remote = gets === 1 ? { records: {} } : { records: { other: { title: 'o', read_on: '2026-01-01' } } };
    return new Response(contentBody(remote, `sha${gets}`), { status: 200 });
  });
  const result = await saveChange('t', { type: 'read', book_id: 'mine', title: 'm', read_on: '2026-10-04' }, { fetchImpl });
  assert.equal(puts.length, 2);
  assert.equal(puts[1].sha, 'sha2');
  assert.deepEqual(Object.keys(result.records).sort(), ['mine', 'other']);

  let n = 0;
  const err = stubFetch((url, init) => {
    if (init.method === 'PUT') {
      n += 1;
      return new Response('{}', { status: 500 });
    }
    return new Response(contentBody({ records: {} }), { status: 200 });
  });
  await assert.rejects(saveChange('t', { type: 'remove', book_id: 'a' }, { fetchImpl: err.fetchImpl }), (e) => e.kind === 'http');
  assert.equal(n, 1);
});

test('edge github: 通信が途中で落ちても network、取り直しの GET が落ちても伝わる', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) return new Response(contentBody({ records: {} }), { status: 200 });
    if (calls === 2) return new Response('{}', { status: 422 });
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(saveChange('t', { type: 'remove', book_id: 'a' }, { fetchImpl }), (e) => e.kind === 'network');
});

test('edge github: recordsErrorMessage は未知・空でも既定の文を返す', () => {
  assert.match(recordsErrorMessage(null), /失敗/);
  assert.match(recordsErrorMessage({}), /失敗/);
  assert.match(recordsErrorMessage(new Error('x')), /失敗/);
});

// ================= thoughts.js =================

test('edge thoughts: isThoughtId の境界', () => {
  assert.ok(isThoughtId('t1'));
  assert.ok(isThoughtId('t' + 'a'.repeat(40)));
  assert.ok(!isThoughtId('t' + 'a'.repeat(41)));
  assert.ok(!isThoughtId('t'));
  assert.ok(!isThoughtId('T1'));
  assert.ok(!isThoughtId('h123'));
  assert.ok(!isThoughtId('t-1'));
  assert.ok(!isThoughtId(null));
  assert.ok(!isThoughtId(123));
});

test('edge thoughts: addThought は空・長すぎ・不正 ID を拒み、ライブラリを変えない', () => {
  const lib = emptyLibrary();
  assert.throws(() => addThought(lib, { text: '' }, T1, 't1'));
  assert.throws(() => addThought(lib, { text: ' \n\t ' }, T1, 't1'));
  assert.throws(() => addThought(lib, {}, T1, 't1'));
  assert.throws(() => addThought(lib, undefined, T1, 't1'));
  assert.throws(() => addThought(lib, { text: 'x'.repeat(THOUGHT_MAX_LENGTH + 1) }, T1, 't1'));
  assert.throws(() => addThought(lib, { text: 'x' }, T1, 'bad id'));
  assert.deepEqual(lib.thoughts, {});
  assert.equal(lib.updatedAt, null);
  const t = addThought(lib, { text: 'x'.repeat(THOUGHT_MAX_LENGTH) }, T1, 't1');
  assert.equal(t.text.length, THOUGHT_MAX_LENGTH);
});

test('edge thoughts: 古い版のライブラリ（thoughts 無し）でも書ける・数えられる', () => {
  const lib = { version: 1, books: {}, highlights: {} };
  assert.deepEqual(thoughtCounts(lib), { inbox: 0, done: 0, discarded: 0 });
  assert.deepEqual(inboxThoughts(lib), []);
  addThought(lib, { text: 'a' }, T1, 'ta');
  assert.equal(thoughtCounts(lib).inbox, 1);
  assert.deepEqual(thoughtCounts(null), { inbox: 0, done: 0, discarded: 0 });
});

test('edge thoughts: answerTo は形が違えば持たず、長い問いは切る', () => {
  const lib = emptyLibrary();
  const a = addThought(lib, { text: 'x', answerTo: { kind: 'bogus', question: 'q' } }, T1, 'ta');
  assert.equal('answerTo' in a, false);
  const b = addThought(lib, { text: 'x', answerTo: { kind: 'solid', question: '  \n ' } }, T1, 'tb');
  assert.equal('answerTo' in b, false);
  const c = addThought(lib, { text: 'x', answerTo: { kind: 'line', question: 'あ'.repeat(400), id: 'z'.repeat(100) } }, T1, 'tc');
  assert.equal(Array.from(c.answerTo.question).length, 300);
  assert.equal(c.answerTo.id.length, 40);
  const d = addThought(lib, { text: 'x', answerTo: 'string' }, T1, 'td');
  assert.equal('answerTo' in d, false);
});

test('edge thoughts: updateThought は変化が無ければ時刻を進めず、消したもの・無いもの・継承した名前は見つからない', () => {
  const lib = emptyLibrary();
  addThought(lib, { text: '本文' }, T1, 'ta');
  const same = updateThought(lib, 'ta', { text: '  本文  ', status: 'inbox' }, T2);
  assert.equal(same.updatedAt, T1);
  assert.equal(lib.updatedAt, T1);
  assert.throws(() => updateThought(lib, 'ta', { status: 'bogus' }, T2));
  assert.throws(() => updateThought(lib, 'ta', { text: '' }, T2));
  assert.throws(() => updateThought(lib, 'nope', { text: 'x' }, T2));
  assert.throws(() => updateThought(lib, 'toString', { text: 'x' }, T2));
  assert.throws(() => updateThought(lib, '__proto__', { text: 'x' }, T2));
  const st = updateThought(lib, 'ta', { status: 'done' }, T2);
  assert.equal(st.statusAt, T2);
  const tx = updateThought(lib, 'ta', { text: '直した' }, T3);
  assert.equal(tx.statusAt, T2, '本文だけの変更では状態の時刻を進めない');
  deleteThought(lib, 'ta', T3);
  assert.throws(() => updateThought(lib, 'ta', { text: 'x' }, T3));
});

test('edge thoughts: deleteThought は無い ID で null、墓標は本文を残さず createdAt を保つ', () => {
  const lib = emptyLibrary();
  assert.equal(deleteThought(lib, 'nope', T1), null);
  assert.equal(deleteThought(lib, 'constructor', T1), null);
  addThought(lib, { text: 'secret' }, T1, 'ta');
  const tomb = deleteThought(lib, 'ta', T2);
  assert.deepEqual(tomb, { id: 'ta', deleted: true, createdAt: T1, updatedAt: T2 });
  assert.equal(JSON.stringify(lib.thoughts).includes('secret'), false);
  assert.deepEqual(pointThoughts(lib), []);
});

test('edge thoughts: normalizeThought は壊れた値を捨て、状態の時刻を createdAt で補う', () => {
  assert.equal(normalizeThought({ id: 'bad', text: 'x' }), null);
  assert.equal(normalizeThought({ id: 't1', text: 5 }), null);
  assert.equal(normalizeThought({ id: 't1', text: '   ' }), null);
  assert.deepEqual(normalizeThought({ id: 't1', deleted: true, text: 'leak', createdAt: 5 }), { id: 't1', deleted: true, createdAt: '', updatedAt: '' });
  const n = normalizeThought({ id: 't1', text: ' x ', status: 'weird', createdAt: T1, extra: 'drop' });
  assert.deepEqual(n, { id: 't1', text: 'x', status: 'inbox', statusAt: T1, createdAt: T1, updatedAt: '' });
  assert.deepEqual(normalizeThought(n), n, '冪等');
  assert.equal(normalizeThought({ id: 't1', text: 'y'.repeat(THOUGHT_MAX_LENGTH + 10) }).text.length, THOUGHT_MAX_LENGTH);
});

test('edge thoughts: mergeThought は向きに依らず、本文と状態を別々に新しい方から採る', () => {
  const a = { id: 't1', text: 'PC', status: 'discarded', statusAt: T2, createdAt: T1, updatedAt: T1 };
  const b = { id: 't1', text: 'スマホ', status: 'inbox', statusAt: T1, createdAt: T1, updatedAt: T3 };
  const ab = mergeThought(a, b);
  assert.deepEqual(ab, mergeThought(b, a));
  assert.equal(ab.text, 'スマホ');
  assert.equal(ab.status, 'discarded');
  assert.equal(ab.statusAt, T2);
  // statusAt が無い古いデータ
  const c = { id: 't1', text: 'c', status: 'done', createdAt: T2, updatedAt: T2 };
  const d = { id: 't1', text: 'd', status: 'inbox', createdAt: T1, updatedAt: T1 };
  assert.deepEqual(mergeThought(c, d), mergeThought(d, c));
  assert.equal(mergeThought(c, d).status, 'done');
  // 同時刻・違う内容
  const e = { ...a, text: 'e', updatedAt: T2, statusAt: T2, status: 'done' };
  const f = { ...a, text: 'f', updatedAt: T2, statusAt: T2, status: 'inbox' };
  assert.deepEqual(mergeThought(e, f), mergeThought(f, e));
});

test('edge thoughts: searchThoughts は空白・全角・問いでも当たり、捨てたものは status 指定時だけ', () => {
  const lib = emptyLibrary();
  addThought(lib, { text: 'Habit loop', answerTo: { kind: 'ask', question: '習慣とは何か' } }, T1, 'ta');
  addThought(lib, { text: '捨てる案' }, T2, 'tb');
  updateThought(lib, 'tb', { status: 'discarded' }, T3);
  assert.equal(searchThoughts(lib, 'ＨＡＢＩＴ').length, 1);
  assert.equal(searchThoughts(lib, '習慣').length, 1);
  assert.equal(searchThoughts(lib, '思いつき').length, 1, 'ラベルでも当たる');
  assert.equal(searchThoughts(lib, '捨てる').length, 0);
  assert.equal(searchThoughts(lib, '捨てる', { status: 'discarded' }).length, 1);
  assert.equal(searchThoughts(lib, '   ').length, 1);
  assert.equal(searchThoughts(lib).length, 1);
});

test('edge thoughts: inboxThoughts は新しい順、同時刻なら ID 順で安定', () => {
  const lib = emptyLibrary();
  addThought(lib, { text: 'b' }, T1, 'tb');
  addThought(lib, { text: 'a' }, T1, 'ta');
  addThought(lib, { text: 'c' }, T2, 'tc');
  assert.deepEqual(inboxThoughts(lib).map((t) => t.id), ['tc', 'ta', 'tb']);
});

test('edge thoughts: 同期で消したものは戻らない（向きに依らない）', () => {
  const a = emptyLibrary();
  addThought(a, { text: 'x' }, T1, 'ta');
  const b = structuredClone(a);
  deleteThought(a, 'ta', T2);
  updateThought(b, 'ta', { text: '直した' }, T3);
  assert.equal(mergeLibraries(a, b).thoughts.ta.deleted, true);
  assert.equal(mergeLibraries(b, a).thoughts.ta.deleted, true);
});

// ================= sample.js =================

test('edge sample: サンプルの本は形が正しく、日付・位置・本文が一意で有効', () => {
  assert.ok(SAMPLE_BOOKS.length >= 4);
  const titles = new Set();
  for (const b of SAMPLE_BOOKS) {
    assert.ok(b.title && b.author && ['kindle', 'playbooks'].includes(b.source));
    assert.ok(!titles.has(b.title));
    titles.add(b.title);
    const texts = new Set();
    let prev = -Infinity;
    for (const h of b.highlights) {
      assert.ok(!Number.isNaN(Date.parse(h.createdAt)), h.createdAt);
      assert.ok(h.createdAt < '2026-01-01', '未来の日付にしない');
      assert.ok(!texts.has(h.text));
      texts.add(h.text);
      if (b.source === 'kindle') {
        assert.ok(h.location > prev && h.locationEnd > h.location);
        prev = h.location;
      } else {
        assert.equal(typeof h.page, 'string');
      }
    }
  }
  // 取り込むとすべて点になる（包含で消えない）
  const lib = libWith(SAMPLE_BOOKS);
  const total = SAMPLE_BOOKS.reduce((n, b) => n + b.highlights.length, 0);
  assert.equal(libraryStats(lib).highlights, total);
  assert.equal(libraryStats(lib).technical, 0);
});

// ================= discovery-reads.js =================

test('edge discovery-reads: 壊れた分析・既読でも落ちない', () => {
  assert.deepEqual(discoveriesOf(null), []);
  assert.deepEqual(discoveriesOf({ discoveries: 'x' }), []);
  assert.deepEqual(discoveriesOf({ discoveries: [null, { id: 'd1', pointIds: ['a'] }, { id: 'd2', pointIds: ['a', 'b'] }] }).map((d) => d.id), ['d2']);
  assert.deepEqual(readsOf(null), {});
  assert.deepEqual(readsOf({ discoveryReads: [] }), {});
  assert.deepEqual(readsOf({ discoveryReads: 'x' }), {});
  assert.equal(isRead({ discoveryReads: {} }, 'toString'), false, '継承した名前を既読と取り違えない');
  assert.equal(isRead(undefined, 'd1'), false);
});

test('edge discovery-reads: markDiscoveryRead は不正な ID・既読で何もしない', () => {
  const lib = emptyLibrary();
  assert.equal(markDiscoveryRead(lib, 'x1', T1), false);
  assert.equal(markDiscoveryRead(lib, null, T1), false);
  assert.equal(markDiscoveryRead(lib, 'D1', T1), false);
  assert.equal(lib.updatedAt, null);
  assert.equal(markDiscoveryRead(lib, 'd1', T2), true);
  assert.equal(markDiscoveryRead(lib, 'd1', T3), false);
  assert.equal(lib.discoveryReads.d1, T2);
  // 壊れた既読（配列）は作り直す
  const broken = { discoveryReads: ['d1'] };
  assert.equal(markDiscoveryRead(broken, 'd1', T1), true);
  assert.deepEqual(broken.discoveryReads, { d1: T1 });
});

test('edge discovery-reads: mergeReads は向きに依らず、早い時刻を採り、壊れた値を捨て、引数を変えない', () => {
  const a = { d1: T2, d2: T1, bad: T1, d3: '', d4: 5 };
  const b = { d1: T1, d5: T3 };
  const sa = structuredClone(a);
  const ab = mergeReads(a, b);
  assert.deepEqual(ab, mergeReads(b, a));
  assert.deepEqual(ab, { d1: T1, d2: T1, d5: T3 });
  assert.deepEqual(a, sa);
  assert.deepEqual(mergeReads(null, undefined), {});
  assert.deepEqual(mergeReads(['d1'], 'x'), {});
  assert.deepEqual(mergeReads(ab, ab), ab);
  const proto = mergeReads(JSON.parse('{"__proto__": "2026-01-01", "d9": "2026-01-02"}'), {});
  assert.deepEqual(Object.keys(proto), ['d9']);
});

test('edge discovery-reads: unreadDiscoveries は分析の順のまま既読を除く', () => {
  const analysis = { discoveries: [{ id: 'd2', pointIds: ['a', 'b'] }, { id: 'd1', pointIds: ['c', 'd'] }, { id: 'd3', pointIds: ['e', 'f'] }] };
  const lib = { discoveryReads: { d1: T1 } };
  assert.deepEqual(unreadDiscoveries(analysis, lib).map((d) => d.id), ['d2', 'd3']);
  assert.deepEqual(unreadDiscoveries(null, lib), []);
});

// ================= auto-analysis.js =================

const pts = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i}` }));
const NOW = new Date('2026-10-04T12:00:00.000Z');

test('edge auto: pendingPoints は壊れた分析を無いものとして数え、文字列でない ID を無視する', () => {
  assert.equal(pendingPoints(pts(3), null), 3);
  assert.equal(pendingPoints(pts(3), {}), 3);
  assert.equal(pendingPoints(pts(3), { lines: 'x' }), 3);
  assert.equal(pendingPoints(pts(3), { lines: [null, { highlightIds: 'h0' }, { highlightIds: ['h1', 5] }], isolated: [null, 'h2'] }), 1);
  assert.equal(pendingPoints([], { lines: [] }), 0);
});

test('edge auto: autoConfig は壊れた値・文字列・0・負数・Infinity を既定へ戻す', () => {
  assert.deepEqual(autoConfig(), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig(null), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig({ minPoints: null, maxHours: '' }), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig({ minPoints: true, maxHours: false }), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig({ minPoints: 0, maxHours: -1 }), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig({ minPoints: Infinity, maxHours: NaN }), AUTO_DEFAULTS);
  assert.deepEqual(autoConfig({ minPoints: ' 5 ', maxHours: '0.5' }), { enabled: true, minPoints: 5, maxHours: 0.5 });
  for (const off of [false, 0, 'false', 'off', '0']) assert.equal(autoConfig({ enabled: off }).enabled, false, String(off));
  for (const on of [true, 1, 'true', 'on', undefined, null]) assert.equal(autoConfig({ enabled: on }).enabled, true, String(on));
});

test('edge auto: autoAnalyzeDue の境界（点の数・ちょうど minPoints・ちょうど maxHours・未来の時刻・不正な時刻）', () => {
  const analysis = (createdAt, seen = 0) => ({ createdAt, lines: [{ highlightIds: pts(seen).map((p) => p.id) }], isolated: [] });
  assert.equal(autoAnalyzeDue({ points: pts(3), analysis: null, now: NOW }).due, false, '4 件未満');
  assert.equal(autoAnalyzeDue({ points: pts(4), analysis: null, now: NOW }).due, true, '前回が無ければすぐ');
  // ちょうど minPoints 件増えた
  assert.equal(autoAnalyzeDue({ points: pts(20), analysis: analysis(NOW.toISOString(), 10), now: NOW }).due, true);
  assert.equal(autoAnalyzeDue({ points: pts(19), analysis: analysis(NOW.toISOString(), 10), now: NOW }).due, false);
  // ちょうど maxHours たった
  const day = new Date(NOW - 24 * 3600_000).toISOString();
  assert.equal(autoAnalyzeDue({ points: pts(11), analysis: analysis(day, 10), now: NOW }).due, true);
  const almost = new Date(NOW - 24 * 3600_000 + 1).toISOString();
  assert.equal(autoAnalyzeDue({ points: pts(11), analysis: analysis(almost, 10), now: NOW }).due, false);
  // 未来の createdAt・壊れた createdAt は待たない
  assert.equal(autoAnalyzeDue({ points: pts(11), analysis: analysis('2099-01-01T00:00:00Z', 10), now: NOW }).due, true);
  const broken = autoAnalyzeDue({ points: pts(11), analysis: analysis('garbage', 10), now: NOW });
  assert.equal(broken.due, true);
  assert.match(broken.reason, /–/);
  // 増えていなければ時間がたっても分析しない
  assert.equal(autoAnalyzeDue({ points: pts(10), analysis: analysis(day, 10), now: NOW }).due, false);
});

test('edge auto: 失敗・中止のあとは AUTO_RETRY_MS 待つ（ちょうどで再開、未来の時刻は待たない）', () => {
  const base = { points: pts(10), analysis: null, now: NOW };
  const ago = (ms) => new Date(NOW - ms).toISOString();
  assert.equal(autoAnalyzeDue({ ...base, lastFailureAt: ago(AUTO_RETRY_MS - 1) }).due, false);
  assert.equal(autoAnalyzeDue({ ...base, lastFailureAt: ago(AUTO_RETRY_MS) }).due, true);
  assert.equal(autoAnalyzeDue({ ...base, lastCancelledAt: ago(1000) }).due, false);
  assert.equal(autoAnalyzeDue({ ...base, lastCancelledAt: '2099-01-01T00:00:00Z' }).due, true);
  assert.equal(autoAnalyzeDue({ ...base, lastFailureAt: 'garbage' }).due, true);
  assert.equal(autoAnalyzeDue({ ...base, config: { enabled: 'off' } }).due, false);
});

// ================= 追加: 並行・順序 =================

function statefulGitHub(initial = { version: 1, records: {} }) {
  const state = { file: initial, sha: 1, puts: 0 };
  const fetchImpl = async (url, init = {}) => {
    await new Promise((r) => setImmediate(r));
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      if (String(body.sha) !== `s${state.sha}`) return new Response('{}', { status: 409 });
      state.file = JSON.parse(decodeBase64Utf8(body.content));
      state.sha += 1;
      state.puts += 1;
      return new Response('{}', { status: 200 });
    }
    return new Response(contentBody(state.file, `s${state.sha}`), { status: 200 });
  };
  return { state, fetchImpl };
}

test('edge github: 2 つの保存が同時に走っても、競合の再送で両方の変更が残る', async () => {
  const gh = statefulGitHub();
  const opts = { fetchImpl: gh.fetchImpl, now: () => T1 };
  await Promise.all([
    saveChange('t', { type: 'read', book_id: 'a', title: 'A', read_on: '2026-10-01' }, opts),
    saveChange('t', { type: 'read', book_id: 'b', title: 'B', read_on: '2026-10-02' }, opts),
  ]);
  assert.deepEqual(Object.keys(gh.state.file.records).sort(), ['a', 'b']);
  assert.equal(gh.state.puts, 2);
});

test('edge model: 伸ばしたハイライトと古い点への未同期の編集は、どちら向きに統合しても同じで編集が引き継がれる', () => {
  const a = libWith([kindle('本', [{ text: '短い', location: 10 }])], T1);
  const b = structuredClone(a);
  const id = bookIdFor('本');
  const shortId = highlightIdFor(id, '短い');
  const longId = highlightIdFor(id, '短いを伸ばした');
  mergeParsed(a, [kindle('本', [{ text: '短いを伸ばした', location: 10 }])], { now: T2 });
  updateHighlight(b, shortId, { favorite: true, userNote: 'スマホで' }, T3);
  const ab = mergeLibraries(a, b);
  assert.deepEqual(ab, mergeLibraries(b, a));
  assert.equal(ab.highlights[shortId].deleted, true);
  assert.equal(ab.highlights[longId].favorite, true);
  assert.equal(ab.highlights[longId].userNote, 'スマホで');
  assert.deepEqual(bookHighlights(ab, id).map((h) => h.id), [longId]);
  assert.deepEqual(mergeLibraries(ab, b), ab, '同じ端末ともう一度統合しても変わらない');
});

test('edge model: 読書メモは既にある線に含まれる文を増やさず、短い書名は 1 冊だけ含むときに合わせる', () => {
  const lib = libWith([kindle('新版 ハマトンの知的生活', [{ text: '知的生活とは、自分の時間を自分の目的のために使うことである。' }])]);
  const stats = mergeParsed(lib, [{ title: 'ハマトン', author: '', source: 'memo', highlights: [{ text: '自分の時間を自分の目的のために使う' }, { text: '新しいメモの文' }] }], { now: T2 });
  assert.deepEqual(stats.memoTitles, [{ from: 'ハマトン', to: '新版 ハマトンの知的生活' }]);
  assert.equal(stats.added, 1);
  assert.equal(stats.unchanged, 1);
  // 候補が 2 冊なら合わせない
  mergeParsed(lib, [kindle('ハマトンの別の本', [{ text: 'x' }])], { now: T2 });
  const s2 = mergeParsed(lib, [{ title: 'ハマトン', author: '', source: 'memo', highlights: [{ text: 'y' }] }], { now: T3 });
  assert.deepEqual(s2.memoTitles, []);
  assert.ok(lib.books[bookIdFor('ハマトン')]);
});

test('edge model: ゼロ幅文字・BOM・CRLF の違いは同じ点になる', () => {
  const lib = libWith([play('本', [{ text: '﻿同じ​文\r\n二行目' }, { text: '同じ文\n二行目' }])]);
  assert.equal(Object.keys(lib.highlights).length, 1);
  assert.equal(Object.values(lib.highlights)[0].text, '同じ文\n二行目');
});

test('edge model: mergeLibraries は継承した名前（toString・constructor・__proto__）の ID を取り違えず、継承元を書き換えない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  const item = { id: 'x', title: 't', sources: ['kindle'], updatedAt: T2 };
  const incoming = JSON.parse(JSON.stringify({ books: { toString: item, constructor: item }, highlights: { toString: { id: 'toString', bookId: 'b', text: 't', updatedAt: T2 } }, feedback: { toString: { key: 'toString', status: 'read', updatedAt: T2 } } }));
  const proto = JSON.parse(`{"books":{"__proto__":${JSON.stringify(item)}},"highlights":{"__proto__":{"text":"x"}},"feedback":{"__proto__":{"status":"read"}}}`);
  const m = mergeLibraries(lib, incoming);
  assert.equal(m.books.toString.title, 't');
  assert.equal(m.books.constructor.title, 't');
  assert.equal(m.highlights.toString.text, 't');
  assert.equal(m.feedback.toString.status, 'read');
  const p = mergeLibraries(lib, proto);
  for (const kind of ['books', 'highlights', 'feedback']) assert.equal(Object.getPrototypeOf(p[kind]), Object.prototype, kind);
  assert.equal(p.books.title, undefined);
  assert.equal({}.title, undefined);
});

test('edge model: dailyPicks は負の件数で何も返さない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }, { text: 'b' }, { text: 'c' }])]);
  assert.equal(dailyPicks(lib, -1).length, 0);
});

test('edge model: mergeLibraries は取り込む側の null の本・点を無視して落ちない', () => {
  const lib = libWith([kindle('本', [{ text: 'a' }])]);
  const merged = mergeLibraries(lib, { books: { x: null }, highlights: { y: null } });
  assert.equal(Object.hasOwn(merged.books, 'x'), false);
  assert.equal(Object.hasOwn(merged.highlights, 'y'), false);
  assert.equal(Object.keys(merged.books).length, Object.keys(lib.books).length);
});

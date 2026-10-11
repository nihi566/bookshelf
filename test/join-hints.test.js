// NIH-140 本の画面で、文の途中で切れていそうな点に「次の点とくっつける?」の印を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinCandidateIds } from '../web/core/join-hints.js';

const hl = (id, text, extra = {}) => ({ id, bookId: 'b', text, ...extra });
const ids = (list) => [...joinCandidateIds(list)].sort();

test('文の終わりの記号で終わらず、次の点と位置が続く点だけを候補にする', () => {
  const list = [
    hl('a', 'ハイエクやフロム的に見ると、現代の私たちに求められるのは：', { location: 100, locationEnd: 101 }),
    hl('b', '自由から逃げずに、自分で考えることだ。', { location: 102, locationEnd: 103 }),
    hl('c', '別の場所の線', { location: 500, locationEnd: 501 }),
  ];
  assert.deepEqual(ids(list), ['a']);
});

test('文の終わりの記号（日本語・英語・閉じかっこ・末尾の空白）で終わる点は候補にしない', () => {
  for (const end of ['。', '．', '.', '！', '!', '？', '?', '」', '』', '）', ')', '"', '”', '’', '…', '。 ', '。\n']) {
    const list = [hl('a', `文${end}`, { location: 1, locationEnd: 1 }), hl('b', '次の文', { location: 2 })];
    assert.deepEqual(ids(list), [], JSON.stringify(end));
  }
});

test('位置が離れている点は候補にしない（終わりの次の位置までを続いているとみなす）', () => {
  assert.deepEqual(ids([hl('a', '途中', { location: 10, locationEnd: 12 }), hl('b', '次', { location: 13 })]), ['a']);
  assert.deepEqual(ids([hl('a', '途中', { location: 10, locationEnd: 12 }), hl('b', '次', { location: 14 })]), []);
  assert.deepEqual(ids([hl('a', '途中', { location: 10, locationEnd: 12 }), hl('b', '重なる', { location: 11 })]), ['a'], '重なっていても続いている');
});

test('同期で届いた文字列の位置も数として読み、始まりより前の終わりの位置は始まりとみなす', () => {
  assert.deepEqual(ids([hl('a', '途中', { location: '100', locationEnd: '101' }), hl('b', '次', { location: '102' })]), ['a']);
  assert.deepEqual(ids([hl('a', '途中', { location: 'x' }), hl('b', '次', { location: 2 })]), [], '数でない位置は位置なし（ページも無い）');
  assert.deepEqual(ids([hl('a', '途中', { location: 100, locationEnd: 0 }), hl('b', '次', { location: 101 })]), ['a']);
  assert.deepEqual(ids([hl('a', '途中', { location: null, page: '3' }), hl('b', '次', { location: 0, page: '3' })]), ['a'], 'null の位置は 0 と読まない');
  assert.deepEqual(ids([hl('a', '《書名》', { location: 1 }), hl('b', '次', { location: 2 })]), [], '閉じかっこで終わる点');
  assert.deepEqual(ids([null, hl('a', '途中', { location: 1 }), hl('b', '次', { location: 2 })]), ['a']);
});

test('終わりの位置が無い点は、文の長さから終わりを見積もる', () => {
  const short = hl('a', '短い途中', { location: 10 });
  assert.deepEqual(ids([short, hl('b', '次', { location: 11 })]), ['a']);
  assert.deepEqual(ids([short, hl('b', '次', { location: 20 })]), []);
  const long = hl('a', 'あ'.repeat(300), { location: 10 });
  assert.deepEqual(ids([long, hl('b', '次', { location: 18 })]), ['a'], '長い点は終わりが先にある');
});

test('位置が無い点は、ページが同じなら候補にする', () => {
  assert.deepEqual(ids([hl('a', '途中', { page: '12' }), hl('b', '次', { page: '12' })]), ['a']);
  assert.deepEqual(ids([hl('a', '途中', { page: '12' }), hl('b', '次', { page: '13' })]), []);
  assert.deepEqual(ids([hl('a', '途中'), hl('b', '次')]), [], '位置もページも無ければ続いているか分からない');
  assert.deepEqual(ids([hl('a', '途中', { page: '12' }), hl('b', '次', { location: 5 })]), [], '片方だけ位置があるならページで比べる');
});

test('章が違う点・最後の点・単独のメモ・文の無い点は候補にしない', () => {
  assert.deepEqual(ids([hl('a', '途中', { location: 1, chapter: '1 章' }), hl('b', '次', { location: 2, chapter: '2 章' })]), []);
  assert.deepEqual(ids([hl('a', '途中', { location: 1, chapter: '1 章' }), hl('b', '次', { location: 2 })]), ['a'], '片方に章が無いだけなら比べない');
  assert.deepEqual(ids([hl('a', '最後の点', { location: 1 })]), []);
  assert.deepEqual(ids([hl('a', 'メモ', { location: 1, kind: 'note' }), hl('b', '次', { location: 2 })]), []);
  assert.deepEqual(ids([hl('a', '途中', { location: 1 }), hl('b', 'メモ', { location: 2, kind: 'note' })]), []);
  assert.deepEqual(ids([hl('a', '', { location: 1 }), hl('b', '次', { location: 2 })]), []);
  assert.deepEqual(ids([hl('a', null, { location: 1 }), hl('b', '次', { location: 2 })]), [], '文字列でない文でも落ちない');
});

test('並びは渡した順のまま使う（本の画面と同じ並びで「次の点」を決める）', () => {
  const a = hl('a', '途中', { location: 2 });
  const b = hl('b', '次', { location: 1 });
  assert.deepEqual(ids([a, b]), ['a']);
  assert.deepEqual(ids([b, a]), ['b'], '並べ替えずに、渡した並びで次の点を見る');
  assert.deepEqual(ids([]), []);
});

test('本の画面: 候補の点のカードにだけ「次の点とくっつける?」を出し、押すと編集シート（data-action="edit"）を開く', async () => {
  const { bookIdFor, emptyLibrary, highlightIdFor, mergeParsed } = await import('../web/core/model.js');
  const { book } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, [{
    title: '本',
    source: 'kindle',
    highlights: [
      { text: '求められるのは：', location: 100, locationEnd: 101 },
      { text: '自分で考えることだ。', location: 102, locationEnd: 103 },
      { text: '離れた場所で切れた文', location: 500, locationEnd: 501 },
      { text: '最後の点', location: 900, locationEnd: 901 },
    ],
  }], { now: '2025-01-01T00:00:00.000Z' });
  const id = (t) => highlightIdFor(bookIdFor('本'), t);
  const state = { library: lib, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null };
  const out = String(book.render({ state, params: { id: bookIdFor('本') } }));
  const hints = [...out.matchAll(/<button type="button" class="badge join-hint" data-action="edit" data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hints, [id('求められるのは：')]);
  assert.match(out, />次の点とくっつける\?<\/button>/);
});

// NIH-164 読んだ本の一覧に、本ごとの「くっつける候補」の件数を出す
async function twoBooks() {
  const { bookIdFor, emptyLibrary, mergeParsed } = await import('../web/core/model.js');
  const lib = emptyLibrary();
  mergeParsed(lib, [
    {
      title: '切れた本',
      source: 'kindle',
      highlights: [
        { text: '求められるのは：', location: 100, locationEnd: 101 },
        { text: '自分で考えることだ。', location: 102, locationEnd: 103 },
        { text: '小さく始めるほど', location: 200, locationEnd: 201 },
        { text: '続きやすい。', location: 202, locationEnd: 203 },
        { text: '離れた場所の線', location: 900, locationEnd: 901 },
      ],
    },
    { title: '整った本', source: 'kindle', highlights: [{ text: '書くことは考えることである。', location: 1 }, { text: '問いを持って読む。', location: 2 }] },
  ], { now: '2025-01-01T00:00:00.000Z' });
  const state = { library: lib, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null };
  return { lib, state, cut: bookIdFor('切れた本'), whole: bookIdFor('整った本') };
}

test('本ごとの候補の件数は、本の画面の印の数と同じ（同じ関数・同じ並びで数える）', async () => {
  const { bookHighlights, bookJoinCandidateCounts } = await import('../web/core/model.js');
  const { lib, cut, whole } = await twoBooks();
  const counts = bookJoinCandidateCounts(lib);
  assert.equal(counts.get(cut), 2);
  assert.equal(counts.get(cut), joinCandidateIds(bookHighlights(lib, cut)).size);
  assert.equal(counts.has(whole), false, '候補の無い本は入れない');
});

test('読んだ本の一覧: 候補が 1 件以上ある本の行にだけ「くっつける候補 N」を出し、件数は本の画面の印の数と一致する', async () => {
  const { books, book } = await import('../web/js/views/library.js');
  const { state, cut } = await twoBooks();
  const out = String(books.render({ state, query: new URLSearchParams() }));
  const rows = out.split('<li>').slice(1);
  const cutRow = rows.find((r) => r.includes('切れた本'));
  const wholeRow = rows.find((r) => r.includes('整った本'));
  const marks = [...String(book.render({ state, params: { id: cut } })).matchAll(/class="badge join-hint"/g)].length;
  assert.equal(marks, 2);
  assert.match(cutRow, new RegExp(`くっつける候補 ${marks}<`));
  assert.doesNotMatch(wholeRow, /くっつける候補/);
});

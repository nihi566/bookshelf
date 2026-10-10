// NIH-109 本の中で、2 つに分かれてしまった前後の点をくっつける
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bookHighlights,
  bookIdFor,
  emptyLibrary,
  highlightIdFor,
  highlightNeighbors,
  joinHighlights,
  liveHighlights,
  mergeLibraries,
  mergeParsed,
  unjoinHighlights,
  updateHighlight,
} from '../web/core/model.js';
import { addLink, linksFor } from '../web/core/links.js';
import { addNote } from '../web/core/notes.js';
import { missingEvidence } from '../web/core/note-evidence.js';
import { currentPointId } from '../web/core/point-ids.js';

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-02-01T00:00:00.000Z';
const T3 = '2025-03-01T00:00:00.000Z';
const T4 = '2025-04-01T00:00:00.000Z';

const FIRST = 'ハイエクやフロム的に見ると、現代の私たちに求められるのは：';
const SECOND = '自由から逃げずに、自分で考えることだ。';
const THIRD = '別の場所の線';

function threeHighlights(source = 'kindle') {
  const lib = emptyLibrary();
  mergeParsed(lib, [{
    title: '本',
    source,
    highlights: [
      { text: SECOND, location: 102, locationEnd: 103, note: '後ろのメモ' },
      { text: FIRST, location: 100, locationEnd: 101 },
      { text: THIRD, location: 500, locationEnd: 501 },
    ],
  }], { now: T1 });
  const id = (t) => highlightIdFor(bookIdFor('本'), t);
  return { lib, a: id(FIRST), b: id(SECOND), c: id(THIRD) };
}

test('highlightNeighbors: 同じ本の中で並びが前・次の点を返す', () => {
  const { lib, a, b, c } = threeHighlights();
  assert.deepEqual(Object.fromEntries(Object.entries(highlightNeighbors(lib, b)).map(([k, v]) => [k, v?.id ?? null])), { prev: a, next: c });
  assert.equal(highlightNeighbors(lib, a).prev, null);
  assert.equal(highlightNeighbors(lib, c).next, null);
  updateHighlight(lib, b, { deleted: true }, T2);
  assert.equal(highlightNeighbors(lib, a).next.id, c, '消した点は飛ばす');
  assert.deepEqual(highlightNeighbors(lib, 'h-none'), { prev: null, next: null });
});

test('joinHighlights: 前の点に次の点の文をつなぎ、次の点は前の点に置き換わる', () => {
  const { lib, a, b } = threeHighlights();
  updateHighlight(lib, a, { favorite: true, tags: ['自由'], userNote: '前の自分のメモ' }, T2);
  updateHighlight(lib, b, { tags: ['自由', '思想'], userNote: '後ろの自分のメモ' }, T2);
  // 順番を逆に渡しても、本の中で前にある点が残る
  const { highlight, undo } = joinHighlights(lib, b, a, T3);
  assert.equal(highlight.id, a);
  const h = lib.highlights[a];
  assert.equal(h.text, FIRST + SECOND, '日本語はそのままつなぐ');
  assert.equal(h.originalText, FIRST, '取り込んだときの文を残す（再取り込みの重複判定に使う）');
  assert.equal(h.textEditedAt, T3);
  assert.equal(h.favorite, true);
  assert.deepEqual(h.tags, ['自由', '思想']);
  assert.equal(h.userNote, '前の自分のメモ\n後ろの自分のメモ\n後ろのメモ', '後ろの点の取り込んだメモも自分のメモに足す');
  assert.equal(h.note, '', '取り込んだメモの欄は変えない（同期で空欄を埋め合う欄なので、戻したあとに残らないように）');
  assert.equal(h.location, 100);
  assert.equal(h.locationEnd, 103);
  assert.equal(h.userUpdatedAt, T3);
  const gone = lib.highlights[b];
  assert.equal(gone.deleted, true);
  assert.equal(gone.supersededBy, a);
  assert.equal(gone.joinedAt, T3);
  assert.equal(currentPointId(lib, b), a);
  assert.deepEqual(bookHighlights(lib, bookIdFor('本')).map((x) => x.id), [a, highlightIdFor(bookIdFor('本'), THIRD)]);
  assert.ok(undo.before.length === 2);
});

test('joinHighlights: 両側が英数字なら間に空白を入れる。直した文はいまの文どうしをつなぐ', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: 'Book', source: 'kindle', highlights: [{ text: 'The road to', location: 1 }, { text: 'serfdom is paved', location: 2 }] }], { now: T1 });
  const [x, y] = bookHighlights(lib, bookIdFor('Book'));
  updateHighlight(lib, x.id, { text: 'The road to' }, T2);
  joinHighlights(lib, x.id, y.id, T3);
  assert.equal(lib.highlights[x.id].text, 'The road to serfdom is paved');
  const { lib: lib2, a, b } = threeHighlights();
  updateHighlight(lib2, a, { text: '直した前の文、' }, T2);
  joinHighlights(lib2, a, b, T3);
  assert.equal(lib2.highlights[a].text, '直した前の文、' + SECOND);
  assert.equal(lib2.highlights[a].originalText, FIRST, '取り込んだときの文は最初のまま');
});

test('joinHighlights: 英語などは記号のあとにも空白を挟み、日本語と英数字の境目・空白の前後には挟まない', () => {
  const pair = (p, q) => {
    const lib = emptyLibrary();
    mergeParsed(lib, [{ title: 'B', source: 'kindle', highlights: [{ text: p, location: 1 }, { text: q, location: 2 }] }], { now: T1 });
    const [x, y] = bookHighlights(lib, bookIdFor('B'));
    return joinHighlights(lib, x.id, y.id, T2).highlight.text;
  };
  assert.equal(pair('Hello.', 'World'), 'Hello. World');
  assert.equal(pair('café', 'au lait'), 'café au lait');
  assert.equal(pair('AI', 'が考える'), 'AIが考える');
  assert.equal(pair('私たちは', 'AI を'), '私たちはAI を');
  assert.equal(pair('求められるのは：', 'Freedom'), '求められるのは：Freedom', '全角の記号のあとは挟まない');
});

test('joinHighlights: 位置・ページ・日付が同じ点どうしでも、本の画面で前に見えている方を前にする', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '紙の本', source: 'paper', highlights: [{ text: '前の文', createdAt: T1 }, { text: '後の文', createdAt: T1 }] }], { now: T1 });
  const [x, y] = bookHighlights(lib, bookIdFor('紙の本'));
  joinHighlights(lib, y.id, x.id, T2);
  assert.equal(lib.highlights[x.id].text, x.originalText + y.text);
  assert.equal(lib.highlights[y.id].supersededBy, x.id);
});

test('joinHighlights: 別の本・消した点・同じ点・無い点はくっつけない', () => {
  const { lib, a, b } = threeHighlights();
  mergeParsed(lib, [{ title: '別の本', source: 'kindle', highlights: [{ text: '別の本の線', location: 1 }] }], { now: T1 });
  const other = highlightIdFor(bookIdFor('別の本'), '別の本の線');
  assert.throws(() => joinHighlights(lib, a, other, T2), /同じ本/);
  assert.throws(() => joinHighlights(lib, a, a, T2), /別の点/);
  assert.throws(() => joinHighlights(lib, a, 'hnone', T2), /見つかりません/);
  updateHighlight(lib, b, { deleted: true }, T2);
  assert.throws(() => joinHighlights(lib, a, b, T2), /見つかりません/);
  assert.equal(lib.highlights[a].text, FIRST, '失敗したら何も変えない');
});

test('unjoinHighlights: くっつける前の 2 点に戻す（時刻は進めて、同期でも戻るように）', () => {
  const { lib, a, b } = threeHighlights();
  updateHighlight(lib, b, { favorite: true }, T2);
  const { undo } = joinHighlights(lib, a, b, T3);
  unjoinHighlights(lib, undo, T4);
  const [x, y] = [lib.highlights[a], lib.highlights[b]];
  assert.equal(x.text, FIRST);
  assert.equal(x.favorite, false);
  assert.equal(x.locationEnd, 101);
  assert.equal(x.note, '');
  assert.equal(x.userUpdatedAt, T4);
  assert.equal(x.textEditedAt, T4, '文の時刻も進める（もう一方の端末のくっつけた文に負けない）');
  assert.equal(y.deleted, undefined);
  assert.equal(y.supersededBy, undefined);
  assert.equal(y.joinedAt, undefined);
  assert.equal(y.favorite, true);
  assert.equal(y.userUpdatedAt, T4);
  assert.equal(liveHighlights(lib).length, 3);
});

test('unjoinHighlights: くっつけた後に点が変わっていたら、何も変えずに断る（後からの編集を消さない・半分だけ戻さない）', () => {
  const { lib, a, b } = threeHighlights();
  const { undo } = joinHighlights(lib, a, b, T2);
  updateHighlight(lib, a, { tags: ['後から足したタグ'] }, T3);
  const snapshot = structuredClone(lib.highlights);
  assert.throws(() => unjoinHighlights(lib, undo, T4), /元に戻せません/);
  assert.deepEqual(lib.highlights, snapshot);
  const { lib: lib2, a: a2, b: b2 } = threeHighlights();
  const { undo: undo2 } = joinHighlights(lib2, a2, b2, T2);
  delete lib2.highlights[b2];
  const before = structuredClone(lib2.highlights);
  assert.throws(() => unjoinHighlights(lib2, undo2, T4), /元に戻せません/);
  assert.deepEqual(lib2.highlights, before, '後ろの点が無くても、前の点だけ戻すことはしない');
});

test('同期: くっつけた結果は、どちら向きに統合しても相手の端末に届き、戻した結果も届く', () => {
  const { lib: pc } = threeHighlights();
  const phone = structuredClone(pc);
  const { a, b } = threeHighlights();
  const { undo } = joinHighlights(phone, a, b, T3);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(merged.highlights[a].text, FIRST + SECOND);
    assert.equal(merged.highlights[b].supersededBy, a);
    assert.equal(merged.highlights[b].deleted, true);
  }
  const synced = mergeLibraries(pc, phone);
  unjoinHighlights(phone, undo, T4);
  for (const merged of [mergeLibraries(synced, phone), mergeLibraries(phone, synced)]) {
    assert.equal(merged.highlights[a].text, FIRST);
    assert.equal(merged.highlights[a].note, '', '後ろの点の取り込んだメモが前の点に残らない');
    assert.equal(merged.highlights[a].userNote, '');
    assert.equal(merged.highlights[a].locationEnd, 101);
    assert.equal(merged.highlights[b].deleted, undefined, 'くっつけた点は Kindle の置き換えと違い、戻したら戻る');
    assert.equal(merged.highlights[b].supersededBy, undefined);
  }
});

test('同期: Kindle で伸ばしたハイライトの置き換えは、これまでどおりどちらから来ても消えたまま', () => {
  const { lib, b } = threeHighlights();
  const other = structuredClone(lib);
  Object.assign(lib.highlights[b], { deleted: true, supersededBy: 'hx' });
  const merged = mergeLibraries(other, lib);
  assert.equal(merged.highlights[b].supersededBy, 'hx');
  assert.equal(merged.highlights[b].deleted, true);
  assert.equal(mergeLibraries(lib, other).highlights[b].supersededBy, 'hx');
});

test('再取り込み: くっつけた後で取り込み直しても、後ろの点は戻らず、前の点の文も変わらない', () => {
  const { lib, a, b } = threeHighlights();
  joinHighlights(lib, a, b, T2);
  const stats = mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: FIRST, location: 100, locationEnd: 101 }, { text: SECOND, location: 102, locationEnd: 103 }] }], { now: T3 });
  assert.equal(stats.added, 0);
  assert.equal(lib.highlights[b].deleted, true);
  assert.equal(lib.highlights[a].text, FIRST + SECOND);
  assert.equal(liveHighlights(lib).length, 2);
});

test('くっつけた後も、後ろの点に張ったリンク・永久ノートの根拠は前の点としてたどれる', () => {
  const { lib, a, b, c } = threeHighlights();
  addLink(lib, b, c, '理由', T1);
  const note = addNote(lib, { title: 'ノート', pointIds: [b] }, T1);
  joinHighlights(lib, a, b, T2);
  assert.deepEqual(linksFor(lib, a).map((e) => e.other), [c]);
  assert.deepEqual(linksFor(lib, c).map((e) => e.other), [a]);
  assert.equal(missingEvidence(lib, note), 0);
});

test('画面: 編集シートに前・次の点とくっつけるボタンと相手の文の冒頭を出し、相手が無ければ出さない', async () => {
  const { highlightEditSheet } = await import('../web/js/ui.js');
  const { lib, a, b, c } = threeHighlights();
  const sheet = String(highlightEditSheet(lib.highlights[b], highlightNeighbors(lib, b)));
  assert.match(sheet, /<button class="btn small" value="join-prev">前の点とくっつける<\/button>/);
  assert.match(sheet, /<button class="btn small" value="join-next">次の点とくっつける<\/button>/);
  assert.match(sheet, /ハイエクやフロム的に見ると/);
  assert.match(sheet, /別の場所の線/);
  const first = String(highlightEditSheet(lib.highlights[a], highlightNeighbors(lib, a)));
  assert.doesNotMatch(first, /join-prev/);
  assert.match(first, /join-next/);
  const last = String(highlightEditSheet(lib.highlights[c], highlightNeighbors(lib, c)));
  assert.doesNotMatch(last, /join-next/);
  assert.doesNotMatch(String(highlightEditSheet(lib.highlights[a])), /join-/, '相手を渡さなければ出さない');
  assert.match(String(highlightEditSheet(lib.highlights[a], { prev: { text: undefined }, next: null })), /join-prev/, '同期で壊れた文でも落ちない');
  assert.match(String(highlightEditSheet(lib.highlights[a], { prev: { text: 'あ'.repeat(5000) + '終わり' }, next: null })), /前の点: …あ+終わり</, '前の点は終わりの方を見せる');
});

test('画面: くっつけるときは書きかけの編集を先に保存し、通知の「元に戻す」で戻せる', () => {
  const app = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  const edit = app.slice(app.indexOf('  edit(el) {'), app.indexOf("  'restore-original-text'"));
  assert.match(edit, /highlightNeighbors\(state\.library, h\.id\)/);
  assert.match(edit, /joinHighlights\(/);
  assert.ok(edit.indexOf('updateHighlight(state.library, h.id, { text:') < edit.indexOf('joinHighlights('), '書きかけの編集を先に保存する');
  assert.match(edit, /toast\('くっつけました', 6000, \{ label: '元に戻す', run: \(\) => undoJoinHighlights\(/);
});

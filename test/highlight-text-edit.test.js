import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookHighlights, bookIdFor, emptyLibrary, highlightIdFor, mergeLibraries, mergeParsed, searchHighlights, updateHighlight } from '../web/core/model.js';

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-02-01T00:00:00.000Z';
const T3 = '2025-03-01T00:00:00.000Z';

function oneHighlight(text = '取り込んだ文', extra = {}) {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text, location: 100, locationEnd: 101, ...extra }] }], { now: T1 });
  return { lib, id: highlightIdFor(bookIdFor('本'), text) };
}

test('updateHighlight: 点の文を直せる。ID は変えず、取り込んだときの文を 1 回だけ残す', () => {
  const { lib, id } = oneHighlight();
  updateHighlight(lib, id, { text: '  直した文\r\n二行目  ' }, T2);
  const h = lib.highlights[id];
  assert.equal(h.text, '直した文\n二行目');
  assert.equal(h.originalText, '取り込んだ文');
  assert.equal(h.textEditedAt, T2);
  assert.equal(Object.keys(lib.highlights).length, 1);
  updateHighlight(lib, id, { text: 'もう一度直した' }, T3);
  assert.equal(h.originalText, '取り込んだ文');
  assert.equal(h.textEditedAt, T3);
  assert.equal(searchHighlights(lib, 'もう一度').length, 1);
});

test('updateHighlight: 空の文は受け付けない。同じ文なら直したことにしない', () => {
  const { lib, id } = oneHighlight();
  assert.throws(() => updateHighlight(lib, id, { text: '  \n ' }, T2), /文を入力してください/);
  assert.equal(lib.highlights[id].text, '取り込んだ文');
  updateHighlight(lib, id, { text: '取り込んだ文', userNote: 'メモ' }, T2);
  const h = lib.highlights[id];
  assert.equal(h.userNote, 'メモ');
  assert.equal('originalText' in h, false);
  assert.equal('textEditedAt' in h, false);
});

test('再取り込み: 直した文は取り込みで上書きされない', () => {
  const { lib, id } = oneHighlight();
  updateHighlight(lib, id, { text: '直した文' }, T2);
  const s = mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '取り込んだ文', location: 100, locationEnd: 101 }] }], { now: T3 });
  assert.equal(s.added, 0);
  assert.equal(lib.highlights[id].text, '直した文');
  assert.equal(bookHighlights(lib, bookIdFor('本')).length, 1);
});

test('再取り込み: Kindle で伸ばしたハイライトは取り込んだときの文で判定し、直した文を引き継ぐ', () => {
  const { lib, id } = oneHighlight('短い文');
  updateHighlight(lib, id, { text: '短い文（直した）' }, T2);
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text: '短い文を伸ばした', location: 100, locationEnd: 104 }] }], { now: T3 });
  const live = bookHighlights(lib, bookIdFor('本'));
  assert.equal(live.length, 1);
  assert.equal(lib.highlights[id].supersededBy, live[0].id);
  assert.equal(live[0].text, '短い文（直した）');
  assert.equal(live[0].originalText, '短い文を伸ばした');
  assert.equal(live[0].textEditedAt, T2);
});

test('再取り込み: 読書メモの重複判定は取り込んだときの文で行う', () => {
  const { lib, id } = oneHighlight('習慣は第二の天性である、と古い人は言った');
  updateHighlight(lib, id, { text: '全く別の言葉に直した' }, T2);
  const s = mergeParsed(lib, [{ title: '本', source: 'memo', highlights: [{ text: '習慣は第二の天性である、と古い人' }] }], { now: T3 });
  assert.equal(s.added, 0);
});

test('同期: 文は直した時刻が新しい方を採る。別の端末でタグを後から直しても文の編集は負けない', () => {
  const { lib: pc, id } = oneHighlight();
  const phone = structuredClone(pc);
  updateHighlight(pc, id, { text: 'PC で直した文' }, T2);
  updateHighlight(phone, id, { tags: ['あとで'] }, T3);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    const h = merged.highlights[id];
    assert.equal(h.text, 'PC で直した文');
    assert.equal(h.originalText, '取り込んだ文');
    assert.equal(h.textEditedAt, T2);
    assert.deepEqual(h.tags, ['あとで']);
  }
  updateHighlight(phone, id, { text: 'スマホで後から直した文' }, T3);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(merged.highlights[id].text, 'スマホで後から直した文');
  }
});

test('同期: 外から来た直した文が空・文字列でなければ採らない', () => {
  const { lib: pc, id } = oneHighlight();
  const broken = structuredClone(pc);
  Object.assign(broken.highlights[id], { text: '', textEditedAt: T3 });
  assert.equal(mergeLibraries(pc, broken).highlights[id].text, '取り込んだ文');
  Object.assign(broken.highlights[id], { text: { x: 1 }, textEditedAt: T3 });
  assert.equal(mergeLibraries(broken, pc).highlights[id].text, '取り込んだ文');
});

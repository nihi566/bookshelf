import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookHighlights, bookIdFor, emptyLibrary, highlightIdFor, isTextEdited, mergeLibraries, mergeParsed, searchHighlights, updateHighlight } from '../web/core/model.js';

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

test('同期: 両方の端末で直した文は、統合の向きに依らず同じ結果になる', () => {
  const { lib: pc, id } = oneHighlight();
  const phone = structuredClone(pc);
  updateHighlight(pc, id, { text: 'PC で直した文' }, T2);
  updateHighlight(phone, id, { text: 'スマホで直した文' }, T2);
  // 片方は伸ばしたハイライトから引き継いだ、別の取り込んだときの文を持つ
  phone.highlights[id].originalText = '別の取り込んだ文';
  assert.deepEqual(mergeLibraries(pc, phone).highlights[id], mergeLibraries(phone, pc).highlights[id]);
  const merged = mergeLibraries(pc, phone);
  assert.equal(mergeLibraries(merged, merged).highlights[id].text, merged.highlights[id].text);
});

test('同期: 別の端末で伸ばしたハイライトに置き換わっても、直した文は置き換え先に引き継ぐ', () => {
  const { lib: pc, id } = oneHighlight('短い文');
  const phone = structuredClone(pc);
  updateHighlight(pc, id, { text: '短い文（PC で直した）' }, T2);
  mergeParsed(phone, [{ title: '本', source: 'kindle', highlights: [{ text: '短い文を伸ばした', location: 100, locationEnd: 104 }] }], { now: T3 });
  const longId = phone.highlights[id].supersededBy;
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(merged.highlights[id].deleted, true);
    const h = merged.highlights[longId];
    assert.equal(h.text, '短い文（PC で直した）');
    assert.equal(h.originalText, '短い文を伸ばした');
    assert.equal(h.textEditedAt, T2);
  }
});

test('同期: 外から来た取り込んだときの文・直した時刻が文字列でなければ採らない', () => {
  const { lib: pc, id } = oneHighlight();
  const broken = structuredClone(pc);
  Object.assign(broken.highlights[id], { text: '直した文', textEditedAt: 123 });
  for (const m of [mergeLibraries(pc, broken), mergeLibraries(broken, pc)]) {
    assert.equal('textEditedAt' in m.highlights[id], false);
    assert.equal('originalText' in m.highlights[id], false);
  }
  Object.assign(broken.highlights[id], { textEditedAt: T2, originalText: { x: 1 } });
  const merged = mergeLibraries(pc, broken);
  assert.equal(merged.highlights[id].text, '直した文');
  assert.equal(merged.highlights[id].originalText, '取り込んだ文');
  // 壊れた取り込んだときの文を持っていても、再取り込みは落ちない
  broken.highlights[id].originalText = { x: 1 };
  assert.doesNotThrow(() => mergeParsed(broken, [{ title: '本', source: 'kindle', highlights: [{ text: '取り込んだ文を伸ばした', location: 100, locationEnd: 104 }] }], { now: T3 }));
});

test('updateHighlight: text を渡さなければ文に触れない', () => {
  const { lib, id } = oneHighlight();
  updateHighlight(lib, id, { text: undefined, favorite: true }, T2);
  assert.equal(lib.highlights[id].text, '取り込んだ文');
  assert.equal(lib.highlights[id].favorite, true);
});

test('同期: 外から来た直した文が空・文字列でなければ採らない', () => {
  const { lib: pc, id } = oneHighlight();
  const broken = structuredClone(pc);
  Object.assign(broken.highlights[id], { text: '', textEditedAt: T3 });
  assert.equal(mergeLibraries(pc, broken).highlights[id].text, '取り込んだ文');
  Object.assign(broken.highlights[id], { text: { x: 1 }, textEditedAt: T3 });
  assert.equal(mergeLibraries(broken, pc).highlights[id].text, '取り込んだ文');
});

// NIH-66: 文を直した点の印・取り込んだときの文へ戻す
test('isTextEdited: 取り込んだときの文と違う文になっている点だけを直した点とみなす', () => {
  const { lib, id } = oneHighlight();
  assert.equal(isTextEdited(lib.highlights[id]), false);
  updateHighlight(lib, id, { text: '直した文' }, T2);
  assert.equal(isTextEdited(lib.highlights[id]), true);
  // 取り込んだときの文に戻して保存したら、直した点ではない
  updateHighlight(lib, id, { text: '取り込んだ文' }, T3);
  assert.equal(isTextEdited(lib.highlights[id]), false);
  assert.equal(isTextEdited({ text: 'a', originalText: { x: 1 } }), false, '壊れた取り込んだときの文は数えない');
  assert.equal(isTextEdited({ text: 'a', originalText: '  ' }), false);
});

test('NIH-66: 文を直した点のカードにだけ「直した文」の印を出す', async () => {
  const { highlightCard } = await import('../web/js/ui.js');
  const { lib, id } = oneHighlight();
  assert.doesNotMatch(String(highlightCard(lib.highlights[id], { library: lib })), /直した文/);
  updateHighlight(lib, id, { text: '直した文章' }, T2);
  assert.match(String(highlightCard(lib.highlights[id], { library: lib })), /<span class="badge edited"[^>]*>直した文<\/span>/);
});

test('NIH-66: 編集シートの「取り込んだときの文」の横に、保存しない「この文に戻す」を出す', async () => {
  const { highlightEditSheet } = await import('../web/js/ui.js');
  const { lib, id } = oneHighlight();
  assert.doesNotMatch(String(highlightEditSheet(lib.highlights[id])), /この文に戻す|取り込んだときの文/);
  updateHighlight(lib, id, { text: '直した<b>文</b>' }, T2);
  const sheet = String(highlightEditSheet(lib.highlights[id]));
  assert.match(sheet, /取り込んだときの文: 取り込んだ文/);
  assert.match(sheet, /<button type="button" class="btn small" data-action="restore-original-text" data-id="[^"]+">この文に戻す<\/button>/, 'type="button" なのでシートを送信（保存）しない');
  assert.match(sheet, /<textarea name="text" rows="4">直した&lt;b&gt;文&lt;\/b&gt;<\/textarea>/);
});

test('NIH-66: 「この文に戻す」は文の欄に取り込んだときの文を入れるだけで、保存しない', () => {
  const app = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  const action = app.match(/'restore-original-text'\(el\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(action, /\.originalText/);
  assert.match(action, /elements\.text/);
  assert.doesNotMatch(action, /updateHighlight|persistLibrary|autoSyncAfterChange/);
  assert.match(app, /openSheet\(\s*highlightEditSheet\(h\)/);
});

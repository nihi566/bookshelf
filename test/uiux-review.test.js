// 2026-10-04 UI/UX 総点検: 絞り込みの選択状態の読み上げ・並び順の見出し・編集シートの書きかけ保護
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function sampleState() {
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS);
  return { library, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false };
}

const chipsOf = (out) => [...out.matchAll(/<a class="chip[^"]*"[^>]*>[^<]*<\/a>/g)].map((m) => m[0]);

test('読んだ本: 選んでいる絞り込み・並び順のチップだけ aria-current="true" を持つ', async () => {
  const { books } = await import('../web/js/views/library.js');
  const out = String(books.render({ state: sampleState(), query: new URLSearchParams('source=kindle&sort=title') }));
  const current = chipsOf(out).filter((c) => c.includes('aria-current="true"'));
  assert.deepEqual(current.map((c) => c.replace(/<[^>]+>/g, '')), ['Kindle', '書名']);
});

test('読んだ本: 並び順の行には見える見出しとグループ名がある（絞り込みの行と見分けられる）', async () => {
  const { books } = await import('../web/js/views/library.js');
  const out = String(books.render({ state: sampleState(), query: new URLSearchParams() }));
  assert.match(out, /role="group" aria-label="読み方で絞り込む"/);
  assert.match(out, /role="group" aria-labelledby="books-sort-label"/);
  assert.match(out, /<span class="chips-label" id="books-sort-label">並び順<\/span>/);
  // 何も選んでいないときは「すべて」「最近」が選択中
  const current = chipsOf(out).filter((c) => c.includes('aria-current="true"'));
  assert.deepEqual(current.map((c) => c.replace(/<[^>]+>/g, '')), ['すべて', '最近']);
});

test('ハイライトの検索: 選んでいる絞り込みのチップだけ aria-current="true" を持つ', async () => {
  const { search } = await import('../web/js/views/library.js');
  const boxes = {};
  const root = {
    querySelector(sel) {
      if (sel === 'input[name="q"]') return { value: '', addEventListener() {} };
      boxes[sel] ||= { innerHTML: '', isConnected: true };
      return boxes[sel];
    },
  };
  search.mount(root, { state: sampleState(), query: new URLSearchParams('fav=1') });
  const chips = chipsOf(boxes['#search-filters'].innerHTML);
  // すべて・Kindle・Play Books・紙の本・読書メモ・★ お気に入り
  assert.equal(chips.length, 6);
  const current = chips.filter((c) => c.includes('aria-current="true"'));
  assert.deepEqual(current.map((c) => c.replace(/<[^>]+>/g, '')), ['すべて', '★ お気に入り']);
  const page = String(search.render({ state: sampleState(), query: new URLSearchParams() }));
  assert.match(page, /id="search-filters" role="group" aria-label="絞り込み"/);
});

test('sheetDirty: 開いたときから入力が変わったときだけ true', async () => {
  const { sheetDirty } = await import('../web/js/ui.js');
  const before = [['userNote', ''], ['tags', '習慣']];
  assert.equal(sheetDirty(before, [['userNote', ''], ['tags', '習慣']]), false);
  assert.equal(sheetDirty(before, [['userNote', 'メモ'], ['tags', '習慣']]), true);
  assert.equal(sheetDirty(before, [['userNote', ''], ['tags', '']]), true);
  // 項目の増減も変更として扱う
  assert.equal(sheetDirty(before, [['userNote', '']]), true);
});

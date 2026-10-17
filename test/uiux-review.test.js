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

test('読んだ本: 選んでいる並び順のチップだけ aria-current="true" を持つ', async () => {
  const { books } = await import('../web/js/views/library.js');
  const out = String(books.render({ state: sampleState(), query: new URLSearchParams('sort=title') }));
  const current = chipsOf(out).filter((c) => c.includes('aria-current="true"'));
  assert.deepEqual(current.map((c) => c.replace(/<[^>]+>/g, '')), ['書名']);
});

test('読んだ本: 並び順の行には見える見出しとグループ名があり、出どころ（Kindle・Play Books・紙の本・読書メモ）の区分は出さない', async () => {
  const { books } = await import('../web/js/views/library.js');
  const out = String(books.render({ state: sampleState(), query: new URLSearchParams() }));
  assert.match(out, /role="group" aria-labelledby="books-sort-label"/);
  assert.match(out, /<span class="chips-label" id="books-sort-label">並び順<\/span>/);
  // 何も選んでいないときは「最近」が選択中
  const current = chipsOf(out).filter((c) => c.includes('aria-current="true"'));
  assert.deepEqual(current.map((c) => c.replace(/<[^>]+>/g, '')), ['最近']);
  assert.doesNotMatch(out, /読み方で絞り込む|class="badge (kindle|playbooks|paper|memo)"/);
  assert.doesNotMatch(out, />(Play Books|読書メモ)</);
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
  // すべて・思いつき・★ お気に入り・直した文（出どころごとの絞り込みは持たない）
  assert.equal(chips.length, 4);
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

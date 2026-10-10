import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookIdFor, emptyLibrary, highlightIdFor, mergeParsed } from '../web/core/model.js';
import { highlightCard } from '../web/js/ui.js';

const T1 = '2025-01-01T00:00:00.000Z';

function oneHighlight(text = '線を引いた文') {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '本', source: 'kindle', highlights: [{ text, location: 100 }] }], { now: T1 });
  return { lib, id: highlightIdFor(bookIdFor('本'), text) };
}

test('NIH-91: 点のカードに、編集を開かずに押せる「点を削除」ボタンを出す', () => {
  const { lib, id } = oneHighlight();
  const card = String(highlightCard(lib.highlights[id], { library: lib }));
  assert.match(card, new RegExp(`<button class="icon-btn" data-action="delete" data-id="${id}" aria-label="点を削除"[^>]*>`));
});

test('NIH-91: カードの削除ボタンは、編集シートの削除と同じく点に deleted の印を付けて保存する', () => {
  const src = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  const body = src.match(/\n {2}async delete\(el\) \{\r?\n([\s\S]*?)\r?\n {2}\},/)?.[1] || '';
  assert.match(body, /updateHighlight\(state\.library, el\.dataset\.id, \{ deleted: true \}\)/);
  assert.match(body, /await persistLibrary\(\)/);
  assert.match(body, /autoSyncAfterChange\(\)/);
});

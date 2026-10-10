import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('NIH-91: カードの削除ボタンは、編集シートの削除と同じく点に deleted の印を付けて保存する', async () => {
  const { fakeApp, button } = await import('./helpers/app-actions.js');
  const { lib, id } = oneHighlight();
  const app = fakeApp({ library: lib, analysis: null, loaded: true });
  await app.actions.delete(button({ id }));
  assert.equal(lib.highlights[id].deleted, true);
  assert.deepEqual(app.log, ['persist', 'toast', 'render', 'sync']);
  // 確認なしの 1 押しなので、編集シートの削除と同じく通知から元に戻せる（NIH-22）
  const [deleted] = app.toasts;
  assert.deepEqual([deleted.message, deleted.ms, deleted.action.label], ['削除しました', 6000, '元に戻す']);
  await deleted.action.run();
  assert.ok(!lib.highlights[id].deleted);
  // 無い点には何もしない
  app.log.length = 0;
  await app.actions.delete(button({ id: 'nothing' }));
  assert.deepEqual(app.log, []);
});

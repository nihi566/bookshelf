// NIH-22 点を削除した直後の通知に「元に戻す」を付ける
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, liveHighlights, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** toast が触る分だけの DOM（#toast と、中に足すボタン） */
function fakeDom() {
  const node = (tag) => ({
    tagName: tag,
    children: [],
    text: '',
    classes: new Set(),
    listeners: {},
    set textContent(v) { this.text = String(v); this.children = []; },
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); },
    get classList() {
      const c = this.classes;
      return { add: (n) => c.add(n), remove: (n) => c.delete(n), toggle: (n, on) => (on ? c.add(n) : c.delete(n)), contains: (n) => c.has(n) };
    },
    append(...xs) { for (const x of xs) this.children.push(typeof x === 'string' ? { textContent: x } : x); },
    querySelector(sel) { return this.children.find((c) => sel === `.${c.className}`) || null; },
    remove() { el.children = el.children.filter((c) => c !== this); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    click() { this.listeners.click?.(); },
  });
  const el = node('div');
  globalThis.document = { getElementById: (id) => (id === 'toast' ? el : null), createElement: (tag) => node(tag) };
  return el;
}

test('toast: 操作を渡すと通知にボタンが出て、押すと操作が走り通知が消える', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = fakeDom();
  const { toast } = await import('../web/js/ui.js');
  let ran = 0;
  toast('削除しました', 6000, { label: '元に戻す', run: () => { ran++; } });
  assert.ok(el.classList.contains('show'));
  assert.ok(el.classList.contains('has-action'), '押せるようにする印が付く');
  const btn = el.querySelector('.toast-action');
  assert.ok(btn, 'ボタンがある');
  assert.equal(btn.type, 'button');
  assert.equal(btn.textContent, '元に戻す');
  btn.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(ran, 1);
  assert.ok(!el.classList.contains('show'), '押したら通知を閉じる');
  assert.equal(el.querySelector('.toast-action'), null, '押したボタンは残さない（二度押しで二度戻さない）');
});

test('toast: 時間がたつとボタンごと消え、操作の無い通知にはボタンが出ない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = fakeDom();
  const { toast } = await import('../web/js/ui.js');
  toast('削除しました', 6000, { label: '元に戻す', run: () => {} });
  t.mock.timers.tick(6000);
  assert.ok(!el.classList.contains('show'));
  assert.equal(el.querySelector('.toast-action'), null, '見えない通知のボタンを押せる・選べるままにしない');
  toast('保存しました');
  assert.equal(el.textContent, '保存しました');
  assert.ok(!el.classList.contains('has-action'));
  assert.equal(el.querySelector('.toast-action'), null);
});

test('toast: 操作が失敗したら理由を通知に出す（黙って失敗しない）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = fakeDom();
  const { toast } = await import('../web/js/ui.js');
  toast('削除しました', 6000, { label: '元に戻す', run: async () => { throw new Error('保存できませんでした'); } });
  el.querySelector('.toast-action').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(el.textContent, '保存できませんでした');
});

test('toast: Error 以外で失敗しても、黙らずに失敗を知らせる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = fakeDom();
  const { toast } = await import('../web/js/ui.js');
  toast('削除しました', 6000, { label: '元に戻す', run: () => Promise.reject(undefined) });
  el.querySelector('.toast-action').click();
  await new Promise((r) => setImmediate(r));
  assert.equal(el.textContent, '元に戻すことができませんでした');
});

test('toast: 前の通知のタイマーで、後から出した通知を消さない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const el = fakeDom();
  const { toast } = await import('../web/js/ui.js');
  toast('削除しました', 6000, { label: '元に戻す', run: () => {} });
  t.mock.timers.tick(3000);
  toast('保存しました', 6000);
  t.mock.timers.tick(3000);
  assert.ok(el.classList.contains('show'), '後の通知は 6 秒出たまま');
  assert.equal(el.textContent, '保存しました');
});

test('削除した点は deleted: false で生きた点に戻り、メモ・タグ・★も残っている', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const h = liveHighlights(lib)[0];
  updateHighlight(lib, h.id, { userNote: '自分のメモ', tags: ['習慣'], favorite: true }, '2026-10-10T00:00:00.000Z');
  updateHighlight(lib, h.id, { deleted: true }, '2026-10-10T00:01:00.000Z');
  assert.ok(!liveHighlights(lib).some((x) => x.id === h.id));
  const back = updateHighlight(lib, h.id, { deleted: false }, '2026-10-10T00:02:00.000Z');
  assert.ok(liveHighlights(lib).some((x) => x.id === h.id));
  assert.deepEqual([back.userNote, back.tags, back.favorite], ['自分のメモ', ['習慣'], true]);
  assert.equal(back.userUpdatedAt, '2026-10-10T00:02:00.000Z', '戻した時刻が新しいので、同期でも戻した方が勝つ');
});

test('点の編集シートの「この点を削除」は「元に戻す」付きの通知を出し、押すと印を外して保存・描き直し・同期する', async () => {
  const { fakeApp, button } = await import('./helpers/app-actions.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const h = liveHighlights(lib)[0];
  const app = fakeApp({ library: lib, analysis: null, loaded: true });
  app.actions.edit(button({ id: h.id }));
  await app.sheets[0].onSubmit(null, 'delete');
  assert.ok(!liveHighlights(lib).some((x) => x.id === h.id));
  assert.deepEqual(app.log, ['openSheet', 'persist', 'toast', 'render', 'sync'], '端末に保存できてから知らせる（保存に失敗したのに「削除しました」と出さない）');
  const [deleted] = app.toasts;
  assert.equal(deleted.message, '削除しました');
  assert.equal(deleted.action.label, '元に戻す');
  app.log.length = 0;
  await deleted.action.run();
  assert.ok(liveHighlights(lib).some((x) => x.id === h.id));
  assert.deepEqual(app.log, ['persist', 'render', 'sync', 'toast']);
  assert.equal(app.toasts.at(-1).message, '元に戻しました');
  // 同期で点そのものが消えていたら、戻せないことを知らせる（保存しない）
  app.log.length = 0;
  delete lib.highlights[h.id];
  await assert.rejects(deleted.action.run(), /この点はもう見つかりません/);
  assert.deepEqual(app.log, []);
});

test('通知のボタンは押せる（通知全体は下の画面の操作を邪魔しないまま）', () => {
  const css = readFileSync(join(WEB, 'css/app.css'), 'utf8');
  assert.match(css, /#toast \{[^}]*pointer-events: none/);
  assert.match(css, /#toast\.show\.has-action \{[^}]*pointer-events: auto/);
  assert.match(css, /\.toast-action \{/);
});

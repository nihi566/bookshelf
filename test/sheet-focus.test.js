// NIH-90: シートを開いただけで書く欄に入り、スマホのキーボードが開かない（autofocus を付けた欄だけ、開いてすぐ書ける）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { html } from '../web/js/html.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// showModal() はブラウザの決まりで、dialog に autofocus が無ければ中の最初の入力欄に入る。
// その動きを真似る偽の dialog で、開いたときにどこへ入ったかを記録する
function fakeDialog() {
  const attrs = new Set();
  const log = { focused: null };
  let markup = '';
  const form = {
    querySelector: (sel) => (sel === '[autofocus]' ? (/\sautofocus[\s>]/.test(markup) ? {} : null) : { hidden: true, textContent: '' }),
    addEventListener() {},
  };
  const dialog = {
    set innerHTML(v) {
      markup = v;
    },
    querySelector: () => form,
    toggleAttribute: (name, on) => (on ? attrs.add(name) : attrs.delete(name)),
    hasAttribute: (name) => attrs.has(name),
    showModal() {
      log.focused = attrs.has('autofocus') ? 'dialog' : /\sautofocus[\s>]/.test(markup) ? 'autofocus-field' : 'first-field';
    },
    focus() {
      log.focused = 'dialog';
    },
  };
  return { dialog, log };
}

async function open(content) {
  const { dialog, log } = fakeDialog();
  globalThis.document = { getElementById: () => dialog };
  globalThis.FormData = class {
    *[Symbol.iterator]() {}
  };
  const { openSheet } = await import('../web/js/ui.js');
  openSheet(content, async () => {});
  return log;
}

test('NIH-90: 点を編集のシートを開いても、書く欄に入らない（キーボードが開かない）', async () => {
  const { highlightEditSheet } = await import('../web/js/ui.js');
  const log = await open(highlightEditSheet({ id: 'h1', text: '線を引いた文', tags: [] }));
  assert.equal(log.focused, 'dialog');
});

test('NIH-90: autofocus を付けた欄があるシート（新しいメモなど）は、開いてすぐその欄に書ける', async () => {
  const log = await open(html`<textarea name="text" autofocus></textarea><button value="save">保存</button>`);
  assert.equal(log.focused, 'autofocus-field');
});

test('NIH-90: シートの dialog は、入力欄の代わりにフォーカスを受け取れる', () => {
  const index = readFileSync(join(WEB, 'index.html'), 'utf8');
  assert.match(index, /<dialog id="sheet" class="sheet" tabindex="-1">/);
});

// ホームの並び（#69 今日の点を受け箱より上に）と今日の点の件数（#72 3 件 → 2 件）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

function state(library) {
  return { library, analysis: null, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
}

const today = (out) => out.match(/<section class="today"[\s\S]*?<\/section>/)?.[0] || '';
const cards = (s) => (s.match(/<article class="hl/g) || []).length;

test('#72: ホームの今日の点は 2 件。「別の点」を押しても 2 件のまま', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  assert.equal(cards(today(String(home.render({ state: state(lib), shuffle: 0 })))), 2);
  for (const seed of ['a1', 'b2', 'c3']) assert.equal(cards(today(String(home.render({ state: state(lib), shuffle: seed })))), 2, `種 ${seed}`);
});

test('#72: 点が 1 件だけのときは 1 件だけ出て、見出しと「別の点」は崩れない', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  addThought(lib, { text: 'ただ一つの思いつき' }, '2026-10-01T00:00:00.000Z');
  const box = today(String(home.render({ state: state(lib), shuffle: 0 })));
  assert.equal(cards(box), 1);
  assert.match(box, /<h2 id="today-title">今日の点<\/h2>/);
  assert.match(box, /data-action="shuffle"/);
});

test('#69: ホームでは今日の点が受け箱より上に出る。受け箱が空でも今日の点は出る', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  const empty = String(home.render({ state: state(lib), shuffle: 0 }));
  assert.doesNotMatch(empty, /class="inbox"/, '受け箱が空なら出さない');
  assert.equal(cards(today(empty)), 2);
  addThought(lib, { text: '受け箱の思いつき' }, '2026-10-01T00:00:00.000Z');
  const out = String(home.render({ state: state(lib), shuffle: 0 }));
  assert.ok(out.indexOf('class="today"') > 0 && out.indexOf('class="today"') < out.indexOf('class="inbox"'), '今日の点 → 受け箱 の順');
});

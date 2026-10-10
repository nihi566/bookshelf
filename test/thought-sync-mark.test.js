// NIH-6: 思いつきのカードに「PC に未同期」の印を出す（最後の同期より新しいメモ。同期すると消える）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary } from '../web/core/model.js';
import { addThought, isThoughtUnsynced, updateThought } from '../web/core/thoughts.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';
const MARK = /<span class="badge unsynced"[^>]*>PC に未同期<\/span>/;

/** PC を使う設定の画面（ai.mode: companion）。opts で PC の見つかり方を変える */
function state(library, lastSync, opts = {}) {
  return {
    library,
    analysis: null,
    settings: { ai: { mode: 'companion', companionUrl: opts.companionUrl ?? '' } },
    servedByCompanion: opts.servedByCompanion ?? true,
    companionOriginChecked: opts.companionOriginChecked ?? true,
    lastSync,
    pcInfo: null,
  };
}

test('isThoughtUnsynced: 最後の同期より後に書いた・直したメモだけが未同期', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '思いつき' }, T2);
  assert.equal(isThoughtUnsynced(t, T1), true, '同期より後に書いた');
  assert.equal(isThoughtUnsynced(t, T3), false, '同期より前に書いた');
  assert.equal(isThoughtUnsynced(t, T2), false, '同じ時刻は届いている（同期を始めた時刻を記録するため）');
  assert.equal(isThoughtUnsynced(t, null), true, '一度も同期していない');
  assert.equal(isThoughtUnsynced(t, 'こわれた値'), true, '最後の同期の時刻が読めなければ、届いたとは言えない');
  const u = updateThought(lib, t.id, { status: 'done' }, '2026-10-04T00:00:00.000Z');
  assert.equal(isThoughtUnsynced(u, T3), true, '同期のあとに整理済みにした（状態の変更も PC に届いていない）');
});

test('受け箱・メモの一覧・点の画面: 未同期のメモのカードに「PC に未同期」と出て、同期すると消える', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { thoughtsView } = await import('../web/js/views/thoughts.js');
  const { pointView } = await import('../web/js/views/point.js');
  const lib = emptyLibrary();
  const t = addThought(lib, { text: 'スマホで書いた思いつき' }, T2);
  const views = (st) => [
    String(home.render({ state: st, shuffle: 0 })).match(/<section class="inbox"[\s\S]*?<\/section>/)[0],
    String(thoughtsView.render({ state: st, query: new URLSearchParams() })),
    String(pointView.render({ state: st, params: { id: t.id } })),
  ];
  for (const out of views(state(lib, T1))) assert.match(out, MARK);
  for (const out of views(state(lib, T3))) assert.doesNotMatch(out, MARK, '同期したら消える');
});

test('印は未同期のメモだけに付く（同じ一覧の同期済みのメモには付かない）', async () => {
  const { thoughtsView } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  const old = addThought(lib, { text: '前に書いた' }, T1);
  const fresh = addThought(lib, { text: 'あとで書いた' }, T3);
  const out = String(thoughtsView.render({ state: state(lib, T2), query: new URLSearchParams() }));
  const card = (id) => out.match(new RegExp(`<article class="hl thought" data-hl="${id}">[\\s\\S]*?</article>`))[0];
  assert.match(card(fresh.id), MARK);
  assert.doesNotMatch(card(old.id), MARK);
});

test('PC を使わない画面では印を出さない（AI を直接つなぐ設定 / PC ではないと確かめ済みで PC の URL も無い）', async () => {
  const { thoughtsView } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  addThought(lib, { text: '思いつき' }, T2);
  const render = (st) => String(thoughtsView.render({ state: st, query: new URLSearchParams() }));
  const direct = state(lib, null);
  direct.settings.ai.mode = 'direct';
  assert.doesNotMatch(render(direct), MARK, '同期する相手が無い');
  assert.doesNotMatch(render(state(lib, null, { servedByCompanion: false, companionOriginChecked: true })), MARK, 'GitHub Pages などで開いた画面');
  // PC に届かなかったまま（Tailscale がまだつながっていない等）の画面・PC の URL を設定した画面は、届いていないメモに印を出す
  assert.match(render(state(lib, T1, { servedByCompanion: false, companionOriginChecked: false })), MARK);
  assert.match(render(state(lib, T1, { servedByCompanion: false, companionOriginChecked: true, companionUrl: 'http://pc:8787' })), MARK);
});

test('同期は始めた時刻を最後の同期として残す（同期の間に書いたメモを、届いていないのに同期済みと見せない）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/js/services.js', import.meta.url), 'utf8');
  const body = src.match(/export async function syncWithPc\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /const startedAt = new Date\(\)\.toISOString\(\);\s*const merged = await companion\.merge/, 'PC に送る前に時刻を取る');
  assert.match(body, /state\.lastSync = startedAt;/);
});

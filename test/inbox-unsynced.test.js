// NIH-101: 受け箱に「PC に未同期 N 件」と、その場で同期し直す「同期する」を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary } from '../web/core/model.js';
import { addThought, countUnsyncedThoughts, deleteThought, updateThought } from '../web/core/thoughts.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';
const ROW = /<div class="unsynced-row"[\s\S]*?<\/div>/;

function state(library, lastSync, mode = 'companion') {
  return {
    library,
    analysis: null,
    settings: { ai: { mode, companionUrl: '' } },
    servedByCompanion: true,
    companionOriginChecked: true,
    lastSync,
    pcInfo: null,
  };
}

async function inbox(st) {
  const { inboxBlock } = await import('../web/js/views/thoughts.js');
  return String(inboxBlock(st));
}

test('countUnsyncedThoughts: 最後の同期より後に書いた・直したメモを数える（消したメモは数えない）', () => {
  const lib = emptyLibrary();
  addThought(lib, { text: '前に書いた' }, T1);
  const a = addThought(lib, { text: 'あとで書いた' }, T3);
  const b = addThought(lib, { text: 'あとで書いて捨てた' }, T3);
  updateThought(lib, b.id, { status: 'discarded' }, T3);
  const c = addThought(lib, { text: 'あとで書いて消した' }, T3);
  deleteThought(lib, c.id, T3);
  assert.equal(countUnsyncedThoughts(lib, T2), 2, '整理済み・捨てたへの変更も PC に届いていない');
  assert.equal(countUnsyncedThoughts(lib, T3), 0);
  assert.equal(countUnsyncedThoughts(lib, null), 3, '一度も同期していなければ、残っているメモはすべて未同期');
  assert.ok(a);
});

test('受け箱: 未同期のメモがあれば見出しの近くに「PC に未同期 N 件」と「同期する」が出る', async () => {
  const lib = emptyLibrary();
  for (const text of ['1', '2', '3', '4']) addThought(lib, { text }, T2);
  const out = await inbox(state(lib, T1));
  const row = out.match(ROW)?.[0];
  assert.ok(row, '行が出る');
  assert.match(row, /PC に未同期 4 件/, '受け箱に並ぶ 3 件より多くても全件を数える');
  assert.match(row, /<button[^>]*data-action="sync"[^>]*>同期する<\/button>/, '設定の「今すぐ同期」と同じ同期を呼ぶ');
  assert.ok(out.indexOf('unsynced-row') < out.indexOf('<article'), 'カードより上（見出しの近く）');
});

test('受け箱: 同期したら（最後の同期がメモより新しくなったら）行は消える', async () => {
  const lib = emptyLibrary();
  addThought(lib, { text: '思いつき' }, T2);
  assert.doesNotMatch(await inbox(state(lib, T3)), ROW);
});

test('受け箱: PC を使わない画面（pcSyncOf が null）では出さない', async () => {
  const lib = emptyLibrary();
  addThought(lib, { text: '思いつき' }, T2);
  assert.doesNotMatch(await inbox(state(lib, null, 'direct')), ROW);
  const pages = state(lib, null);
  pages.servedByCompanion = false;
  assert.doesNotMatch(await inbox(pages), ROW, 'GitHub Pages などで開いた画面');
});

test('同期に失敗したら理由を出す（既存の sync が e.message をトーストする）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/js/app.js', import.meta.url), 'utf8');
  const body = src.match(/async function sync\(\{ quiet = false \} = \{\}\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /catch \(e\) \{[\s\S]*if \(!quiet\) toast\(e\.message/);
  assert.match(src, /\n  sync: \(\) => sync\(\),/, '受け箱のボタンは quiet なしで呼ぶ');
});

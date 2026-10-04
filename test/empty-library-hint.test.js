// 20261004-empty-library-pc-not-connected-hint: 本が 0 冊で PC とつながっていないとき、一覧の空表示につなぎ方を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const st = ({ mode = 'companion', companionUrl = '', servedByCompanion = false, pcSyncFailed = false, library = emptyLibrary() } = {}) => ({
  settings: { ai: { mode, companionUrl } },
  servedByCompanion,
  pcSyncFailed,
  library,
});

test('空の一覧: PC を設定していない（GitHub Pages で開いただけ）ならつなぎ方を案内する', async () => {
  const { emptyBooksBlock } = await import('../web/js/ui.js');
  const out = String(emptyBooksBlock(st()));
  assert.match(out, /PC とつながっていません/);
  assert.match(out, /href="#\/settings"/);
  assert.match(out, /http:\/\/localhost:8787/);
  assert.match(out, /href="#\/import"/);
});

test('空の一覧: PC の URL があっても同期に失敗していれば案内する', async () => {
  const { emptyBooksBlock } = await import('../web/js/ui.js');
  const out = String(emptyBooksBlock(st({ companionUrl: 'https://pc.example.ts.net', pcSyncFailed: true })));
  assert.match(out, /PC と同期できませんでした/);
  assert.match(out, /href="#\/settings"/);
});

test('空の一覧: PC とつながっているとき・ブラウザ直結のときは従来どおり', async () => {
  const { emptyBooksBlock } = await import('../web/js/ui.js');
  for (const s of [st({ companionUrl: 'https://pc.example.ts.net' }), st({ servedByCompanion: true }), st({ mode: 'direct' })]) {
    const out = String(emptyBooksBlock(s));
    assert.doesNotMatch(out, /PC と(つながっていません|同期できませんでした)/);
    assert.match(out, /本がありません/);
  }
});

test('空の一覧: 本があって絞り込みで 0 件になっただけなら案内しない', async () => {
  const { emptyBooksBlock } = await import('../web/js/ui.js');
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS.slice(0, 1));
  const out = String(emptyBooksBlock(st({ library })));
  assert.doesNotMatch(out, /PC とつながっていません/);
  assert.match(out, /本がありません/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNotesSync } from '../cli/notes-sync.js';
import { bookIdFor, emptyLibrary, liveHighlights, mergeParsed, updateHighlight } from '../web/core/model.js';

const NOW = '2026-10-18T00:00:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, [
    { title: '本A', author: '著者', source: 'kindle', highlights: [{ text: '最初の文', chapter: '第1章' }, { text: '二つ目の文' }] },
    { title: '本B', author: '', source: 'paper', highlights: [{ text: 'Bの文' }] },
  ], { now: NOW });
  return lib;
}

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'bh-notes-'));

test('1 冊 1 ファイルで、書名のファイル名に書き出す。2 回目は何も書かない', async () => {
  const dir = await tmp();
  const sync = createNotesSync({ dir });
  const lib = sample();
  assert.equal((await sync.sync(lib)).written, 2);
  assert.deepEqual((await readdir(dir)).sort(), ['本A.md', '本B.md']);
  assert.match(await readFile(path.join(dir, '本A.md'), 'utf8'), /^---\nbookId: b/);
  assert.equal((await sync.sync(lib)).written, 0);
});

test('ライブラリで直した内容は、次の同期でファイルに入る', async () => {
  const dir = await tmp();
  const sync = createNotesSync({ dir });
  const lib = sample();
  await sync.sync(lib);
  updateHighlight(lib, liveHighlights(lib)[0].id, { userNote: 'あとから書いた' }, NOW);
  assert.equal((await sync.sync(lib)).written, 1);
  assert.match(await readFile(path.join(dir, '本A.md'), 'utf8'), /メモ: あとから書いた/);
});

test('ファイルで直した内容は、次の同期でライブラリに入り、ファイルは上書きされない', async () => {
  const dir = await tmp();
  const sync = createNotesSync({ dir });
  const lib = sample();
  await sync.sync(lib);
  const file = path.join(dir, '本A.md');
  const edited = (await readFile(file, 'utf8')).replace('最初の文', '直した文');
  await writeFile(file, edited);
  const later = new Date(Date.now() + 5000);
  await utimes(file, later, later);
  const r = await sync.sync(lib);
  assert.equal(r.changed, 1);
  assert.ok(liveHighlights(lib).some((h) => h.text === '直した文'));
  assert.equal(await readFile(file, 'utf8'), edited);
});

test('bookId の無いファイル（Obsidian の他のメモ）は読まず、書き換えない', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, 'ただのメモ.md'), '# 日記\n- 今日のこと\n');
  const sync = createNotesSync({ dir });
  const lib = sample();
  const r = await sync.sync(lib);
  assert.equal(r.skipped, 1);
  assert.equal(r.added, 0);
  assert.equal(await readFile(path.join(dir, 'ただのメモ.md'), 'utf8'), '# 日記\n- 今日のこと\n');
});

test('同じ名前の別の本のファイルは上書きしない', async () => {
  const dir = await tmp();
  await writeFile(path.join(dir, '本B.md'), `---\nbookId: ${bookIdFor('別の本')}\n---\n- 別の本の点\n`);
  const sync = createNotesSync({ dir });
  const lib = sample();
  await sync.sync(lib);
  assert.match(await readFile(path.join(dir, '本B.md'), 'utf8'), /別の本の点/);
});

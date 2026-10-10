// NIH-75 Play ブックスで最後に新しい点が届いた時刻・件数を state.json に残し、bh serve を再起動しても取り込み画面に出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { startDriveWatcher } from '../cli/google.js';
import { createCompanionServer } from '../cli/server.js';
import { emptyLibrary } from '../web/core/model.js';

const result = (r) => ({ checked: 1, changed: 0, added: 0, updated: 0, booksAdded: 0, errors: [], problems: [], ...r });

/** 1 回確認させて止める（state.json への書き込みは確認の中で待つので、checking が false になれば終わっている） */
async function watchOnce(store, r, log = () => {}) {
  const drive = startDriveWatcher({ store, client: { sync: async () => result(r) }, log });
  for (let i = 0; i < 500 && (!drive.status.lastCheck || drive.status.checking); i++) await new Promise((res) => setTimeout(res, 10));
  drive.stop();
  assert.ok(drive.status.lastCheck && !drive.status.checking, '確認が終わっている');
  return drive;
}

test('NIH-75: 新しい点・更新があったら、時刻と件数を state.json に残す（ほかの記録は消さない）', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-lastnew-')));
  await store.saveState({ kindleSync: { lastNew: { at: '2026-10-01T00:00:00.000Z', added: 2 } } });
  await watchOnce(store, { changed: 1, added: 3, updated: 1 });
  const st = await store.state();
  assert.equal(st.playbooksSync.lastNew.added, 3);
  assert.equal(st.playbooksSync.lastNew.updated, 1);
  assert.ok(!Number.isNaN(new Date(st.playbooksSync.lastNew.at).getTime()));
  assert.deepEqual(st.kindleSync, { lastNew: { at: '2026-10-01T00:00:00.000Z', added: 2 } }, 'Kindle の記録は残す');
});

test('NIH-75: 新しい点が無い確認では、前回の記録を書き換えない', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-lastnew-')));
  const prev = { lastNew: { at: '2026-10-01T00:00:00.000Z', added: 5, updated: 0 } };
  await store.saveState({ playbooksSync: prev });
  await watchOnce(store, { changed: 1, added: 0, updated: 0 });
  assert.deepEqual((await store.state()).playbooksSync, prev);
});

test('NIH-75: 記録を残すのは順番待ち（lock）の中で行い、ほかの書き手が書いた記録を消さない', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-lastnew-')));
  let release;
  // ほかの書き手（Kindle の報告など）が lock を持っている間に、見張り役が新しい点を取り込む
  const other = store.lock(async () => {
    await new Promise((res) => (release = res));
    const st = await store.state();
    await store.saveState({ ...st, kindleSync: { lastNew: { at: '2026-10-02T00:00:00.000Z', added: 1 } } });
  });
  const drive = startDriveWatcher({ store, client: { sync: async () => result({ changed: 1, added: 2 }) }, log: () => {} });
  try {
    for (let i = 0; i < 500 && !drive.status.lastCheck; i++) await new Promise((res) => setTimeout(res, 10));
    assert.ok(drive.status.checking, 'lock が空くまで記録を待っている');
  } finally {
    release();
    await other;
    for (let i = 0; i < 500 && drive.status.checking; i++) await new Promise((res) => setTimeout(res, 10));
    drive.stop();
  }
  const st = await store.state();
  assert.equal(st.playbooksSync.lastNew.added, 2);
  assert.equal(st.kindleSync.lastNew.added, 1);
});

test('NIH-75: 記録を残せなくても、見張りは止めずにログに理由を出す', async () => {
  const base = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-lastnew-')));
  const store = { ...base, saveState: async () => { throw new Error('disk full'); } };
  const logs = [];
  const drive = await watchOnce(store, { changed: 1, added: 2 }, (m) => logs.push(m));
  assert.equal(drive.status.error, '');
  assert.equal(drive.status.lastImport, drive.status.lastCheck);
  assert.ok(logs.some((m) => m.includes('記録を残せませんでした') && m.includes('disk full')));
});

test('NIH-75: bh serve を起動し直しても、/api/info の google.lastNew で前回の記録を返す', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-lastnew-')));
  await store.saveState({ playbooksSync: { lastNew: { at: '2026-10-01T00:00:00.000Z', added: 5, updated: 2 } } });
  // 起動し直した直後: 見張り役はまだ何も取り込んでいない
  const drive = await watchOnce(store, { added: 0 });
  const server = createCompanionServer({ store, log: () => {}, drive });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const info = await (await fetch(`http://127.0.0.1:${server.address().port}/api/info`)).json();
    assert.deepEqual(info.google.lastNew, { at: '2026-10-01T00:00:00.000Z', added: 5, updated: 2 });
  } finally {
    server.close();
  }
});

test('NIH-75: 取り込み画面の Play ブックス欄に「最後に新しい点」を出す（まだなら「まだ届いていません」）', async () => {
  const { playbooksSyncBlock } = await import('../web/js/views/settings.js');
  const state = (google) => ({ library: emptyLibrary(), settings: { ai: { mode: 'companion' } }, pcInfo: { google } });
  const base = { active: true, lastCheck: '2026-10-10T00:00:00.000Z', error: '', problems: [] };
  const withNew = String(playbooksSyncBlock(state({ ...base, lastNew: { at: '2026-10-01T03:00:00.000Z', added: 5, updated: 2 } })));
  assert.match(withNew, /最後に新しい点: \S+.*・5 件（更新 2 件）/);
  assert.doesNotMatch(withNew, /この起動のあと/);
  const onlyUpdated = String(playbooksSyncBlock(state({ ...base, lastNew: { at: '2026-10-01T03:00:00.000Z', added: 0, updated: 4 } })));
  assert.match(onlyUpdated, /最後に新しい点: \S+.*・0 件（更新 4 件）/);
  assert.match(String(playbooksSyncBlock(state({ ...base, lastNew: null }))), /最後に新しい点: まだ届いていません/);
});

// #71 Play ブックスの自動取り込みで、取り込めなかった文書の理由が分かり、画面に出続ける
// 実データで見つかった原因: Play ブックスが本によってはハイライトの文を書き出さず「ハイライト表示したテキストを表示できません」とだけ書く。
// それを「ハイライトが見つからない HTML です（Kindle のエクスポートか…を選んでください）」と出し、次の確認で画面から消えていた
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createGoogleClient, startDriveWatcher } from '../cli/google.js';
import { parseFiles } from '../web/core/parsers/index.js';
import { parsePlayBooksHtml } from '../web/core/parsers/playbooks.js';
import { emptyLibrary } from '../web/core/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLAYBOOKS_HTML = readFileSync(path.join(ROOT, 'test/fixtures/playbooks-ja.html'), 'utf8');
const HIDDEN = 'ハイライト表示したテキストを表示できません';

/** 同じ文書で、Play ブックスが文を書き出さなかった版（注釈の本文がすべて「表示できません」） */
function hiddenHtml() {
  let html = PLAYBOOKS_HTML;
  const [book] = parsePlayBooksHtml(PLAYBOOKS_HTML, '');
  for (const h of book.highlights) {
    html = html.replaceAll(h.text, HIDDEN);
    if (h.note) html = html.replaceAll(h.note, '');
  }
  return { html, count: book.highlights.length };
}

/** 注釈が 1 件も無い Play ブックスの文書（線を全部消した本など） */
const EMPTY_DOC = '<html><head><title>「空の本」のメモ</title></head><body><table><tr><td><h1>空の本</h1><p>出版社</p></td></tr></table><table><tr><td><p>Play ブックスで変更を加えると、このドキュメントは上書きされます。</p></td></tr></table></body></html>';

test('#71: 文を書き出していない文書は、その理由をエラーにする（Kindle のファイルを選べという案内は出さない）', async () => {
  const { html, count } = hiddenHtml();
  const { results } = await parseFiles([{ name: '「深い集中」のメモ.html', bytes: new TextEncoder().encode(html) }]);
  assert.match(results[0].error, /Play ブックスがこの本のハイライトの文を書き出していません/);
  assert.ok(count > 0);
  assert.match(results[0].error, /出版社の設定で文を表示できない本/);
  assert.doesNotMatch(results[0].error, /Kindle のエクスポート/);
});

test('#71: 注釈が 1 件も無い Play ブックスの文書は失敗にしない（点 0 件として読む）', async () => {
  const { results, books } = await parseFiles([{ name: '「空の本」のメモ.html', bytes: new TextEncoder().encode(EMPTY_DOC) }]);
  assert.equal(results[0].error, '');
  assert.equal(books.length, 0);
});

const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

function fakeDrive(docs) {
  return async (url) => {
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at-1', expires_in: 3599 });
    if (u.pathname === '/drive/v3/files') {
      if (u.searchParams.get('q').includes('vnd.google-apps.folder')) return json({ files: [{ id: 'f1', name: 'Play ブックスのメモ' }] });
      return json({ files: docs.map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime })) });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/export$/);
    return new Response(docs.find((d) => d.id === m[1]).body, { headers: { 'Content-Type': 'text/html' } });
  };
}

async function setup(docs) {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-pb-problems-')));
  await store.saveConfig({ google: { clientId: 'cid', clientSecret: 'secret' } });
  await store.saveGoogleToken({ refreshToken: 'rt-1' });
  return { store, client: createGoogleClient({ store, fetchImpl: fakeDrive(docs) }) };
}

test('#71: 取り込めなかった文書は記録に残り、変わっていない次の確認でも problems に出続ける。文が出たら消える', async () => {
  const { html } = hiddenHtml();
  const docs = [
    { id: 'd1', name: '「深い集中」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: html },
    { id: 'd2', name: '「空の本」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: EMPTY_DOC },
  ];
  const { store, client } = await setup(docs);
  const first = await client.sync();
  assert.equal(first.errors.length, 1);
  assert.deepEqual(first.problems.map((p) => p.name), ['「深い集中」のメモ'], '空の文書は問題にしない');
  assert.match(first.problems[0].error, /文を書き出していません/);
  assert.equal(first.problems[0].modifiedTime, '2026-10-01T00:00:00.000Z');
  assert.ok((await store.googleSync()).problems.d1, 'PC の記録に残る（再起動しても消えない）');

  const second = await client.sync();
  assert.equal(second.changed, 0);
  assert.equal(second.errors.length, 0, '同じエラーを毎回出し直さない');
  assert.equal(second.problems.length, 1, 'それでも取り込めていないことは出し続ける');

  // Play ブックスが文を書き出すようになった（本が更新された）
  docs[0] = { ...docs[0], modifiedTime: '2026-10-02T00:00:00.000Z', body: PLAYBOOKS_HTML };
  const third = await client.sync();
  assert.ok(third.added > 0);
  assert.equal(third.problems.length, 0);
  assert.equal((await store.googleSync()).problems.d1, undefined);

  // ドライブから消えた文書の記録も消える
  docs[0] = { ...docs[0], modifiedTime: '2026-10-03T00:00:00.000Z', body: html };
  assert.equal((await client.sync()).problems.length, 1);
  docs.splice(0, 1);
  assert.equal((await client.sync()).problems.length, 0);
});

test('#71: 修正前の記録（版 2・problems なし）で失敗して記録済みの文書も、一度だけ読み直して problems に載る', async () => {
  const { html } = hiddenHtml();
  const docs = [
    { id: 'd1', name: '「深い集中」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: html },
    { id: 'd2', name: '「空の本」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: EMPTY_DOC },
  ];
  const { store, client } = await setup(docs);
  // 修正前の bh serve が残した記録: 失敗した文書も modifiedTime を記録済みで、problems は無い
  await store.saveGoogleSync({ version: 2, files: { d1: '2026-10-01T00:00:00.000Z', d2: '2026-10-01T00:00:00.000Z' } });
  const r = await client.sync();
  assert.equal(r.changed, 2, '変わっていない文書も一度だけ読み直す');
  assert.deepEqual(r.problems.map((p) => p.name), ['「深い集中」のメモ']);
  const again = await client.sync();
  assert.equal(again.changed, 0, '読み直しは一度だけ');
  assert.equal(again.problems.length, 1);
});

test('#71: ドライブの一覧が一時的に空で返っても、取り込めない文書の記録は消さずに出し続ける', async () => {
  const { html } = hiddenHtml();
  const docs = [{ id: 'd1', name: '「深い集中」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: html }];
  const { store, client } = await setup(docs);
  await client.sync();
  docs.length = 0;
  assert.equal((await client.sync()).problems.length, 1);
  assert.ok((await store.googleSync()).problems.d1);
});

test('#71: bh serve の見張りの状態に、取り込めない文書の一覧が残る（エラーは次の確認で消えても）', async () => {
  const { html } = hiddenHtml();
  const { store, client } = await setup([{ id: 'd1', name: '「深い集中」のメモ', modifiedTime: '2026-10-01T00:00:00.000Z', body: html }]);
  const logs = [];
  const w = startDriveWatcher({ store, client, log: (m) => logs.push(m) });
  try {
    for (let i = 0; i < 50 && !w.status.lastCheck; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.status.problems.length, 1);
    assert.match(logs.join('\n'), /文を書き出していません/);
  } finally {
    w.stop();
  }
});

test('#71: 取り込み画面の Play ブックス欄に、自動取り込みの状態と取り込めない本が出る（書名はエスケープ）', async () => {
  const { playbooksSyncBlock } = await import('../web/js/views/settings.js');
  const state = (google) => ({ library: emptyLibrary(), settings: { ai: { mode: 'companion' } }, pcInfo: { google } });
  const out = String(playbooksSyncBlock(state({ active: true, lastCheck: '2026-10-10T00:00:00.000Z', lastImport: null, error: '', problems: [{ name: '「<b>深い集中</b>」のメモ', error: 'Play ブックスがこの本のハイライトの文を書き出していません（3 件）', modifiedTime: '2026-10-01T00:00:00.000Z' }] })));
  assert.match(out, /自動取り込み: 有効/);
  assert.match(out, /取り込めない本 1 冊/);
  assert.match(out, /&lt;b&gt;深い集中&lt;\/b&gt;/);
  assert.match(out, /文を書き出していません（3 件）/);
  assert.equal(String(playbooksSyncBlock(state({ active: false, error: 'Google にログインしていません', problems: [] }))).includes('Google にログインしていません'), true);
  assert.equal(String(playbooksSyncBlock({ settings: { ai: { mode: 'direct' } }, pcInfo: null })), '', 'PC を使わないときは出さない');
  // 取り込み画面に欄があり、PC の情報を取り直したら差し替わる
  const { importView } = await import('../web/js/views/settings.js');
  assert.match(String(importView.render({ state: state({ active: true, problems: [] }) })), /<div id="playbooks-sync">/);
  const { kindleSyncBlock } = await import('../web/js/views/settings.js');
  const { PC_INFO_BOXES } = await import('../web/js/routes.js');
  assert.deepEqual(PC_INFO_BOXES['/import'], [['#kindle-sync', kindleSyncBlock], ['#playbooks-sync', playbooksSyncBlock]]);
});

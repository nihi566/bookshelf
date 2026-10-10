// NIH-67: Play ブックス（Google ドライブ）の自動取り込みが失敗しているとき、ホームの先頭（Kindle・分析の警告と同じ欄）に 1 行の警告を出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { createGoogleClient, startDriveWatcher } from '../cli/google.js';
import { emptyLibrary } from '../web/core/model.js';

const expired = { active: false, configured: true, lastCheck: '2026-10-10T03:00:00.000Z', lastImport: null, error: 'Google のログインが無効になりました（Token has been expired or revoked.）。bh google login でログインし直してください <script>', problemCount: 0, problems: [] };
const st = (google, { mode = 'companion' } = {}) => ({
  library: emptyLibrary(),
  analysis: null,
  settings: { ai: { mode, companionUrl: '' } },
  servedByCompanion: true,
  job: null,
  pcInfo: google === undefined ? null : { google },
});

test('NIH-67: 設定済みの自動取り込みが失敗しているとき、理由を 1 行で出す', async () => {
  const { playbooksSyncAlert } = await import('../web/js/ui.js');
  assert.equal(playbooksSyncAlert(expired), `Play ブックスの自動取り込みに失敗しています（${expired.error.slice(0, 80)}…）`);
  assert.equal(playbooksSyncAlert({ ...expired, error: 'ドキュメント A を書き出せません' }), 'Play ブックスの自動取り込みに失敗しています（ドキュメント A を書き出せません）');
  // 見張りは動いているが、一部のドキュメントの書き出しに失敗した
  assert.match(playbooksSyncAlert({ ...expired, active: true, error: 'x' }), /^Play ブックスの自動取り込みに失敗しています（x）$/);
});

test('NIH-67: 取り込めたら消える・未設定（未ログイン）・古い bh・取り込めない本だけのときは出さない', async () => {
  const { playbooksSyncAlert } = await import('../web/js/ui.js');
  assert.equal(playbooksSyncAlert({ ...expired, active: true, error: '' }), '', '次の確認で取り込めた');
  assert.equal(playbooksSyncAlert({ ...expired, configured: false, error: 'Google にログインしていません（bh google login）' }), '');
  assert.equal(playbooksSyncAlert({ ...expired, configured: undefined }), '', 'configured を返さない古い bh では誤報を出さない');
  assert.equal(playbooksSyncAlert({ ...expired, active: true, error: '', problemCount: 3 }), '', '取り込めない本は取り込みの画面にだけ出す');
  assert.equal(playbooksSyncAlert(null), '');
  assert.equal(playbooksSyncAlert(undefined), '');
});

test('NIH-67: ホームの警告欄に出し、押すと取り込みの画面へ。PC を使わないとき・google が null のときは出さない', async () => {
  const { homeAlertBlock } = await import('../web/js/ui.js');
  const out = String(homeAlertBlock(st(expired)));
  assert.match(out, /^<a class="notice err" href="#\/import"[^>]*>Play ブックスの自動取り込みに失敗しています（Google のログインが無効になりました[^<]*）（詳しく）<\/a>$/);
  assert.doesNotMatch(out, /<script>/);
  assert.equal(String(homeAlertBlock(st(expired, { mode: 'direct' }))), '');
  assert.equal(String(homeAlertBlock(st(null))), '');
  assert.equal(String(homeAlertBlock(st(undefined))), '');
  // Kindle → Play ブックス → 分析の順に同じ欄に並ぶ
  const all = String(
    homeAlertBlock({
      ...st(expired),
      pcInfo: {
        google: expired,
        kindleSync: { enabled: true, lastCheck: { at: '2026-10-10T03:00:00.000Z', ok: false, needLogin: true } },
        autoAnalysis: { enabled: true, lastError: 'LLM に接続できません', lastErrorAt: '2026-10-10T03:04:00.000Z', failureCount: 1 },
      },
    }),
  );
  assert.match(all, /href="#\/import"[^>]*>(?!Play)[\s\S]*href="#\/import"[^>]*>Play ブックス[\s\S]*href="#\/knowledge"/);
});

/** トークンの更新を invalid_grant で断る Google の偽物（ログインの期限切れ） */
async function expiredGoogle() {
  const server = createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function watch(store, client) {
  const drive = startDriveWatcher({ store, client, log: () => {} });
  for (let i = 0; i < 50 && drive.status.checking; i++) await new Promise((r) => setTimeout(r, 20));
  drive.stop();
  return drive.status;
}

test('NIH-67: 見張り役は、まだ設定していない（クライアント ID・ログインが無い）ときだけ configured を false にする', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'bh-pb-alert-')));
  // ログインしていない
  let s = await watch(store, createGoogleClient({ store }));
  assert.match(s.error, /ログインしていません/);
  assert.equal(s.configured, false);
  // トークンはあるがクライアント ID が無い
  await store.saveGoogleToken({ refreshToken: 'old' });
  s = await watch(store, createGoogleClient({ store }));
  assert.match(s.error, /クライアント ID が未設定/);
  assert.equal(s.configured, false);
  // ログインしたが期限が切れた
  const cfg = await store.config();
  await store.saveConfig({ ...cfg, google: { ...cfg.google, clientId: 'cid', clientSecret: 'sec' } });
  const fake = await expiredGoogle();
  const fetchImpl = (url, init) => (String(url).startsWith('https://oauth2.googleapis.com/') ? fetch(`http://127.0.0.1:${fake.address().port}/`, init) : fetch(url, init));
  try {
    s = await watch(store, createGoogleClient({ store, fetchImpl }));
  } finally {
    fake.close();
  }
  assert.match(s.error, /ログインが無効になりました/);
  assert.equal(s.configured, true);
  // 取り込めた
  s = await watch(store, { sync: async () => ({ checked: 1, changed: 0, added: 0, updated: 0, errors: [] }) });
  assert.equal(s.error, '');
  assert.equal(s.configured, true);
});

test('NIH-67: /api/info の google に configured を載せる', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'bh-pb-alert-')));
  const drive = { status: { active: false, configured: true, checking: false, lastCheck: null, lastImport: null, error: 'x', problems: [] } };
  const server = createCompanionServer({ store, log: () => {}, drive });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const info = await (await fetch(`http://127.0.0.1:${server.address().port}/api/info`)).json();
    assert.equal(info.google.configured, true);
    assert.equal(info.google.error, 'x');
  } finally {
    server.close();
  }
});

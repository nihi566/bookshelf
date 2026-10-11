// NIH-146: PC との同期に失敗したら、設定の「今すぐ同期」の横に最後の失敗の時刻と理由を残し、次に成功したら消す
// 同期の結果の覚え方（recordSyncResult）・表示（syncStatus）・描き直さない差し替え（applySyncStatus）を確かめる。
// app.js の runSync はこれを呼ぶだけ（app.js を文字列で読むテストは増やさない決まり〔app-source-reads.test.js〕）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySyncStatus, recordSyncResult, syncStatus } from '../web/js/sync-busy.js';
import { emptyLibrary } from '../web/core/model.js';

const AT = new Date('2026-10-11T03:04:00.000Z');
const hhmm = (d) => d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

test('recordSyncResult: 失敗で時刻と理由を覚え、成功で消す', () => {
  const state = { lastSyncError: null };
  recordSyncResult(state, new Error('PC に接続できません'), AT);
  assert.deepEqual(state.lastSyncError, { at: AT.toISOString(), message: 'PC に接続できません' });
  recordSyncResult(state, null);
  assert.equal(state.lastSyncError, null);
});

test('recordSyncResult: メッセージの無い失敗も、理由が空のままにならない', () => {
  const state = {};
  recordSyncResult(state, new Error(''), AT);
  assert.ok(state.lastSyncError.message.length > 0);
});

test('syncStatus: 失敗していなければ最終の同期だけ、失敗していれば失敗の時刻と理由も出す', () => {
  const ok = String(syncStatus({ lastSync: AT.toISOString(), lastSyncError: null }));
  assert.match(ok, /data-sync-status/);
  assert.match(ok, new RegExp(`最終: 2026-10-11 ${hhmm(AT)}`));
  assert.doesNotMatch(ok, /失敗/);
  assert.match(String(syncStatus({ lastSync: null, lastSyncError: null })), /未同期/);

  const failedAt = new Date('2026-10-11T05:30:00.000Z');
  const ng = String(syncStatus({ lastSync: AT.toISOString(), lastSyncError: { at: failedAt.toISOString(), message: 'PC に接続できません' } }));
  assert.match(ng, new RegExp(`最終: 2026-10-11 ${hhmm(AT)}`), '最後に成功した同期も残す');
  assert.match(ng, new RegExp(`失敗: 2026-10-11 ${hhmm(failedAt)}`));
  assert.match(ng, /PC に接続できません/);
});

test('syncStatus: 失敗より後に成功した同期があれば（記録を通らない同期でも）失敗は出さない', () => {
  const failedAt = new Date('2026-10-11T05:30:00.000Z');
  const err = { at: failedAt.toISOString(), message: 'PC に接続できません' };
  assert.doesNotMatch(String(syncStatus({ lastSync: '2026-10-11T05:35:00.000Z', lastSyncError: err })), /失敗/);
  assert.match(String(syncStatus({ lastSync: '2026-10-11T05:00:00.000Z', lastSyncError: err })), /失敗/);
  assert.match(String(syncStatus({ lastSync: null, lastSyncError: err })), /未同期[\s\S]*失敗/);
});

test('syncStatus: 理由の文字はそのまま HTML にしない', () => {
  const out = String(syncStatus({ lastSync: null, lastSyncError: { at: AT.toISOString(), message: '<img src=x onerror=alert(1)>' } }));
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img/);
});

test('applySyncStatus: 画面にある同期の表示を、描き直さずに今の状態へ差し替える', () => {
  const box = { outerHTML: '<span data-sync-status>最終: 古い</span>' };
  const root = { querySelectorAll: (sel) => (sel === '[data-sync-status]' ? [box] : []) };
  applySyncStatus(root, { lastSync: null, lastSyncError: { at: AT.toISOString(), message: 'PC 側でエラー' } });
  assert.match(box.outerHTML, /PC 側でエラー/);
});

test('設定の「今すぐ同期」の横に、最後の失敗の時刻と理由が出る（成功したら出ない）', async () => {
  const { settingsView } = await import('../web/js/views/settings.js');
  globalThis.location ??= { origin: 'http://localhost:8787' };
  const base = { library: emptyLibrary(), analysis: null, settings: { ai: { mode: 'companion', companionUrl: '', provider: 'ollama', baseUrl: '', chatModel: '', embedModel: '' }, autoSync: true }, lastSync: null, pcInfo: null, syncing: 0 };
  const failed = String(settingsView.render({ state: { ...base, lastSyncError: { at: AT.toISOString(), message: 'PC に接続できません' } } }));
  assert.match(failed, /今すぐ同期<\/button>[\s\S]*失敗: 2026-10-11[\s\S]*PC に接続できません/);
  const ok = String(settingsView.render({ state: { ...base, lastSyncError: null } }));
  assert.doesNotMatch(ok, /失敗:/);
});

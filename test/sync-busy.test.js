// NIH-141: 同期している間は「同期する」「今すぐ同期」を押せなくし、「同期しています」と出す
// 同期の数え方（trackSync）・画面にあるボタンの差し替え（applySyncBusy）・ボタンの描き方（syncButton）を確かめる。
// app.js の sync() はこの trackSync で包むだけ（app.js を文字列で読むテストは増やさない決まり〔app-source-reads.test.js〕）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_BUSY_LABEL, applySyncBusy, isSyncing, syncButton, trackSync } from '../web/js/sync-busy.js';
import { emptyLibrary } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';

// 画面のボタンの代わり（disabled・textContent・dataset だけを持つ）
const fakeButton = (label) => ({ disabled: false, textContent: label, dataset: { action: 'sync', label }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
const fakeRoot = (buttons) => ({ querySelectorAll: (sel) => (sel === '[data-action="sync"]' ? buttons : []) });

test('syncButton: 同期していなければ押せるボタン、同期中は押せず「同期しています」', () => {
  const idle = String(syncButton({ syncing: 0 }, '今すぐ同期', 'btn'));
  assert.match(idle, /<button[^>]*data-action="sync"[^>]*>今すぐ同期<\/button>/);
  assert.doesNotMatch(idle, /disabled/);
  const busy = String(syncButton({ syncing: 1 }, '今すぐ同期', 'btn'));
  assert.match(busy, /<button[^>]*data-action="sync"[^>]*disabled[^>]*>同期しています<\/button>/);
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /data-label="今すぐ同期"/, '終わったら元の文字に戻すため、元の文字を持っておく');
});

test('trackSync: 走っている間だけ同期中になり、ボタンを押せなくする（成功）', async () => {
  const state = {};
  const btn = fakeButton('同期する');
  let release;
  const running = trackSync(state, () => new Promise((r) => (release = r)), () => applySyncBusy(fakeRoot([btn]), isSyncing(state)));
  assert.equal(isSyncing(state), true);
  assert.deepEqual([btn.disabled, btn.textContent, btn.attrs['aria-busy']], [true, SYNC_BUSY_LABEL, 'true']);
  release('ok');
  assert.equal(await running, 'ok', '同期の結果はそのまま返す');
  assert.equal(isSyncing(state), false);
  assert.deepEqual([btn.disabled, btn.textContent, btn.attrs['aria-busy']], [false, '同期する', undefined], '元に戻る');
});

test('trackSync: 同期が失敗しても、ボタンは元に戻り、失敗はそのまま伝わる', async () => {
  const state = {};
  const btn = fakeButton('今すぐ同期');
  const onChange = () => applySyncBusy(fakeRoot([btn]), isSyncing(state));
  await assert.rejects(trackSync(state, async () => { throw new Error('PC に届きません'); }, onChange), /PC に届きません/);
  assert.equal(isSyncing(state), false);
  assert.deepEqual([btn.disabled, btn.textContent], [false, '今すぐ同期']);
});

test('trackSync: 重なった同期（自動同期と押した同期）は、最後の 1 つが終わるまで同期中のまま', async () => {
  const state = {};
  let a, b;
  const first = trackSync(state, () => new Promise((r) => (a = r)), () => {});
  const second = trackSync(state, () => new Promise((r) => (b = r)), () => {});
  a();
  await first;
  assert.equal(isSyncing(state), true, '1 つ目が終わっても、2 つ目が走っている');
  b();
  await second;
  assert.equal(isSyncing(state), false);
});

test('受け箱の「同期する」も、同期中は押せず「同期しています」で描く', async () => {
  const { inboxBlock } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  addThought(lib, { text: '思いつき' }, '2026-10-02T00:00:00.000Z');
  const state = { library: lib, analysis: null, settings: { ai: { mode: 'companion', companionUrl: '' } }, servedByCompanion: true, companionOriginChecked: true, lastSync: '2026-10-01T00:00:00.000Z', pcInfo: null, syncing: 1 };
  assert.match(String(inboxBlock(state)), /<button[^>]*data-action="sync"[^>]*disabled[^>]*>同期しています<\/button>/);
});

test('設定の「今すぐ同期」も、同期中は押せず「同期しています」で描く', async () => {
  const { settingsView } = await import('../web/js/views/settings.js');
  globalThis.location ??= { origin: 'http://localhost:8787' };
  const state = { library: emptyLibrary(), analysis: null, settings: { ai: { mode: 'companion', companionUrl: '', provider: 'ollama', baseUrl: '', chatModel: '', embedModel: '' }, autoSync: true }, lastSync: null, pcInfo: null, syncing: 1 };
  const out = String(settingsView.render({ state }));
  assert.match(out, /<button[^>]*data-action="sync"[^>]*disabled[^>]*>同期しています<\/button>/);
  const idle = String(settingsView.render({ state: { ...state, syncing: 0 } }));
  assert.match(idle, /<button[^>]*data-action="sync"[^>]*>今すぐ同期<\/button>/);
});

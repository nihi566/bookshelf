// NIH-162: 自動の分析の入切・条件（件数・時間）を、Web アプリの知識の画面からも変えられるようにする
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { parseAutoSettings } from '../web/core/auto-analysis.js';
import { emptyLibrary } from '../web/core/model.js';
import { button, fakeApp, formData } from './helpers/app-actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('NIH-162: parseAutoSettings は bh config と同じ範囲で確かめ、送られた項目だけを返す', () => {
  assert.deepEqual(parseAutoSettings({ enabled: false }), { ok: true, value: { enabled: false } });
  assert.deepEqual(parseAutoSettings({ enabled: true, minPoints: 20, maxHours: 12 }), { ok: true, value: { enabled: true, minPoints: 20, maxHours: 12 } });
  // 画面のフォームから来る文字の数も読む
  assert.deepEqual(parseAutoSettings({ minPoints: '5', maxHours: '0.5' }), { ok: true, value: { minPoints: 5, maxHours: 0.5 } });
  for (const bad of [{ minPoints: 0 }, { minPoints: 1.5 }, { minPoints: '' }, { minPoints: null }, { minPoints: 'abc' }]) {
    const r = parseAutoSettings(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /件数は 1 以上の整数/);
  }
  for (const bad of [{ maxHours: 0 }, { maxHours: -1 }, { maxHours: 'Infinity' }, { maxHours: '' }]) {
    const r = parseAutoSettings(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /時間は 0 より大きい数/);
  }
  assert.match(parseAutoSettings({ enabled: 'off' }).error, /入切は true か false/);
  assert.match(parseAutoSettings({}).error, /変える項目がありません/);
  assert.match(parseAutoSettings(null).error, /変える項目がありません/);
  assert.match(parseAutoSettings([]).error, /変える項目がありません/);
});

async function withServer(fn) {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-autocfg-')));
  await store.saveConfig({ token: 'tok', llm: { baseUrl: 'http://127.0.0.1:9', chatModel: 'fake-chat', embedModel: 'fake-embed' }, autoAnalyze: { enabled: true, minPoints: 10, maxHours: 24 } });
  const server = createCompanionServer({ store, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (body, token = 'tok') => fetch(`${base}/api/config/auto`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-BH-Token': token }, body: JSON.stringify(body) });
  try {
    await fn({ store, base, put });
  } finally {
    server.close();
  }
}

test('NIH-162: PUT /api/config/auto で入切・件数・時間を変え、/api/info と同じ形の autoAnalysis（次の分析の一文を含む）が返る', async () => {
  await withServer(async ({ store, put }) => {
    const lib = emptyLibrary();
    lib.books.b1 = { id: 'b1', title: '本', author: '著者', source: 'kindle' };
    for (let i = 0; i < 6; i++) lib.highlights[`h${i}`] = { id: `h${i}`, bookId: 'b1', text: `線 ${i}`, createdAt: '2026-10-01T00:00:00.000Z' };
    await store.saveLibrary(lib);
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    await store.saveAnalysis({ version: 2, createdAt, lines: [{ highlightIds: ['h0', 'h1', 'h2', 'h3'] }], planes: [], isolated: [], stats: {} });

    const res = await put({ minPoints: 5, maxHours: 2 });
    assert.equal(res.status, 200);
    const { autoAnalysis } = await res.json();
    assert.equal(autoAnalysis.enabled, true);
    assert.equal(autoAnalysis.minPoints, 5);
    assert.equal(autoAnalysis.maxHours, 2);
    assert.equal(autoAnalysis.pending, 2);
    assert.equal(autoAnalysis.next.reason, 'あと 3 件増える・減るか、前回から 2 時間たつと分析します');
    // 保存され、ほかの設定は消えない
    const cfg = await store.config();
    assert.deepEqual(cfg.autoAnalyze, { enabled: true, minPoints: 5, maxHours: 2 });
    assert.equal(cfg.token, 'tok');
    assert.equal(cfg.llm.chatModel, 'fake-chat');

    const off = await (await put({ enabled: false })).json();
    assert.equal(off.autoAnalysis.enabled, false);
    assert.equal(off.autoAnalysis.minPoints, 5, '送らなかった項目は変えない');
    assert.equal(off.autoAnalysis.next.reason, '自動の分析は切ってあります');
  });
});

test('NIH-162: 範囲外の値・トークン違いは断り、設定を変えない', async () => {
  await withServer(async ({ store, put }) => {
    const bad = await put({ minPoints: 0, maxHours: 3 });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /件数は 1 以上の整数/);
    assert.equal((await put({ maxHours: 3 }, 'wrong')).status, 401);
    assert.deepEqual((await store.config()).autoAnalyze, { enabled: true, minPoints: 10, maxHours: 24 });
  });
});

test('NIH-162: bh config auto-points / auto-hours も同じ確かめ方を使う', () => {
  const src = readFileSync(path.join(ROOT, 'cli', 'bh.js'), 'utf8');
  assert.match(src, /parseAutoSettings/);
});

const st = (autoAnalysis, mode = 'companion') => ({ library: emptyLibrary(), analysis: null, settings: { ai: { mode, companionUrl: '' } }, servedByCompanion: true, pcInfo: autoAnalysis ? { autoAnalysis } : null });
const AU = { enabled: true, minPoints: 10, maxHours: 24, pending: 1, next: { due: false, reason: 'あと 9 件増える・減るか、前回から 24 時間たつと分析します', nextAt: null } };

test('NIH-162: 知識の画面の自動の分析の欄に「条件を変える」のフォームが出る（今の値が入っている）', async () => {
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  const out = String(autoStatusBlock(st(AU)));
  assert.match(out, /<details[^>]*><summary[^>]*>条件を変える<\/summary>/);
  assert.match(out, /<form[^>]*data-form="auto-config"/);
  assert.match(out, /<input type="checkbox" name="enabled" value="1" checked>/);
  assert.match(out, /name="minPoints"[^>]*min="1"[^>]*step="1"[^>]*value="10"/);
  assert.match(out, /name="maxHours"[^>]*value="24"/);
  const off = String(autoStatusBlock(st({ ...AU, enabled: false })));
  assert.match(off, /<input type="checkbox" name="enabled" value="1" >/);
  assert.match(off, /「条件を変える」で入れられます/);
});

test('NIH-162: PC の情報が無いとき・PC のコンパニオンを使わないときは、フォームを出さない', async () => {
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  assert.doesNotMatch(String(autoStatusBlock(st(null))), /auto-config/);
  assert.doesNotMatch(String(autoStatusBlock(st(AU, 'direct'))), /auto-config/);
});

test('NIH-162: 保存は PC に送り、返ってきた autoAnalysis で PC の情報を差し替えて描き直す（次の分析の一文がその場で変わる）', async () => {
  const state = { pcInfo: { stats: { points: 6 }, autoAnalysis: AU } };
  const sent = [];
  const back = { ...AU, minPoints: 5, next: { due: false, reason: 'あと 4 件増える・減るか、前回から 24 時間たつと分析します', nextAt: null } };
  const app = fakeApp(state, { setAutoAnalysis: async (patch) => (sent.push(patch), { autoAnalysis: back }) });
  const btn = button({});
  await app.saveAutoConfig(formData({ enabled: '1', minPoints: '5', maxHours: '24' }), btn);
  assert.deepEqual(sent, [{ enabled: true, minPoints: '5', maxHours: '24' }]);
  assert.equal(state.pcInfo.autoAnalysis, back);
  assert.equal(state.pcInfo.stats.points, 6, 'ほかの PC の情報は残す');
  assert.equal(btn.disabled, false);
  assert.deepEqual(app.log, ['toast', 'render']);
  assert.equal(app.toasts[0].message, '自動の分析の条件を保存しました');
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  assert.match(String(autoStatusBlock({ ...st(null), pcInfo: state.pcInfo })), /次の自動の分析: あと 4 件増える・減るか/);
  // チェックを外して送ると切る
  await app.saveAutoConfig(formData({ minPoints: '5', maxHours: '24' }));
  assert.equal(sent[1].enabled, false);
});

test('NIH-162: PC に断られたら、PC の情報を変えずに理由を返す（ボタンは押せる状態に戻す）', async () => {
  const state = { pcInfo: { autoAnalysis: AU } };
  const app = fakeApp(state, { setAutoAnalysis: async () => Promise.reject(new Error('件数は 1 以上の整数を指定してください')) });
  const btn = button({});
  await assert.rejects(app.saveAutoConfig(formData({ enabled: '1', minPoints: '0', maxHours: '24' }), btn), /件数は 1 以上の整数/);
  assert.equal(state.pcInfo.autoAnalysis, AU);
  assert.equal(btn.disabled, false);
  assert.deepEqual(app.log, []);
});

test('NIH-162: services の setAutoAnalysis は PUT /api/config/auto に送る', async () => {
  const src = readFileSync(path.join(ROOT, 'web', 'js', 'services.js'), 'utf8');
  assert.match(src, /setAutoAnalysis: \(patch\) => call\('\/api\/config\/auto', \{ method: 'PUT', body: patch \}\)/);
});

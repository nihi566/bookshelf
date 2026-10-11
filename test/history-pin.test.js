// NIH-102: 分析の履歴で残しておきたい回に印を付け、直近 12 回の上限で消えないようにする
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HISTORY_KEEP, HISTORY_PIN_MAX } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
const idAt = (i) => at(i).replace(/[^0-9TZ]/g, '');
const analysisAt = (createdAt, extra = {}) => ({
  version: 2,
  createdAt,
  model: { chat: 'fake', embed: 'fake-embed' },
  stats: { points: 2, lines: 1, planes: 1, isolated: 0 },
  lines: [{ id: 'l1', name: '線', summary: '', keywords: [], highlightIds: ['a', 'b'] }],
  planes: [{ id: 'p1', name: '面', summary: '', lineIds: ['l1'] }],
  solid: { title: '核', core: '', relations: [], principles: [] },
  isolated: [],
  ...extra,
});
const tempStore = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bh-pin-'));
  return { dir, store: createStore(dir) };
};
const files = (dir) => readdirSync(path.join(dir, 'history')).filter((f) => f !== 'index.json').sort();

test('NIH-102: 印を付けた回は、直近 12 回の上限を超えて分析し直しても消えない', async () => {
  const { dir, store } = tempStore();
  await store.saveAnalysis(analysisAt(at(0)));
  const r = await store.setHistoryPin(idAt(0), true);
  assert.equal(r.ok, true);
  assert.equal(r.item.pinned, true);
  for (let i = 1; i <= HISTORY_KEEP + 3; i++) await store.saveAnalysis(analysisAt(at(i)));
  const index = await store.history();
  assert.equal(index.length, HISTORY_KEEP + 1, '直近 12 回 ＋ 印の付いた回');
  assert.equal(index.at(-1).id, idAt(0));
  assert.equal(index.at(-1).pinned, true);
  assert.equal(index.filter((h) => h.pinned).length, 1);
  assert.ok(files(dir).includes(`${idAt(0)}.json`), '中身のファイルも残る');
  assert.equal((await store.historyEntry(idAt(0))).createdAt, at(0));
  assert.equal(files(dir).length, HISTORY_KEEP + 1);
});

test('NIH-102: 印を外した回は、次の保存で通常どおり間引かれる', async () => {
  const { dir, store } = tempStore();
  await store.saveAnalysis(analysisAt(at(0)));
  await store.setHistoryPin(idAt(0), true);
  for (let i = 1; i <= HISTORY_KEEP; i++) await store.saveAnalysis(analysisAt(at(i)));
  const r = await store.setHistoryPin(idAt(0), false);
  assert.equal(r.ok, true);
  assert.equal(r.item.pinned, undefined, '外した回は印を持たない');
  assert.equal((await store.history()).length, HISTORY_KEEP + 1, '外しただけでは消さない（次の保存で消える）');
  await store.saveAnalysis(analysisAt(at(HISTORY_KEEP + 1)));
  const index = await store.history();
  assert.equal(index.length, HISTORY_KEEP);
  assert.ok(!index.some((h) => h.id === idAt(0)));
  assert.ok(!files(dir).includes(`${idAt(0)}.json`));
});

test('NIH-102: おすすめを選び直して同じ回を差し替えても、印は残る', async () => {
  const { store } = tempStore();
  await store.saveAnalysis(analysisAt(at(0)));
  await store.setHistoryPin(idAt(0), true);
  await store.saveAnalysis(analysisAt(at(0), { recommendedAt: at(5) }));
  const [h] = await store.history();
  assert.equal(h.recommendedAt, at(5));
  assert.equal(h.pinned, true);
});

test('NIH-102: 印の数には上限があり、超えると理由を返して付けない。無い回・形の違う ID は付けない', async () => {
  const { store } = tempStore();
  // 保存するたびに印を付ける（13 回目より前に付けないと、直近 12 回から外れて消える）
  for (let i = 0; i < HISTORY_PIN_MAX; i++) {
    await store.saveAnalysis(analysisAt(at(i)));
    assert.equal((await store.setHistoryPin(idAt(i), true)).ok, true);
  }
  await store.saveAnalysis(analysisAt(at(HISTORY_PIN_MAX)));
  const over = await store.setHistoryPin(idAt(HISTORY_PIN_MAX), true);
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'limit');
  assert.equal((await store.history()).filter((h) => h.pinned).length, HISTORY_PIN_MAX);
  // 付いている回にもう一度付けるのは上限に数えない
  assert.equal((await store.setHistoryPin(idAt(0), true)).ok, true);
  assert.equal((await store.setHistoryPin('20990101T000000000Z', true)).reason, 'missing');
  assert.equal((await store.setHistoryPin('../config', true)).reason, 'missing');
});

test('NIH-102: 印の数の上限があるので、履歴は 12 ＋ 上限の回数より増えない', async () => {
  const { dir, store } = tempStore();
  for (let i = 0; i < HISTORY_KEEP + HISTORY_PIN_MAX + 5; i++) {
    await store.saveAnalysis(analysisAt(at(i)));
    await store.setHistoryPin(idAt(i), true);
  }
  assert.equal((await store.history()).length, HISTORY_KEEP + HISTORY_PIN_MAX);
  assert.equal(files(dir).length, HISTORY_KEEP + HISTORY_PIN_MAX);
});

test('NIH-102: PC の POST /api/history/<id>/pin で付け外しでき、上限は 409・無い回は 404・形の違う本文は 400', async () => {
  const { store } = tempStore();
  await store.saveConfig({ llm: { baseUrl: 'http://127.0.0.1:1', chatModel: 'fake', embedModel: 'fake-embed' } });
  for (let i = 0; i < HISTORY_KEEP; i++) await store.saveAnalysis(analysisAt(at(i)));
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response('{}'), drive: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pin = (id, body) => fetch(`${base}/api/history/${id}/pin`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const res = await pin(idAt(0), { pinned: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).pinned, true);
    const { items, pinMax } = await (await fetch(`${base}/api/history`)).json();
    assert.equal(items.find((h) => h.id === idAt(0)).pinned, true, '一覧で印の付いた回が分かる');
    assert.equal(pinMax, HISTORY_PIN_MAX, '印の上限も一覧と一緒に返す（NIH-127。画面に数を書き写さない）');
    assert.equal((await pin(idAt(0), { pinned: false })).status, 200);
    assert.equal((await store.history()).find((h) => h.id === idAt(0)).pinned, undefined);
    assert.equal((await pin(idAt(0), { pinned: 'yes' })).status, 400);
    assert.equal((await pin('20990101T000000000Z', { pinned: true })).status, 404);
    for (let i = 0; i < HISTORY_PIN_MAX; i++) {
      if (i >= HISTORY_KEEP) await store.saveAnalysis(analysisAt(at(i)));
      assert.equal((await pin(idAt(i), { pinned: true })).status, 200);
    }
    await store.saveAnalysis(analysisAt(at(HISTORY_PIN_MAX)));
    const over = await pin(idAt(HISTORY_PIN_MAX), { pinned: true });
    assert.equal(over.status, 409);
    assert.match((await over.json()).error, new RegExp(`${HISTORY_PIN_MAX} 回`));
  } finally {
    server.close();
  }
});

test('NIH-102: 過去の分析の画面に「この回を残す」の付け外し、履歴の一覧に印', async () => {
  const { historyBody, historyListHtml } = await import('../web/js/views/knowledge.js');
  const a = analysisAt('2026-10-04T10:00:00.000Z');
  const off = String(historyBody(a, { current: false, pinned: false }));
  assert.match(off, /<button type="button" class="btn small" data-action="pin-history" data-id="20261004T100000000Z" data-pinned="false" aria-pressed="false">この回を残す<\/button>/);
  const on = String(historyBody(a, { current: true, pinned: true }));
  assert.match(on, /data-action="pin-history" data-id="20261004T100000000Z" data-pinned="true" aria-pressed="true">残すのをやめる<\/button>/);
  assert.match(on, /直近 12 回を過ぎても消えません/);
  // 印が分からない（PC の一覧が読めなかった）ときは出さない
  assert.doesNotMatch(String(historyBody(a, { current: false })), /data-action="pin-history"/);

  const items = [
    { id: '20261004T100000000Z', createdAt: '2026-10-04T10:00:00.000Z', stats: {}, changes: null, pinned: true },
    { id: '20261003T100000000Z', createdAt: '2026-10-03T10:00:00.000Z', stats: {}, changes: null },
  ];
  const list = String(historyListHtml(items, null));
  assert.equal((list.match(/class="pin-mark"/g) || []).length, 1);
  assert.match(list, /20261004T100000000Z">[^<]*<\/a> <span class="pin-mark">残す<\/span>/);

  // 押したときの処理（PC に印を送り、描き直す。失敗したら理由を出してボタンを戻す）
  const { fakeApp, button } = await import('./helpers/app-actions.js');
  const sent = [];
  const app = fakeApp({ library: {}, analysis: a, loaded: true }, { pinHistory: async (id, pinned) => sent.push([id, pinned]) });
  await app.actions['pin-history'](button({ id: '20261004T100000000Z', pinned: 'false' }));
  await app.actions['pin-history'](button({ id: '20261004T100000000Z', pinned: 'true' }));
  assert.deepEqual(sent, [['20261004T100000000Z', true], ['20261004T100000000Z', false]]);
  assert.deepEqual(app.log, ['toast', 'render', 'toast', 'render']);
  const failing = fakeApp({ library: {}, analysis: a, loaded: true }, { pinHistory: async () => { throw new Error('印は 20 回までです'); } });
  const btn = button({ id: '20261004T100000000Z', pinned: 'false' });
  await failing.actions['pin-history'](btn);
  assert.deepEqual([failing.toasts[0].message, btn.disabled, failing.log], ['印は 20 回までです', false, ['toast']]);
  assert.match(readFileSync(path.join(ROOT, 'web/js/services.js'), 'utf8'), /pinHistory: \(id, pinned\) => call\(`\/api\/history\/\$\{encodeURIComponent\(id\)\}\/pin`, \{ method: 'POST', body: \{ pinned \} \}\)/);
});

test('NIH-127: 履歴の見出しに印の数と上限を出し、上限のときは過去の分析の画面でほかの回の印を外すよう案内する', async () => {
  const { historyBody, pinCountText } = await import('../web/js/views/knowledge.js');
  const items = [{ pinned: true }, {}, { pinned: true }, { pinned: false }];
  assert.equal(pinCountText(items, 12), '残す 2 / 12 回');
  assert.equal(pinCountText([], 12), '残す 0 / 12 回');
  // 上限が分からない（古い PC）ときは数だけ出す
  assert.equal(pinCountText(items, null), '残す 2 回');

  const a = analysisAt('2026-10-04T10:00:00.000Z');
  const guide = /ほかの回の「残すのをやめる」を押す/;
  const full = String(historyBody(a, { current: false, pinned: false, pinCount: 12, pinMax: 12 }));
  assert.match(full, guide);
  assert.match(full, /<a href="#\/knowledge\?history=pinned">知識の画面の分析の履歴（印の付いた回だけ）<\/a>/, '印の付いた回だけに絞った履歴の一覧へ行ける（NIH-161）');
  assert.match(full, /data-action="pin-history"[^>]*>この回を残す<\/button>/, 'ボタンは残す（押せば PC が理由を返す）');
  // 上限に達していない・この回に印がある・上限が分からないときは案内しない
  assert.doesNotMatch(String(historyBody(a, { current: false, pinned: false, pinCount: 11, pinMax: 12 })), guide);
  assert.doesNotMatch(String(historyBody(a, { current: false, pinned: true, pinCount: 12, pinMax: 12 })), guide);
  assert.doesNotMatch(String(historyBody(a, { current: false, pinned: false, pinCount: 12 })), guide);

  const src = readFileSync(path.join(ROOT, 'web/js/views/knowledge.js'), 'utf8');
  assert.match(src, /<h2>分析の履歴 <span class="small muted pin-count" id="history-pin-count"><\/span><\/h2>/, '見出しの横に数を出す場所がある');
  assert.match(readFileSync(path.join(ROOT, 'web/js/services.js'), 'utf8'), /history: \(\) => call\('\/api\/history'\)\.then\(\(r\) => \(\{ items: r\?\.items \|\| \[\], pinMax: Number\.isInteger\(r\?\.pinMax\) \? r\.pinMax : null \}\)\)/);
});

test('NIH-161: 見出しの「残す N / 12 回」を押すと印の付いた回だけに絞り、もう一度押すと全件に戻る', async () => {
  const { historyListHtml, pinCountHtml, historyPinnedOnly } = await import('../web/js/views/knowledge.js');
  const items = [
    { id: '20261004T100000000Z', createdAt: '2026-10-04T10:00:00.000Z', stats: {}, changes: null, pinned: true },
    { id: '20261003T100000000Z', createdAt: '2026-10-03T10:00:00.000Z', stats: {}, changes: null },
    { id: '20261002T100000000Z', createdAt: '2026-10-02T10:00:00.000Z', stats: {}, changes: null, pinned: false },
  ];
  // 絞り込みは URL のクエリで持つ（別の画面のリンクからも開ける）
  assert.equal(historyPinnedOnly(new URLSearchParams('history=pinned')), true);
  assert.equal(historyPinnedOnly(new URLSearchParams('')), false);
  assert.equal(historyPinnedOnly(undefined), false);

  // 見出しの数: 全件のときは絞るリンク、絞っているときは全件に戻すリンク
  const off = String(pinCountHtml(items, 12, false));
  assert.match(off, /<a href="#\/knowledge\?history=pinned" aria-pressed="false"[^>]*>残す 1 \/ 12 回<\/a>/);
  const on = String(pinCountHtml(items, 12, true));
  assert.match(on, /<a href="#\/knowledge" aria-pressed="true"[^>]*>残す 1 \/ 12 回<\/a>/);

  // 一覧: 絞ると印の回だけ。全件に戻す入口も出す
  assert.equal((String(historyListHtml(items, null)).match(/<li>/g) || []).length, 3);
  const pinnedList = String(historyListHtml(items, null, { pinnedOnly: true }));
  assert.equal((pinnedList.match(/<li>/g) || []).length, 1);
  assert.match(pinnedList, /20261004T100000000Z/);
  assert.doesNotMatch(pinnedList, /20261003T100000000Z|20261002T100000000Z/);
  assert.match(pinnedList, /<a href="#\/knowledge">すべての回を出す<\/a>/);
  // 印の回が無ければ、そう出して全件に戻す入口を出す
  const none = String(historyListHtml(items.filter((h) => !h.pinned), null, { pinnedOnly: true }));
  assert.match(none, /印の付いた回はありません/);
  assert.match(none, /<a href="#\/knowledge">すべての回を出す<\/a>/);
  // 履歴そのものが無いときは、絞っていても従来の案内
  assert.match(String(historyListHtml([], null, { pinnedOnly: true })), /まだ履歴がありません/);
});

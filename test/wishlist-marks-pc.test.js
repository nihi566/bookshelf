// 欲しい本の画面で付けた印（読んだ・★・種別）を、書き出し・import-marks の手作業なしで PC（kindle_system の受け箱）へ届ける（NIH-367）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { collectMarks, KEYS, marksForPc, MARKS_FOR_PC_MAX, memoryStore, saveMarks } from '../web/core/wishlist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test('marksForPc: 書き出しファイルと同じ形の項目だけを通す（PC に送られた値は信用しない）', () => {
  const items = marksForPc([
    { asin: 'B000000001', title: '本 1', tag: 'seen', rating: 4 },
    { asin: 'B000000002', title: '本 2', tag: 'wanted', rating: 5 }, // ★は読んだのときだけ
    { asin: 'B000000003', kind: 'manga' },
    { asin: 'B000000004', tag: '', rating: null }, // タグを外した
    { asin: 'bad', tag: 'seen' },
    { asin: 'B000000005', tag: 'unknown' },
    { asin: 'B000000006', kind: 'comic' },
    { asin: 'B000000007' }, // 反映する項目が無い
    { asin: 'B000000008', tag: 'seen', rating: 9 },
    null,
  ]);
  assert.deepEqual(items, [
    { asin: 'B000000001', title: '本 1', tag: 'seen', rating: 4 },
    { asin: 'B000000002', title: '本 2', tag: 'wanted', rating: null },
    { asin: 'B000000003', title: '', kind: 'manga' },
    { asin: 'B000000004', title: '', tag: '', rating: null },
    { asin: 'B000000008', title: '', tag: 'seen', rating: null },
  ]);
  assert.deepEqual(marksForPc('x'), []);
  // 題名は文字単位で 300 字に切り、壊れた文字（片方だけのサロゲート）を落とす（kindle_system の DB に書けなくなるため）
  const [long] = marksForPc([{ asin: 'B000000009', title: `${'a'.repeat(299)}😀b`, tag: 'seen' }]);
  assert.equal(long.title, `${'a'.repeat(299)}😀`);
  assert.equal(marksForPc([{ asin: 'B000000009', title: 'x\ud83dy', tag: 'seen' }])[0].title, 'xy');
  assert.equal(marksForPc(Array.from({ length: MARKS_FOR_PC_MAX + 5 }, (_, i) => ({ asin: `B${String(i).padStart(9, '0')}`, tag: 'seen' }))).length, MARKS_FOR_PC_MAX);
});

async function withServer(fn) {
  const dataDir = tmp('bh-data-');
  const marksInbox = path.join(tmp('bh-kindle-'), 'marks-inbox');
  const store = createStore(dataDir);
  await store.saveConfig({ allowedOrigins: ['https://example.github.io'] });
  const server = createCompanionServer({ store, log: () => {}, marksInbox });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, marksInbox });
  } finally {
    server.close();
  }
}

const post = (base, body) => fetch(`${base}/api/wishlist/marks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /api/wishlist/marks: kindle_system の受け箱に kindle-marks v1 のファイルを 1 送信 1 ファイルで置く', async () => {
  await withServer(async ({ base, marksInbox }) => {
    const r1 = await post(base, { items: [{ asin: 'B000000001', title: '本 1', tag: 'seen', rating: 3 }, { asin: 'bad', tag: 'seen' }] });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, count: 1 });
    const r2 = await post(base, { items: [{ asin: 'B000000002', kind: 'book' }] });
    assert.equal(r2.status, 200);

    const files = readdirSync(marksInbox).sort();
    assert.equal(files.length, 2);
    for (const f of files) assert.match(f, /^kindle-marks-\d{13}-[0-9a-f]{8}\.json$/);
    // 名前の順 = 置いた順（kindle_system は名前の順に取り込む）
    const first = JSON.parse(readFileSync(path.join(marksInbox, files[0]), 'utf8'));
    assert.equal(first.format, 'kindle-marks');
    assert.equal(first.version, 1);
    assert.ok(Date.parse(first.exported_at));
    assert.deepEqual(first.items, [{ asin: 'B000000001', title: '本 1', tag: 'seen', rating: 3 }]);
    const second = JSON.parse(readFileSync(path.join(marksInbox, files[1]), 'utf8'));
    assert.deepEqual(second.items, [{ asin: 'B000000002', title: '', kind: 'book' }]);
  });
});

test('POST /api/wishlist/marks: 反映する項目が無ければ 400 で、ファイルを置かない', async () => {
  await withServer(async ({ base, marksInbox }) => {
    assert.equal((await post(base, { items: [] })).status, 400);
    assert.equal((await post(base, { items: [{ asin: 'nope', tag: 'seen' }] })).status, 400);
    assert.equal((await post(base, {})).status, 400);
    assert.deepEqual(readdirSync(path.dirname(marksInbox)), []);
  });
});

test('POST /api/wishlist/marks: 受け箱に取り込み待ちがたまりすぎたら 429 で、それ以上置かない', async () => {
  await withServer(async ({ base, marksInbox }) => {
    mkdirSync(marksInbox, { recursive: true });
    for (let i = 0; i < 500; i++) writeFileSync(path.join(marksInbox, `kindle-marks-${String(i).padStart(13, '0')}-00000000.json${i % 2 ? '.broken' : ''}`), '{}');
    const res = await post(base, { items: [{ asin: 'B000000001', tag: 'seen' }] });
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /run\.py sync/);
    assert.equal(readdirSync(marksInbox).length, 500);
  });
});

test('collectMarks: PC へ送るのは、書き出し・送った後に変えた本だけ（別の端末で変えた印を古い値で上書きしない）', () => {
  const store = memoryStore();
  const book = (asin) => ({ asin, title: asin, saved: { tag: '', rating: '', kind: 'book' } });
  const items = [book('B000000001'), book('B000000002')].map((b) => ({ book: b, marks: { tag: 'seen', rating: '', kind: 'book' } }));
  saveMarks(store, 'B000000001', items[0].marks, 'tag', 1000);
  store.set(KEYS.exportedAt, '2000');
  saveMarks(store, 'B000000002', items[1].marks, 'tag', 3000);
  const s = collectMarks(items, store);
  assert.equal(s.items.length, 2);
  assert.deepEqual(s.unexportedItems.map((it) => it.asin), ['B000000002']);
});

test('POST /api/wishlist/marks: 許可していないオリジンからは受けない', async () => {
  await withServer(async ({ base, marksInbox }) => {
    const res = await fetch(`${base}/api/wishlist/marks`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ asin: 'B000000001', tag: 'seen' }] }) });
    assert.equal(res.status, 403);
    assert.deepEqual(readdirSync(path.dirname(marksInbox)), []);
  });
});

test('価格チェックの画面: 印を付けたら PC へ送り、送れたら「書き出し済み」の時刻を進める', () => {
  const view = readFileSync(path.join(ROOT, 'web/js/views/wishlist.js'), 'utf8');
  const services = readFileSync(path.join(ROOT, 'web/js/services.js'), 'utf8');
  assert.match(services, /sendWishlistMarks: \(items\) => call\('\/api\/wishlist\/marks'/);
  assert.match(view, /companion\.sendWishlistMarks\(/);
  // 送る直前の時刻を書き出し済みにする（送っている間に付けた印を、送ったことにしない）
  assert.match(view, /const sentAt = Date\.now\(\);[\s\S]*store\.set\(KEYS\.exportedAt, String\(sentAt\)\)/);
  // PC を設定していない画面（GitHub Pages で開いただけ）は localhost に送らない
  assert.match(view, /canSendMarks\(/);
});

// NIH-95 削除した点の一覧（ゴミ箱）から、通知が消えた後でも点を戻せる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteBook, deletedHighlights, emptyLibrary, liveHighlights, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const T1 = '2026-10-10T00:01:00.000Z';
const T2 = '2026-10-10T00:02:00.000Z';
const T3 = '2026-10-10T00:03:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

const st = (library) => ({ library, analysis: null, settings: { ai: { mode: 'companion', companionUrl: '', token: '', baseUrl: '', chatModel: '', embedModel: '' }, autoSync: false }, servedByCompanion: false, lastSync: null });

test('deletedHighlights: 利用者が削除した点だけを、削除した時刻の新しい順に返す', () => {
  const lib = sample();
  const [a, b, c] = liveHighlights(lib);
  updateHighlight(lib, a.id, { deleted: true }, T1);
  updateHighlight(lib, b.id, { deleted: true }, T3);
  updateHighlight(lib, c.id, { deleted: true }, T2);
  assert.deepEqual(deletedHighlights(lib).map((h) => h.id), [b.id, c.id, a.id]);
});

test('deletedHighlights: 戻した点・取り込みで長い文に置き換わった点・本ごと削除した点は出さない', () => {
  const lib = sample();
  const live = liveHighlights(lib);
  const [a, b] = live;
  updateHighlight(lib, a.id, { deleted: true }, T1);
  updateHighlight(lib, a.id, { deleted: false }, T2);
  // 取り込みで長い文に置き換わった点（利用者が消したものではない）
  Object.assign(lib.highlights[b.id], { deleted: true, supersededBy: 'hx' });
  // 先に点を 1 つ削除してから本を削除しても、本が削除されたままでは戻しても見えないので出さない
  const other = live.find((h) => h.bookId !== a.bookId && h.bookId !== b.bookId);
  updateHighlight(lib, other.id, { deleted: true }, T1);
  deleteBook(lib, other.bookId, T2);
  assert.deepEqual(deletedHighlights(lib), []);
});

test('一覧から戻した点は、同期（統合）で削除したままの端末にも戻る', () => {
  const pc = sample();
  const h = liveHighlights(pc)[0];
  updateHighlight(pc, h.id, { userNote: '自分のメモ', tags: ['習慣'], favorite: true }, T1);
  updateHighlight(pc, h.id, { deleted: true }, T2);
  const phone = structuredClone(pc);
  updateHighlight(phone, h.id, { deleted: false }, T3);
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    const back = merged.highlights[h.id];
    assert.ok(!back.deleted, '戻した方（新しい方）が勝つ');
    assert.deepEqual([back.userNote, back.tags, back.favorite], ['自分のメモ', ['習慣'], true]);
    assert.deepEqual(deletedHighlights(merged), []);
  }
});

test('ゴミ箱の画面: 点ごとに書名・自分のメモ・タグ・★と「元に戻す」を出す', async () => {
  const { trashView } = await import('../web/js/views/trash.js');
  const lib = sample();
  const h = liveHighlights(lib)[0];
  updateHighlight(lib, h.id, { userNote: '自分のメモ', tags: ['習慣'], favorite: true }, T1);
  updateHighlight(lib, h.id, { deleted: true }, T2);
  const out = String(trashView.render({ state: st(lib) }));
  assert.match(out, /<a class="back" href="#\/settings">‹ 設定<\/a>/);
  assert.ok(out.includes(lib.books[h.bookId].title), '書名');
  assert.ok(out.includes('自分のメモ'));
  assert.ok(out.includes('#習慣'));
  assert.ok(out.includes('★'));
  assert.match(out, new RegExp(`<button type="button" class="btn small" data-action="restore-highlight" data-id="${h.id}">元に戻す</button>`));
});

test('ゴミ箱の画面: 削除した点が無ければそう伝える', async () => {
  const { trashView } = await import('../web/js/views/trash.js');
  const out = String(trashView.render({ state: st(sample()) }));
  assert.match(out, /削除した点はありません/);
  assert.doesNotMatch(out, /restore-highlight/);
});

test('設定の「データ」に、削除した点の件数つきの入口がある', async (t) => {
  // 設定の画面は Ollama の案内に location.origin を出す
  globalThis.location = { origin: 'http://localhost:8787' };
  t.after(() => delete globalThis.location);
  const { settingsView } = await import('../web/js/views/settings.js');
  const lib = sample();
  const [a, b] = liveHighlights(lib);
  updateHighlight(lib, a.id, { deleted: true }, T1);
  updateHighlight(lib, b.id, { deleted: true }, T2);
  const out = String(settingsView.render({ state: st(lib) }));
  assert.match(out, /<a class="row spread" href="#\/trash"><b>削除した点<\/b><span class="muted">2 件 ›<\/span><\/a>/);
});

test('app.js: #/trash の画面があり、「元に戻す」は通知の「元に戻す」と同じ処理で戻す', () => {
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  assert.ok(app.includes("[/^\\/trash$/, trashView, 'settings']"));
  assert.match(app, /'restore-highlight'\(el\) \{\s*return undoDeleteHighlight\(el\.dataset\.id\);/);
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  assert.ok(sw.includes("'js/views/trash.js'"), 'オフラインでも開ける');
});

// 課題発見（2026-09-27）で見つかった不具合の再現テスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookHighlights, bookIdFor, deleteBook, emptyLibrary, highlightIdFor, listBooks, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const T1 = '2025-01-01T00:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  return lib;
}

// ---- 20260927-sync-overwrites-unsynced-phone-edits ----

function twoDevices() {
  const pc = emptyLibrary();
  mergeParsed(pc, [{ title: '本', author: '著者', source: 'kindle', highlights: [{ text: '点A', location: 10 }, { text: '点B', location: 20 }] }], { now: '2025-01-01T00:00:00.000Z' });
  const phone = structuredClone(pc);
  return { pc, phone, id: highlightIdFor(bookIdFor('本'), '点A') };
}

test('スマホで付けた★・メモは、PC で別形式を取り込んで空欄が埋まった後の同期でも消えない', () => {
  const { pc, phone, id } = twoDevices();
  // スマホ: 未同期のまま★とメモ（10:00）
  updateHighlight(phone, id, { favorite: true, userNote: 'スマホのメモ', tags: ['大事'] }, '2025-02-01T10:00:00.000Z');
  // PC: 別形式（エクスポート HTML）の取り込みで章・色が埋まる（11:00）
  const s = mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10, chapter: '第1章', color: 'yellow' }] }], { now: '2025-02-01T11:00:00.000Z' });
  assert.equal(s.updated, 1);
  // 同期: サーバ側（PC を基準）でもスマホ側でも同じ結果
  for (const merged of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    const h = merged.highlights[id];
    assert.equal(h.favorite, true);
    assert.equal(h.userNote, 'スマホのメモ');
    assert.deepEqual(h.tags, ['大事']);
    assert.equal(h.chapter, '第1章', 'PC の取り込みで埋まった欄も残る');
    assert.equal(h.color, 'yellow');
  }
  assert.deepEqual(mergeLibraries(pc, phone), mergeLibraries(phone, pc), 'どちら向きに統合しても同じ');
});

test('同期: 自分の編集は新しい方が勝つ（★を外した・削除した も伝わる）', () => {
  const { pc, phone, id } = twoDevices();
  updateHighlight(pc, id, { favorite: true }, '2025-02-01T10:00:00.000Z');
  const synced = mergeLibraries(phone, pc);
  updateHighlight(synced, id, { favorite: false }, '2025-02-02T10:00:00.000Z');
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10, chapter: '第1章' }] }], { now: '2025-02-03T00:00:00.000Z' });
  const merged = mergeLibraries(pc, synced);
  assert.equal(merged.highlights[id].favorite, false, '後から外した★が、PC の取り込みより優先される');
  assert.equal(merged.highlights[id].chapter, '第1章');
  const idB = highlightIdFor(bookIdFor('本'), '点B');
  updateHighlight(phone, idB, { deleted: true }, '2025-02-04T00:00:00.000Z');
  assert.equal(mergeLibraries(pc, phone).highlights[idB].deleted, true);
});

test('同期: 本の削除は PC の取り込みに上書きされない・古い形式のデータ（userUpdatedAt 無し）の編集も守る', () => {
  const { pc, phone, id } = twoDevices();
  const bookId = bookIdFor('本');
  deleteBook(phone, bookId, '2025-02-01T10:00:00.000Z');
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10, color: 'blue' }] }], { now: '2025-02-01T11:00:00.000Z' });
  const merged = mergeLibraries(pc, phone);
  assert.equal(merged.books[bookId].deleted, true);
  assert.ok(!listBooks(merged).some((b) => b.id === bookId));
  // 古い版のアプリで付けた★（userUpdatedAt が無い）
  const legacyPhone = structuredClone(twoDevices().phone);
  Object.assign(legacyPhone.highlights[id], { favorite: true, updatedAt: '2025-03-01T00:00:00.000Z' });
  const legacyPc = twoDevices().pc;
  mergeParsed(legacyPc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10, chapter: '章' }] }], { now: '2025-03-02T00:00:00.000Z' });
  assert.equal(mergeLibraries(legacyPc, legacyPhone).highlights[id].favorite, true);
});

test('同期: 伸ばしたハイライトで置き換わった古い点は、どちらの端末から来ても消えたまま', () => {
  const { pc, phone } = twoDevices();
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点Aを伸ばした', location: 10, locationEnd: 12 }] }], { now: '2025-02-01T00:00:00.000Z' });
  const oldId = highlightIdFor(bookIdFor('本'), '点A');
  updateHighlight(phone, oldId, { userNote: '古い方に書いたメモ' }, '2025-01-15T00:00:00.000Z');
  const merged = mergeLibraries(phone, pc);
  assert.equal(merged.highlights[oldId].deleted, true);
  assert.deepEqual(bookHighlights(merged, bookIdFor('本')).map((h) => h.text), ['点Aを伸ばした', '点B']);
});

// ---- 20260927-playbooks-short-highlight-swallowed ----

test('Play ブックス: 別ページの長いハイライトに含まれる短いハイライトも両方残る（再取り込みでも）', () => {
  const lib = emptyLibrary();
  const book = { title: '深い集中', source: 'playbooks', highlights: [
    { text: '注意は最も希少な資源である。何に注意を向けるかが、その人の人生をつくる。', page: '12' },
    { text: '注意は最も希少な資源', page: '88' },
  ] };
  mergeParsed(lib, [book], { now: T1 });
  mergeParsed(lib, [book], { now: '2025-02-01T00:00:00.000Z' });
  assert.equal(bookHighlights(lib, bookIdFor('深い集中')).length, 2);
});

test('Kindle: 位置の無い（ページだけの）クリッピングは、別ページなら両方残し、同じページなら伸ばした方に置き換える', () => {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: 'PDF', source: 'kindle', highlights: [{ text: '短い文', page: '3' }, { text: '短い文を含む長い文', page: '9' }] }], { now: T1 });
  assert.equal(bookHighlights(lib, bookIdFor('PDF')).length, 2);
  const lib2 = emptyLibrary();
  mergeParsed(lib2, [{ title: 'PDF', source: 'kindle', highlights: [{ text: '短い文', page: '3' }] }], { now: T1 });
  mergeParsed(lib2, [{ title: 'PDF', source: 'kindle', highlights: [{ text: '短い文を伸ばした', page: '3' }] }], { now: '2025-02-01T00:00:00.000Z' });
  assert.deepEqual(bookHighlights(lib2, bookIdFor('PDF')).map((h) => h.text), ['短い文を伸ばした']);
});

// ---- 20260927-import-merge-diverges-backup-analysis ----

test('バックアップの取り込み: ライブラリと分析結果の扱いを 1 か所に統一（新しい分析だけ採用）', async () => {
  const { applyImport } = await import('../web/core/importing.js');
  const { parseFiles } = await import('../web/core/parsers/index.js');
  const lib = sampleLibrary();
  const older = { createdAt: '2025-01-01T00:00:00.000Z', lines: [], planes: [] };
  const newer = { createdAt: '2025-06-01T00:00:00.000Z', lines: [{ id: 'x' }], planes: [] };
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  // 旧形式（ライブラリに analysis を足したもの）と新形式（format 付き）の両方を読む
  const { books, backups } = await parseFiles([
    { name: 'old-backup.json', bytes: enc({ ...lib, analysis: newer }) },
    { name: 'new-backup.json', bytes: enc({ format: 'book-highlights/backup', version: 1, library: lib, analysis: older }) },
  ]);
  assert.equal(backups.length, 2);
  assert.ok(!('analysis' in backups[0].library), 'ライブラリに analysis が混ざらない');
  const r1 = applyImport({ library: emptyLibrary(), analysis: older }, { books, backups });
  assert.deepEqual(r1.analysis, newer, '手元より新しい分析は採用');
  assert.equal(r1.stats.highlights, 48);
  const r2 = applyImport({ library: emptyLibrary(), analysis: { ...newer, createdAt: '2026-01-01T00:00:00.000Z' } }, { books, backups });
  assert.equal(r2.analysis.createdAt, '2026-01-01T00:00:00.000Z', '手元の方が新しければそのまま');
  assert.equal(r2.analysisChanged, false);
});

// ---- 20260927-pc-job-result-lost-on-poll-failure ----

test('PC の分析の待機: 通信が一時的に失敗しても待ち続け、終われば結果を返す。長く途切れたら「不明」で止まる', async () => {
  const { followJob } = await import('../web/core/jobs.js');
  const seq = [{ running: true, stage: 'lines' }, new Error('offline'), new Error('offline'), { running: false, stage: 'done' }];
  const updates = [];
  const done = await followJob({ fetchJob: async () => { const x = seq.shift(); if (x instanceof Error) throw x; return x; }, onUpdate: (u) => updates.push(u), sleep: async () => {} });
  assert.equal(done.stage, 'done');
  assert.ok(updates.some((u) => u.reconnecting === 2), '再接続中であることを知らせる');
  const lost = await followJob({ fetchJob: async () => { throw new Error('offline'); }, onUpdate: () => {}, sleep: async () => {}, maxFailures: 3 });
  assert.equal(lost.lost, true);
});

// ---- 20260927-recommendation-feedback ----

import { setFeedback, feedbackFor } from '../web/core/model.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { recommendBooks } from '../web/core/analysis/pipeline.js';
import { startFakeLlm } from './helpers/fake-llm.js';

test('おすすめへの反応（読んだ／読みたい／興味なし）: 付け外し・同期で新しい方が残る', () => {
  const pc = emptyLibrary();
  setFeedback(pc, { title: '哲学の入口', author: '著者 C' }, 'want', '2025-01-01T00:00:00.000Z');
  assert.equal(feedbackFor(pc, '哲学の入口')?.status, 'want');
  const phone = structuredClone(pc);
  setFeedback(phone, { title: '哲学の入口' }, 'read', '2025-01-02T00:00:00.000Z');
  setFeedback(pc, { title: '行動を変える技術' }, 'no', '2025-01-03T00:00:00.000Z');
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(feedbackFor(m, '哲学の入口').status, 'read');
    assert.equal(feedbackFor(m, '行動を変える技術').status, 'no');
  }
  // 同じ反応をもう一度押すと外れる
  setFeedback(phone, { title: '哲学の入口' }, 'read', '2025-01-04T00:00:00.000Z');
  assert.equal(feedbackFor(phone, '哲学の入口'), null);
});

test('おすすめの選定に反応を使う: 反応済みの本は候補から外し、好み（読みたい／興味なし）をプロンプトに伝える', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    setFeedback(lib, { title: '行動を変える技術' }, 'no');
    setFeedback(lib, { title: '習慣の科学' }, 'want');
    const analysis = { planes: [{ id: 'p1', name: '面1', summary: 's' }, { id: 'p2', name: '面2', summary: 's' }], solid: { core: 'c', questions: [] } };
    const vol = (id, title) => ({ id, volumeInfo: { title, authors: ['著者'], infoLink: `https://books.google.com/?id=${id}` } });
    const fetchImpl = async (url) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('q') || '');
      const items = q.includes('習慣') ? [vol('a', '習慣の科学'), vol('b', '行動を変える技術'), vol('c', '集中の技法')] : [vol('d', '哲学の入口')];
      return new Response(JSON.stringify({ items }));
    };
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat' });
    const recs = await recommendBooks({ library: lib, analysis, llm, fetchImpl });
    const titles = recs.map((r) => r.title);
    assert.ok(!titles.includes('行動を変える技術') && !titles.includes('習慣の科学'), '反応済みの本は選ばない');
    const pick = fake.calls.bodies.find((b) => b.response_format?.json_schema?.name === 'picks').messages[1].content;
    assert.doesNotMatch(pick, /『行動を変える技術』|『習慣の科学』/);
    const search = fake.calls.bodies.find((b) => b.response_format?.json_schema?.name === 'searches').messages[1].content;
    assert.match(search, /読みたいと言った本: 習慣の科学/);
    assert.match(search, /興味なしとした本: 行動を変える技術/);
  } finally {
    await fake.close();
  }
});

// ---- レビュー指摘（2 回目）の回帰テスト ----

test('同期: 未同期の編集をした短いハイライトが、もう一方の端末で伸ばした版に置き換わっても編集を引き継ぐ', () => {
  const { pc, phone, id } = twoDevices();
  updateHighlight(phone, id, { favorite: true, userNote: '短い方のメモ' }, '2025-02-01T10:00:00.000Z');
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点Aを伸ばした', location: 10, locationEnd: 12 }] }], { now: '2025-02-01T11:00:00.000Z' });
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    const live = bookHighlights(m, bookIdFor('本')).find((h) => h.text === '点Aを伸ばした');
    assert.equal(live.userNote, '短い方のメモ');
    assert.equal(live.favorite, true);
  }
});

test('同期: 古い版のデータで付けた編集は、もう一方の取り込みで updatedAt が進んでも負けない', () => {
  const pc = emptyLibrary();
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10 }] }], { now: '2025-01-01T00:00:00.000Z' });
  const id = highlightIdFor(bookIdFor('本'), '点A');
  // 古い版: userUpdatedAt が無く、編集で updatedAt だけ進んだ
  Object.assign(pc.highlights[id], { userNote: 'old', updatedAt: '2025-01-02T00:00:00.000Z' });
  const phone = structuredClone(pc);
  Object.assign(phone.highlights[id], { userNote: 'new', updatedAt: '2025-01-03T00:00:00.000Z' });
  mergeParsed(pc, [{ title: '本', source: 'kindle', highlights: [{ text: '点A', location: 10, chapter: '章' }] }], { now: '2025-01-04T00:00:00.000Z' });
  assert.equal(pc.highlights[id].userUpdatedAt, '2025-01-02T00:00:00.000Z', '取り込みの前の編集時刻を残す');
  assert.equal(mergeLibraries(pc, phone).highlights[id].userNote, 'new');
  assert.equal(mergeLibraries(phone, pc).highlights[id].userNote, 'new');
});

test('同期: ソースの並びと置き換え先は、どちら向きに統合しても同じ', () => {
  const a = emptyLibrary();
  mergeParsed(a, [{ title: '本', source: 'playbooks', highlights: [{ text: 'x', page: '1' }] }], { now: T1 });
  const b = emptyLibrary();
  mergeParsed(b, [{ title: '本', source: 'kindle', highlights: [{ text: 'y', location: 1 }] }], { now: T1 });
  assert.deepEqual(mergeLibraries(a, b).books[bookIdFor('本')].sources, mergeLibraries(b, a).books[bookIdFor('本')].sources);
});

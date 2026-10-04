// G1 思いつきメモ（フリートノート）: 書く・整理する・捨てる・消す・同期・分析の点にする
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { dailyPicks, emptyLibrary, libraryStats, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { addThought, deleteThought, inboxThoughts, liveThoughts, pointThoughts, searchThoughts, thoughtCounts, updateThought } from '../web/core/thoughts.js';
import { analysisPoints, pointById, pointLabel, searchPoints } from '../web/core/points.js';
import { applyImport, makeBackup } from '../web/core/importing.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  return lib;
}

test('G1-1: 本に属さないメモを書ける（受け箱に入る）。空のメモは書けない', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '  散歩の途中で、習慣は場所に結びつくと気づいた \n' }, T1);
  assert.match(t.id, /^t/);
  assert.equal(t.text, '散歩の途中で、習慣は場所に結びつくと気づいた');
  assert.equal(t.status, 'inbox');
  assert.equal(t.createdAt, T1);
  assert.equal(lib.updatedAt, T1);
  assert.equal(Object.keys(lib.books).length, 0, '本は作らない');
  assert.throws(() => addThought(lib, { text: '   ' }), /メモを入力してください/);
  // ID は本文から決めない（同じ文を 2 回書いても別のメモ・本文を直しても ID は同じ）
  const t2 = addThought(lib, { text: '散歩の途中で、習慣は場所に結びつくと気づいた' }, T1);
  assert.notEqual(t2.id, t.id);
  assert.equal(updateThought(lib, t.id, { text: '書き直した' }, T2).id, t.id);
});

test('G1-3: 未整理・整理済み・捨てたの状態を持ち、受け箱には未整理だけが新しい順に件数付きで出る', () => {
  const lib = emptyLibrary();
  const a = addThought(lib, { text: '一つ目' }, T1);
  const b = addThought(lib, { text: '二つ目' }, T2);
  const c = addThought(lib, { text: '三つ目' }, T3);
  updateThought(lib, a.id, { status: 'done' }, T3);
  updateThought(lib, b.id, { status: 'discarded' }, T3);
  assert.deepEqual(inboxThoughts(lib).map((t) => t.id), [c.id]);
  assert.deepEqual(thoughtCounts(lib), { inbox: 1, done: 1, discarded: 1 });
  assert.throws(() => updateThought(lib, a.id, { status: 'archived' }), /不明な状態/);
  updateThought(lib, a.id, { status: 'inbox' }, T3);
  assert.deepEqual(inboxThoughts(lib).map((t) => t.id), [c.id, a.id], '未整理に戻せる');
});

test('G1-4: 捨てたメモ以外は分析の点になる（整理しなくても点になる）。書名の代わりに「思いつき」', () => {
  const lib = sampleLibrary();
  const inbox = addThought(lib, { text: '受け箱のまま' }, T1);
  const done = addThought(lib, { text: '整理済み' }, T1);
  const gone = addThought(lib, { text: '捨てた' }, T1);
  updateThought(lib, done.id, { status: 'done' }, T2);
  updateThought(lib, gone.id, { status: 'discarded' }, T2);
  const ids = analysisPoints(lib).map((p) => p.id);
  assert.equal(ids.length, 48 + 2);
  assert.ok(ids.includes(inbox.id) && ids.includes(done.id));
  assert.ok(!ids.includes(gone.id));
  assert.equal(pointLabel(lib, inbox), '思いつき');
  assert.equal(libraryStats(lib).points, 50);
  assert.equal(libraryStats(lib).thoughts, 2);
  assert.equal(libraryStats(lib).highlights, 48, '本の点の数は変わらない');
});

test('G1-5: 捨てたメモは分析・今日の点・検索に出ない', () => {
  const lib = emptyLibrary();
  const keep = addThought(lib, { text: '残すメモ 共通の語' }, T1);
  const gone = addThought(lib, { text: '捨てるメモ 共通の語' }, T1);
  updateThought(lib, gone.id, { status: 'discarded' }, T2);
  assert.deepEqual(pointThoughts(lib).map((t) => t.id), [keep.id]);
  for (let d = 1; d <= 20; d++) assert.ok(!dailyPicks(lib, 3, new Date(2026, 0, d)).some((p) => p.id === gone.id), '今日の点に出ない');
  assert.ok(dailyPicks(lib, 3, new Date(2026, 0, 1)).some((p) => p.id === keep.id), '捨てていないメモは今日の点に出うる');
  assert.deepEqual(searchPoints(lib, '共通の語').map((p) => p.id), [keep.id]);
  assert.deepEqual(searchThoughts(lib, '共通の語', { status: 'discarded' }).map((t) => t.id), [gone.id], '「捨てた」の一覧では見られる');
});

test('G1-5 / C3: 捨てた・消したメモは、同期・バックアップの取り込みで戻らない（どちら向きに統合しても同じ）', () => {
  const pc = emptyLibrary();
  const a = addThought(pc, { text: '捨てるメモ' }, T1, 'ta');
  const b = addThought(pc, { text: '消すメモ' }, T1, 'tb');
  const oldBackup = makeBackup(structuredClone(pc), null);
  const phone = structuredClone(pc);
  updateThought(phone, a.id, { status: 'discarded' }, T2);
  deleteThought(phone, b.id, T2);
  assert.equal(phone.thoughts[b.id].text, undefined, '消したメモの本文は残さない');
  assert.deepEqual(liveThoughts(phone).map((t) => t.id), [a.id]);

  const m1 = mergeLibraries(pc, phone);
  const m2 = mergeLibraries(phone, pc);
  assert.deepEqual(m1.thoughts, m2.thoughts);
  assert.equal(m1.thoughts[a.id].status, 'discarded');
  assert.equal(m1.thoughts[b.id].deleted, true);

  // 古いバックアップ（捨てる前・消す前）を取り込んでも戻らない
  const r = applyImport({ library: m1 }, { backups: [oldBackup] });
  assert.equal(r.library.thoughts[a.id].status, 'discarded');
  assert.equal(r.library.thoughts[b.id].deleted, true);
  assert.equal(searchPoints(r.library, 'メモ').length, 0);

  // 消したあとに別の端末で書き直していても、消したものは消えたまま
  const other = structuredClone(pc);
  updateThought(other, b.id, { text: 'あとから書き直した' }, T3);
  assert.equal(mergeLibraries(phone, other).thoughts[b.id].deleted, true);
  assert.equal(mergeLibraries(other, phone).thoughts[b.id].deleted, true);
});

test('C3: メモの書き直しは新しい方が残る・片方にしか無いメモも残る', () => {
  const pc = emptyLibrary();
  const t = addThought(pc, { text: '元の文' }, T1, 'tx');
  const phone = structuredClone(pc);
  updateThought(phone, t.id, { text: 'スマホで直した' }, T2);
  addThought(phone, { text: 'スマホだけのメモ' }, T2, 'ty');
  addThought(pc, { text: 'PC だけのメモ' }, T3, 'tz');
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(m.thoughts.tx.text, 'スマホで直した');
    assert.deepEqual(Object.keys(m.thoughts).sort(), ['tx', 'ty', 'tz']);
  }
});

test('C2: 思いつきの無い古い形のデータ（スマホに保存したもの・バックアップ）も読める', () => {
  const legacy = sampleLibrary();
  delete legacy.thoughts;
  const now = emptyLibrary();
  addThought(now, { text: '新しいメモ' }, T2, 'tn');
  for (const m of [mergeLibraries(legacy, now), mergeLibraries(now, legacy)]) {
    assert.equal(Object.keys(m.highlights).length, 48);
    assert.equal(m.thoughts.tn.text, '新しいメモ');
  }
  assert.equal(analysisPoints(legacy).length, 48);
  assert.equal(libraryStats(legacy).thoughts, 0);
  const r = applyImport({ library: legacy }, { backups: [{ library: legacy, analysis: null }] });
  assert.deepEqual(r.library.thoughts, {});
});

test('同期: 形の壊れた思いつきは取り込まない（外から来たデータを信用しない）', () => {
  const lib = emptyLibrary();
  // JSON から読んだ形（__proto__ も普通の鍵として入る）
  const incoming = JSON.parse(
    JSON.stringify({
      thoughts: {
        tok: { text: 'ok', status: 'weird', createdAt: T1, updatedAt: T1 },
        tarr: { text: '状態が配列', status: ['discarded'], createdAt: T1, updatedAt: T1 },
        hbad: { text: 'ID が点の形', updatedAt: T1 },
        tempty: { text: '  ', updatedAt: T1 },
        tobj: { text: { a: 1 }, updatedAt: T1 },
        tnum: 3,
        toString: { text: '継承した名前', updatedAt: T1 },
      },
    }).replace('"tok":', '"__proto__":{"text":"入れ物の継承元","updatedAt":"x"},"tok":'),
  );
  assert.ok(Object.hasOwn(incoming.thoughts, '__proto__'));
  const m = mergeLibraries(lib, incoming);
  assert.deepEqual(Object.keys(m.thoughts).sort(), ['tarr', 'tok']);
  assert.equal(m.thoughts.tok.status, 'inbox', '知らない状態は未整理として扱う');
  assert.equal(m.thoughts.tarr.status, 'inbox', '文字列でない状態は信じない');
  assert.equal(m.thoughts.tok.id, 'tok');
  assert.equal(Object.getPrototypeOf(m.thoughts), Object.prototype);
});

test('C3: 本文の書き直しと状態の変更が別の端末で重なっても、両方が残る（捨てたメモは戻らない）', () => {
  const pc = emptyLibrary();
  addThought(pc, { text: '元の文' }, T1, 'tq');
  const phone = structuredClone(pc);
  updateThought(pc, 'tq', { status: 'discarded' }, T2); // PC で捨てる
  updateThought(phone, 'tq', { text: 'スマホで直した文' }, T3); // 未同期のスマホで本文だけ直す（あとから）
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(m.thoughts.tq.text, 'スマホで直した文');
    assert.equal(m.thoughts.tq.status, 'discarded');
  }
  assert.deepEqual(mergeLibraries(pc, phone), mergeLibraries(phone, pc));
});

test('C3: 何も変えずに保存しても時刻を進めない（別の端末の新しい編集を負かさない）', () => {
  const pc = emptyLibrary();
  const t = addThought(pc, { text: '元の文' }, T1, 'tw');
  const phone = structuredClone(pc);
  updateThought(phone, t.id, { text: 'スマホで直した' }, T2);
  const same = updateThought(pc, t.id, { text: '元の文', status: 'inbox' }, T3);
  assert.equal(same.updatedAt, T1);
  assert.equal(mergeLibraries(pc, phone).thoughts.tw.text, 'スマホで直した');
});

test('mergeCollections: 3 つの端末をどの順に統合しても同じ・墓標どうしが同じ時刻でも向きに依らない', async () => {
  const { mergeCollections } = await import('../web/core/collections.js');
  const a = { t1: { id: 't1', text: 'a', updatedAt: T1 }, t2: { id: 't2', deleted: true, updatedAt: T2 } };
  const b = { t1: { id: 't1', text: 'b', updatedAt: T2 }, t2: { id: 't2', deleted: true, updatedAt: T2, createdAt: T1 } };
  const c = { t1: { id: 't1', text: 'c', updatedAt: T2 }, t3: { id: 't3', text: 'c3', updatedAt: T1 } };
  const opts = { stickyDelete: true };
  const m = (x, y) => mergeCollections(x, y, opts);
  const orders = [m(m(a, b), c), m(m(b, a), c), m(a, m(c, b)), m(m(c, a), b), m(c, m(b, a))];
  for (const o of orders) assert.deepEqual(o, orders[0]);
  assert.equal(orders[0].t2.deleted, true);
  assert.equal(orders[0].t1.updatedAt, T2);
  assert.deepEqual(a.t1, { id: 't1', text: 'a', updatedAt: T1 }, '引数は変えない');
});

test('G1-6: メモを検索・編集・削除できる', () => {
  const lib = emptyLibrary();
  const a = addThought(lib, { text: '朝の散歩で 考えがまとまる' }, T1);
  addThought(lib, { text: '夜は本を読む' }, T2);
  assert.deepEqual(searchThoughts(lib, '散歩 まとまる').map((t) => t.id), [a.id], '空白区切りの AND');
  updateThought(lib, a.id, { text: '朝の散歩で考えがほどける' }, T3);
  assert.equal(searchThoughts(lib, 'ほどける')[0].text, '朝の散歩で考えがほどける');
  assert.equal(searchPoints(lib, 'ほどける')[0].id, a.id, '点の検索にも出る');
  assert.deepEqual(searchPoints(lib, 'ほどける', { source: 'kindle' }), [], '本の読み方で絞ると出ない');
  assert.deepEqual(searchPoints(lib, '', { source: 'thought' }).map((t) => t.id).length, 2);
  deleteThought(lib, a.id, T3);
  assert.equal(pointById(lib, a.id), null);
  assert.deepEqual(searchThoughts(lib, '散歩'), []);
  assert.throws(() => updateThought(lib, a.id, { text: 'x' }), /メモが見つかりません/);
});

test('G1-2: PC とつながっていない間に書いたメモは端末のライブラリに残り、つながったら PC と同期される（別の端末にも届く）', async () => {
  const store = createStore(mkdtempSync(path.join(tmpdir(), 'bh-thought-')));
  const server = createCompanionServer({ store, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // スマホ: PC が止まっている間に書く（端末のライブラリにだけある）
    const phone = emptyLibrary();
    const t = addThought(phone, { text: '電車で思いついたこと' }, T1);
    assert.equal((await store.library()).thoughts?.[t.id], undefined);
    // つながったら同期（Web アプリの syncWithPc と同じ /api/library/merge）
    const merged = await (await fetch(`${base}/api/library/merge`, { method: 'POST', body: JSON.stringify(phone) })).json();
    assert.equal(merged.thoughts[t.id].text, '電車で思いついたこと');
    assert.equal((await store.library()).thoughts[t.id].text, '電車で思いついたこと', 'PC に保存された');
    // PC の画面（別の端末）でも同期すると出る
    const pcBrowser = mergeLibraries(emptyLibrary(), await (await fetch(`${base}/api/library/merge`, { method: 'POST', body: JSON.stringify(emptyLibrary()) })).json());
    assert.deepEqual(inboxThoughts(pcBrowser).map((x) => x.text), ['電車で思いついたこと']);
    // スマホで捨てると、PC でも捨てたままになる
    updateThought(phone, t.id, { status: 'discarded' }, T2);
    await fetch(`${base}/api/library/merge`, { method: 'POST', body: JSON.stringify(phone) });
    const again = await (await fetch(`${base}/api/library/merge`, { method: 'POST', body: JSON.stringify(pcBrowser) })).json();
    assert.equal(again.thoughts[t.id].status, 'discarded');
  } finally {
    server.close();
  }
});

test('どの問いへの答えかを持てる（形の違うものは捨てる）', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '答え', answerTo: { kind: 'solid', question: ' どうすれば続くのか？ ' } }, T1);
  assert.deepEqual(t.answerTo, { kind: 'solid', question: 'どうすれば続くのか？' });
  const l = addThought(lib, { text: '答え2', answerTo: { kind: 'line', id: 'labc', question: '問い' } }, T1);
  assert.deepEqual(l.answerTo, { kind: 'line', question: '問い', id: 'labc' });
  assert.equal(addThought(lib, { text: '答え3', answerTo: { kind: 'evil', question: 'x' } }, T1).answerTo, undefined);
});

// G3 永久ノート（残る抽象）: 作る・直す・消す・探す・同期、線とメモからの下書き、分析での扱い、点・線・面の画面からのつながり
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { addThought, thoughtsOf } from '../web/core/thoughts.js';
import { addNote, addNotePoint, deleteNote, liveNotes, noteDraftFromLine, noteFromThought, notesOf, searchNotes, updateNote } from '../web/core/notes.js';
import { missingEvidence, noteEvidence, notesCiting, notesSharingEvidence } from '../web/core/note-evidence.js';
import { currentPointId } from '../web/core/points.js';
import { applyImport, makeBackup } from '../web/core/importing.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { humanLines } from '../web/core/analysis/prompts.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const T = '2026-10-04T12:00:00.000Z';
const T2 = '2026-10-04T13:00:00.000Z';
const T3 = '2026-10-04T14:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

/** 永久ノートの操作（note-actions.js）に渡す偽のブラウザの部品。開いたシートと、保存・同期・移動の回数を残す */
async function fakeActions(state, { failPersist = false } = {}) {
  const { noteActions } = await import('../web/js/note-actions.js');
  const log = { sheets: [], toasts: [], persisted: 0, synced: 0, went: [], rendered: 0, later: [] };
  const actions = noteActions({
    state,
    openSheet: (content, onSubmit) => log.sheets.push({ html: String(content), submit: onSubmit }),
    toast: (m) => log.toasts.push(m),
    persist: async () => {
      if (failPersist) throw new Error('保存できませんでした');
      log.persisted++;
    },
    sync: () => log.synced++,
    render: () => log.rendered++,
    go: (h) => log.went.push(h),
    confirm: () => true,
    later: (fn) => log.later.push(fn),
  });
  return { actions, log };
}
/** シートの送信の中身（FormData の代わり） */
const form = (fields) => ({ get: (k) => (k in fields ? [].concat(fields[k])[0] : null), getAll: (k) => [].concat(fields[k] ?? []) });

test('G3-1: 永久ノートを作る・直す・消す・探す（題・本文・根拠の点 0 件以上）', () => {
  const lib = sampleLibrary();
  const [h1, h2] = Object.values(lib.highlights);
  const n = addNote(lib, { title: '  習慣は 仕組み  ', body: '意志より環境。\n小さく始める。', pointIds: [h1.id, h1.id, 'bad id', 7, h2.id] }, T, 'n1abc');
  assert.equal(n.title, '習慣は 仕組み');
  assert.equal(n.body, '意志より環境。\n小さく始める。', '本文の改行は残す');
  assert.deepEqual(n.pointIds, [h1.id, h2.id], '重ねない・形の違う ID は入れない');
  assert.throws(() => addNote(lib, { title: ' ', body: '' }), /題か本文/);
  assert.throws(() => addNote(lib, { title: 'x' }, T, 'bad'), /ID/);
  // 何も変わらなければ時刻を進めない（別の端末の新しい編集を負かさない）
  assert.equal(updateNote(lib, n.id, { title: '習慣は 仕組み', body: n.body }, T2), notesOf(lib)[n.id]);
  const u = updateNote(lib, n.id, { body: '環境を変える', pointIds: [h2.id] }, T2);
  assert.deepEqual([u.title, u.body, u.pointIds, u.updatedAt], ['習慣は 仕組み', '環境を変える', [h2.id], T2]);
  assert.equal(addNotePoint(lib, n.id, h1.id, T3).pointIds.join(), [h2.id, h1.id].join());
  assert.equal(addNotePoint(lib, n.id, h1.id, '2026-10-04T15:00:00.000Z').updatedAt, T3, 'もう入っている点は足さない');
  // 根拠の点が 0 件のノートも作れる
  addNote(lib, { title: '根拠なしの考え', body: '' }, T, 'n2abc');
  // 探す（題・本文。空白で AND）
  assert.deepEqual(searchNotes(lib, '環境 仕組み').map((x) => x.id), [n.id]);
  assert.deepEqual(searchNotes(lib, '根拠なし').map((x) => x.id), ['n2abc']);
  assert.deepEqual(searchNotes(lib, '関係のない言葉'), []);
  // 消す: 墓標だけ残し、一覧・検索から消える
  deleteNote(lib, n.id, T3);
  assert.deepEqual(notesOf(lib)[n.id], { id: n.id, deleted: true, createdAt: T, updatedAt: T3 });
  assert.deepEqual(liveNotes(lib).map((x) => x.id), ['n2abc']);
  assert.throws(() => updateNote(lib, n.id, { title: '戻す' }), /見つかりません/);
});

test('G3-1 / C3: 永久ノートは同期・バックアップの取り込みで失われず、向きに依らない。消したものは戻らない。壊れた値は捨てる', () => {
  const phone = emptyLibrary();
  const pc = emptyLibrary();
  addNote(phone, { title: 'スマホで書いた' }, '2026-10-04T10:00:00.000Z', 'nphone1');
  addNote(pc, { title: 'PC で書いた', body: '本文' }, '2026-10-04T09:00:00.000Z', 'npc1');
  addNote(phone, { title: '共通 v1' }, '2026-10-04T08:00:00.000Z', 'nboth1');
  pc.notes = { ...notesOf(pc), nboth1: { ...notesOf(phone).nboth1, title: '共通 v2', updatedAt: '2026-10-04T11:00:00.000Z' } };
  const ab = mergeLibraries(phone, pc);
  const ba = mergeLibraries(pc, phone);
  assert.deepEqual(ab.notes, ba.notes, '向きに依らない');
  assert.equal(ab.notes.nboth1.title, '共通 v2', '書き直した時刻が新しい方');
  assert.deepEqual(Object.keys(ab.notes).sort(), ['nboth1', 'npc1', 'nphone1']);
  // 消したものは、消していない端末から来ても戻らない（どちら向きでも）
  deleteNote(ab, 'npc1', '2026-10-04T12:00:00.000Z');
  for (const m of [mergeLibraries(ab, pc), mergeLibraries(pc, ab)]) assert.equal(m.notes.npc1.deleted, true);
  // バックアップの取り込み・古い形のデータ（notes が無い）との統合
  const restored = applyImport({ library: emptyLibrary() }, { backups: [makeBackup(ab, null)] }).library;
  assert.deepEqual(restored.notes, ab.notes);
  // 古い形のデータ（notes の欄が無い）と統合しても、ノートは 1 件も失われない（どちら向きでも）
  const legacy = { version: 1, books: {}, highlights: {}, feedback: {}, updatedAt: null };
  assert.ok(!('notes' in legacy));
  assert.deepEqual(mergeLibraries(legacy, ab).notes, ab.notes);
  assert.deepEqual(mergeLibraries(ab, legacy).notes, ab.notes);
  assert.deepEqual(notesOf(legacy), {});
  // 壊れた値: ID の形が違う・題も本文も無い・文字でない題は捨てる。点の ID と「何から作ったか」は形を確かめる
  const incoming = { ...emptyLibrary(), notes: { 'bad id': { title: 'x' }, nempty1: { title: '', body: ' ' }, nnum1: { title: 5 }, nok1: { title: 'よい', body: 'b', pointIds: ['h1', 'x!', 7, 'h1'], from: { kind: 'evil', id: 'x' }, createdAt: T, updatedAt: T } } };
  const m = mergeLibraries(emptyLibrary(), incoming);
  assert.deepEqual(Object.keys(m.notes), ['nok1']);
  assert.deepEqual(m.notes.nok1, { id: 'nok1', title: 'よい', body: 'b', pointIds: ['h1'], createdAt: T, updatedAt: T });
});

test('同期で届いた長すぎる題・根拠の点で止まらず、壊れた時刻はいつまでも勝ち続けない（ノート・思いつき）', () => {
  // 題は 500 万字・根拠の点は 10 万件（先に切ってから整える）
  const t0 = performance.now();
  const big = mergeLibraries(emptyLibrary(), { ...emptyLibrary(), notes: { nbig1: { title: 'あ'.repeat(5_000_000), body: 'b', pointIds: Array.from({ length: 100_000 }, (_, i) => `h${i.toString(36)}`), createdAt: T, updatedAt: T } } });
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
  assert.equal([...big.notes.nbig1.title].length, 100);
  assert.equal(big.notes.nbig1.pointIds.length, 200);
  // 時刻の形でない値は ''（いちばん古い扱い）にする。あとからの本物の編集が、どちら向きの統合でも勝つ
  const bad = mergeLibraries(emptyLibrary(), { ...emptyLibrary(), notes: { nz1: { title: '古い', createdAt: 'x'.repeat(5000), updatedAt: 'zzzz' } }, thoughts: { tz1: { text: '古いメモ', createdAt: 'zzzz', updatedAt: 'zzzz', statusAt: 'zzzz' } } });
  assert.deepEqual([bad.notes.nz1.createdAt, bad.notes.nz1.updatedAt], ['', '']);
  assert.deepEqual([bad.thoughts.tz1.createdAt, bad.thoughts.tz1.updatedAt, bad.thoughts.tz1.statusAt], ['', '', '']);
  const real = { ...emptyLibrary(), notes: { nz1: { id: 'nz1', title: '新しい', body: '', pointIds: [], createdAt: T, updatedAt: T } }, thoughts: { tz1: { id: 'tz1', text: '新しいメモ', status: 'done', statusAt: T, createdAt: T, updatedAt: T } } };
  for (const m of [mergeLibraries(bad, real), mergeLibraries(real, bad)]) {
    assert.equal(m.notes.nz1.title, '新しい');
    assert.deepEqual([m.thoughts.tz1.text, m.thoughts.tz1.status], ['新しいメモ', 'done']);
  }
});

test('G3-2: 線を下書きにした永久ノートを 1 回の操作で作れる（名前・説明・問いと、線の点を根拠に写す）。作ったあとは書き換えられる', () => {
  const lib = sampleLibrary();
  const hs = Object.values(lib.highlights).slice(0, 4).map((h) => h.id);
  const line = { id: 'l1', name: '仕組みが行動をつくる', summary: '意志より環境を整える方が続く。', insight: '明日の環境をどう変えるか', highlightIds: hs };
  const n = addNote(lib, noteDraftFromLine(line), T, 'nline1');
  assert.equal(n.title, '仕組みが行動をつくる');
  assert.equal(n.body, '意志より環境を整える方が続く。\n\n問い: 明日の環境をどう変えるか');
  assert.deepEqual(n.pointIds, hs);
  assert.deepEqual(n.from, { kind: 'line', id: 'l1', name: '仕組みが行動をつくる' });
  const edited = updateNote(lib, n.id, { title: '環境が先、意志はあと', body: '自分の言葉で書き直した', pointIds: hs.slice(0, 2) }, T2);
  assert.deepEqual([edited.title, edited.body, edited.pointIds.length], ['環境が先、意志はあと', '自分の言葉で書き直した', 2]);
  // 古い分析に残る消えた点は根拠に写さない
  updateHighlight(lib, hs[3], { deleted: true });
  assert.deepEqual(noteDraftFromLine(line, (id) => !lib.highlights[id].deleted).pointIds, hs.slice(0, 3));
});

test('G3-2: 線の画面で 1 回押すだけで作り、作ったノートを開く（連打しても 1 件。端末に保存して同期する）', async () => {
  const lib = sampleLibrary();
  const hs = Object.values(lib.highlights).slice(0, 3).map((h) => h.id);
  const state = { loaded: true, library: lib, analysis: { lines: [{ id: 'l1', name: '線', summary: '説明', insight: '', highlightIds: hs }] } };
  const { actions, log } = await fakeActions(state);
  await Promise.all([actions['line-to-note']({ dataset: { id: 'l1' } }), actions['line-to-note']({ dataset: { id: 'l1' } })]);
  const notes = liveNotes(lib);
  assert.equal(notes.length, 1, '連打しても 1 件');
  assert.deepEqual(notes[0].pointIds, hs);
  assert.deepEqual(log.went, [`#/note/${notes[0].id}`]);
  assert.deepEqual([log.persisted, log.synced], [1, 1]);
  // 読み込みが終わる前は作らない
  const early = await fakeActions({ ...state, loaded: false });
  await early.actions['line-to-note']({ dataset: { id: 'l1' } });
  assert.equal(liveNotes(lib).length, 1);
  assert.match(early.log.toasts[0], /読み込んでいます/);
});

test('G3-3: 受け箱のメモから 1 回の操作で永久ノートを作れる（メモは整理済みになり、根拠として残る）', () => {
  const lib = sampleLibrary();
  const t = addThought(lib, { text: '集中は環境で決まる\nスマホを別の部屋に置くと読める' }, T);
  const n = noteFromThought(lib, t.id, T2, 'nthought1');
  assert.equal(n.title, '集中は環境で決まる', 'メモの 1 行目を題に');
  assert.equal(n.body, t.text);
  assert.deepEqual(n.pointIds, [t.id], 'メモを根拠に');
  assert.deepEqual(n.from, { kind: 'thought', id: t.id });
  assert.equal(thoughtsOf(lib)[t.id].status, 'done', 'メモは整理済みに');
  assert.ok(noteEvidence(lib, n)[0].point, '根拠のメモは残る（分析の点のまま）');
  assert.throws(() => noteFromThought(lib, 'tnothing'), /見つかりません/);
  assert.throws(() => noteFromThought(lib, t.id), /もう整理しています/, '整理済みのメモからもう 1 件は作らない');
  assert.equal(liveNotes(lib).length, 1);
});

test('G3-3: 受け箱のカードで 1 回押すだけで作る（連打しても 1 件。作ったノートを開き、保存して同期する）', async () => {
  const lib = sampleLibrary();
  const t = addThought(lib, { text: '押すだけで永久ノートに' }, T);
  const { actions, log } = await fakeActions({ loaded: true, library: lib, analysis: null });
  await Promise.all([actions['thought-to-note']({ dataset: { id: t.id } }), actions['thought-to-note']({ dataset: { id: t.id } })]);
  assert.equal(liveNotes(lib).length, 1);
  assert.equal(thoughtsOf(lib)[t.id].status, 'done');
  assert.deepEqual([log.went.length, log.persisted, log.synced], [1, 1, 1]);
});

test('G3-1: 書く・直す・消すシート（変えた欄だけを保存する・消すのは保存できてから画面を移る・根拠にするシートから書くシートへ）', async () => {
  const lib = sampleLibrary();
  const hs = Object.values(lib.highlights).slice(0, 3).map((h) => h.id);
  const state = { loaded: true, library: lib, analysis: null };
  const { actions, log } = await fakeActions(state);
  // 書く（点のページから: その点を根拠に）
  actions['new-note']({ dataset: { point: hs[0] } });
  assert.match(log.sheets[0].html, new RegExp(`name="point" value="${hs[0]}" checked`));
  await log.sheets[0].submit(form({ title: '書いた題', body: '本文', point: [hs[0]] }), 'save');
  const [n] = liveNotes(lib);
  assert.deepEqual([n.title, n.pointIds], ['書いた題', [hs[0]]]);
  assert.deepEqual(log.went, [`#/note/${n.id}`]);
  // 直す: シートを開いている間に別の端末で本文が書き直された → 題だけ直して保存しても、本文は別の端末のまま
  actions['edit-note']({ dataset: { id: n.id } });
  lib.notes = { ...lib.notes, [n.id]: { ...lib.notes[n.id], body: '別の端末で書き直した本文', updatedAt: T2 } };
  await log.sheets[1].submit(form({ title: '直した題', body: '本文\r\n', point: [hs[0]] }), 'save');
  assert.deepEqual([notesOf(lib)[n.id].title, notesOf(lib)[n.id].body], ['直した題', '別の端末で書き直した本文']);
  // 何も変えずに保存しても時刻は進まない（\r\n で届いた改行も同じ文とみなす）
  const before = notesOf(lib)[n.id].updatedAt;
  actions['edit-note']({ dataset: { id: n.id } });
  await log.sheets[2].submit(form({ title: '直した題', body: '別の端末で書き直した本文', point: [hs[0]] }), 'save');
  assert.equal(notesOf(lib)[n.id].updatedAt, before);
  // 根拠の点を外す（チェックを外した点だけが消える）
  addNote(lib, { title: '根拠 2 つ', pointIds: [hs[1], hs[2]] }, T, 'ntwo1');
  actions['edit-note']({ dataset: { id: 'ntwo1' } });
  await log.sheets[3].submit(form({ title: '根拠 2 つ', body: '', point: [hs[2]] }), 'save');
  assert.deepEqual(notesOf(lib).ntwo1.pointIds, [hs[2]]);
  // 消す: 保存に失敗したら画面を移らない
  const failing = await fakeActions(state, { failPersist: true });
  failing.actions['edit-note']({ dataset: { id: 'ntwo1' } });
  await assert.rejects(failing.log.sheets[0].submit(form({}), 'delete'), /保存できませんでした/);
  assert.deepEqual(failing.log.went, []);
  // 根拠にするシート: ノートを選んで根拠に足す・「新しいノートを書く」はシートが閉じてから書くシートを開く
  actions['cite-point']({ dataset: { id: hs[1] } });
  const cite = log.sheets.at(-1);
  await cite.submit(form({ note: n.id }), 'save');
  assert.deepEqual(notesOf(lib)[n.id].pointIds, [hs[0], hs[1]]);
  actions['cite-point']({ dataset: { id: hs[2] } });
  await log.sheets.at(-1).submit(form({}), 'new');
  const opened = log.sheets.length;
  assert.equal(log.later.length, 1, 'すぐには開かない');
  log.later[0]();
  assert.equal(log.sheets.length, opened + 1);
  assert.match(log.sheets.at(-1).html, new RegExp(`name="point" value="${hs[2]}" checked`));
});

test('G3-4: 分析し直しても永久ノートは変わらない。根拠の点が消えたら「消えた」と分かり、ノートは残る（伸ばしたハイライトはたどる）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    // 伸ばせるハイライト（Kindle・位置あり）と、消す点
    const h1 = Object.values(lib.highlights).find((h) => h.source === 'kindle' && h.location != null);
    const h2 = Object.values(lib.highlights).find((h) => h.id !== h1.id);
    addNote(lib, { title: '残る考え', body: '自分で書いた', pointIds: [h1.id, h2.id] }, T, 'nkeep1');
    const before = structuredClone(notesOf(lib));
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const first = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), options: { recommend: false } })).analysis;
    await analyzeLibrary({ library: lib, llm, previous: first, options: { recommend: false, full: true } });
    assert.deepEqual(notesOf(lib), before, 'AI は書き換えない');
    // 根拠の点を消す
    updateHighlight(lib, h2.id, { deleted: true });
    const n = notesOf(lib).nkeep1;
    assert.equal(missingEvidence(lib, n), 1);
    assert.deepEqual(noteEvidence(lib, n).map((e) => Boolean(e.point)), [true, false]);
    // Kindle で伸ばしたハイライト（置き換わった点）は、置き換わった先をたどる（消えたことにしない）
    mergeParsed(lib, [{ title: lib.books[h1.bookId].title, author: lib.books[h1.bookId].author, source: 'kindle', highlights: [{ text: `${h1.text}さらに続く文。`, location: h1.location }] }], { now: T2 });
    const longer = Object.values(lib.highlights).find((h) => h.text === `${h1.text}さらに続く文。`);
    assert.equal(lib.highlights[h1.id].supersededBy, longer.id, '伸ばしたハイライトに置き換わった（試験の前提）');
    assert.equal(currentPointId(lib, h1.id), longer.id);
    assert.equal(noteEvidence(lib, n)[0].point.id, longer.id);
    assert.equal(missingEvidence(lib, n), 1, '伸ばした点は消えたことにしない');
    assert.deepEqual(notesCiting(lib, new Set([longer.id])).map((x) => x.id), ['nkeep1'], '伸ばした点の画面からもノートへ行ける');
    assert.deepEqual(notesCiting(lib, new Set([h1.id])).map((x) => x.id), ['nkeep1'], '古い分析に残る伸ばす前の ID からも');
    // 伸ばしたあとの点を、伸ばす前の点で根拠にしているノートに足しても重ならない。根拠にするシートにも出さない
    assert.equal(addNotePoint(lib, 'nkeep1', longer.id, T3).pointIds.length, 2);
    const { citeSheet } = await import('../web/js/views/notes.js');
    assert.doesNotMatch(String(citeSheet(lib, longer)), /value="nkeep1"/);
    // 画面: 「根拠の点が消えた」と出て、ノートは開ける
    const { noteView } = await import('../web/js/views/notes.js');
    const out = String(noteView.render({ state: { library: lib, analysis: first }, params: { id: 'nkeep1' } }));
    assert.match(out, /根拠の点が 1 件消えました/);
    assert.match(out, /この点は消えました。/);
    assert.match(out, /<h1 class="note-h1">残る考え<\/h1>/);
  } finally {
    await fake.close();
  }
});

test('G3-5: 永久ノートは分析の材料になる。根拠の点がある面と立体を作る AI に「人間がまとめた線」として入る（書き直すと作り直す）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const prompts = (from, name) => fake.calls.bodies.slice(from).filter((b) => b.response_format?.json_schema?.name === name).map((b) => b.messages[1].content);
    // ノートが無いときは、前と同じ依頼文（「人間がまとめた線」は出ない）
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    assert.ok(prompts(0, 'plane').every((p) => !p.includes('人間がまとめた線')));
    assert.ok(prompts(0, 'solid').every((p) => !p.includes('人間がまとめた線')));
    // 面 1 つの点を根拠にしたノートを書く
    const plane = first.planes[0];
    const pts = first.lines.filter((l) => plane.lineIds.includes(l.id)).flatMap((l) => l.highlightIds).slice(0, 2);
    addNote(lib, { title: '自分でまとめた線<題>', body: '面をまたぐ自分の考え', pointIds: pts }, T, 'nhuman1');
    const from = fake.calls.bodies.length;
    const second = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    const planeAsks = prompts(from, 'plane');
    assert.equal(planeAsks.length, 1, 'ノートの根拠がある面だけ作り直す');
    assert.match(planeAsks[0], /人間がまとめた線/);
    assert.match(planeAsks[0], /\[N1\] 自分でまとめた線<題>: 面をまたぐ自分の考え/);
    const solidAsks = prompts(from, 'solid');
    assert.equal(solidAsks.length, 1);
    assert.match(solidAsks[0], /人間がまとめた線[\s\S]*自分でまとめた線<題>/);
    // 変わらなければ呼び直さない。書き直したら作り直す
    const again = fake.calls.bodies.length;
    await analyzeLibrary({ library: lib, llm, cache, previous: second, options: { recommend: false } });
    assert.equal(prompts(again, 'plane').length + prompts(again, 'solid').length, 0);
    updateNote(lib, 'nhuman1', { body: '書き直した考え' }, T2);
    const edited = fake.calls.bodies.length;
    await analyzeLibrary({ library: lib, llm, cache, previous: second, options: { recommend: false } });
    assert.match(prompts(edited, 'plane')[0], /書き直した考え/);
    assert.equal(prompts(edited, 'solid').length, 1);
    assert.equal(humanLines([]), '');
  } finally {
    await fake.close();
  }
});

test('G3-5: AI に見せる永久ノートは、面ごとに新しく直した 6 件・立体に 12 件まで。線から作って直していない下書きは見せない。見せない部分を直しても作り直さない', async () => {
  const lib = sampleLibrary();
  const asked = [];
  const llm = {
    chatModel: 'stub',
    chatJson: async (p) => (asked.push(p), p.name === 'line' ? { name: `線${asked.length}`, summary: '要約', insight: '', keywords: [] } : p.name === 'plane' ? { name: `面${asked.length}`, summary: '要約' } : p.name === 'far' ? { shared: false } : { title: '核', core: '', relations: [], principles: [], questions: [] }),
  };
  const cache = emptyCache();
  const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
  const plane = first.planes[0];
  const pts = first.lines.filter((l) => plane.lineIds.includes(l.id)).flatMap((l) => l.highlightIds);
  // 同じ面の点を根拠にしたノート 14 件（番号が大きいほど新しく直した）
  for (let i = 0; i < 14; i++) addNote(lib, { title: `ノート${i}`, body: `本文${i}`, pointIds: [pts[i % pts.length]] }, `2026-10-04T12:${String(i).padStart(2, '0')}:00.000Z`, `nlim${i.toString(36)}`);
  // 線から作って一度も直していない下書き（中身は AI の線のまま）
  addNote(lib, noteDraftFromLine({ id: first.lines[0].id, name: '線の名前そのまま', summary: '線の説明そのまま', insight: '', highlightIds: pts.slice(0, 2) }), '2026-10-04T13:00:00.000Z', 'ndraft1');
  const run = async (prev) => {
    const from = asked.length;
    const a = (await analyzeLibrary({ library: lib, llm, cache, previous: prev, options: { recommend: false } })).analysis;
    return { a, planeAsk: asked.slice(from).find((p) => p.name === 'plane' && p.user.includes('人間がまとめた線'))?.user || '', solidAsk: asked.slice(from).find((p) => p.name === 'solid')?.user || '' };
  };
  const second = await run(first);
  assert.deepEqual([...second.planeAsk.matchAll(/\[N\d+\] (ノート\d+)/g)].map((m) => m[1]), ['ノート13', 'ノート12', 'ノート11', 'ノート10', 'ノート9', 'ノート8'], '面には新しく直した 6 件');
  assert.equal([...second.solidAsk.matchAll(/\[N\d+\] /g)].length, 12, '立体には 12 件');
  assert.doesNotMatch(second.planeAsk + second.solidAsk, /線の名前そのまま/, '直していない下書きは見せない');
  // 下書きを直したら見せる
  updateNote(lib, 'ndraft1', { body: '自分の言葉に直した' }, '2026-10-04T14:00:00.000Z');
  const third = await run(second.a);
  assert.match(third.planeAsk, /\[N1\] 線の名前そのまま: 自分の言葉に直した/);
  // 本文の 200 字より先（AI に見せない部分）だけを直しても、面・立体は作り直さない
  updateNote(lib, 'ndraft1', { body: `${'あ'.repeat(210)}前` }, '2026-10-04T15:00:00.000Z');
  const fourth = await run(third.a);
  assert.ok(fourth.planeAsk && fourth.solidAsk, '見せる部分が変わったので作り直す');
  updateNote(lib, 'ndraft1', { body: `${'あ'.repeat(210)}後` }, '2026-10-04T16:00:00.000Z');
  const fifth = await run(fourth.a);
  assert.deepEqual([fifth.planeAsk, fifth.solidAsk], ['', ''], '見せない部分だけなら呼び直さない');
});

/** 画面を描くための状態（サンプルの点で線 1 本・面 1 つの分析） */
function noteState() {
  const library = sampleLibrary();
  const hs = Object.values(library.highlights);
  const ids = hs.slice(0, 3).map((h) => h.id);
  const analysis = {
    createdAt: T,
    stats: { points: 48, calls: { chat: 0, embed: 0 } },
    model: { chat: 'fake', embed: 'fake-embed' },
    lines: [{ id: 'l1', name: '仕組みの線', summary: '仕組みが行動をつくる', insight: '環境をどう変えるか', keywords: [], highlightIds: ids, bookIds: [] }],
    planes: [{ id: 'p1', name: '習慣の面', summary: '習慣のテーマ', lineIds: ['l1'] }],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
  };
  return { state: { library, analysis, settings: { ai: { mode: 'direct', companionUrl: '' }, autoSync: false }, servedByCompanion: false, pcInfo: null, job: null }, ids, hs };
}

test('G3-6: 点・線・面の画面から、それを根拠にしている永久ノートへ行ける', async () => {
  const { lineView, planeView } = await import('../web/js/views/knowledge.js');
  const { pointView } = await import('../web/js/views/point.js');
  const { state, ids, hs } = noteState();
  addNote(state.library, { title: '線の点を使ったノート', pointIds: [ids[1]] }, T, 'ncite1');
  addNote(state.library, { title: '関係ないノート', pointIds: [hs[10].id] }, T, 'nother1');
  const line = String(lineView.render({ state, params: { id: 'l1' } }));
  assert.match(line, /この線の点を根拠にしている永久ノート/);
  assert.match(line, /href="#\/note\/ncite1"/);
  assert.doesNotMatch(line, /nother1/);
  assert.match(line, /data-action="line-to-note" data-id="l1">この線を永久ノートにする<\/button>/);
  const plane = String(planeView.render({ state, params: { id: 'p1' } }));
  assert.match(plane, /この面の点を根拠にしている永久ノート/);
  assert.match(plane, /href="#\/note\/ncite1"/);
  const point = String(pointView.render({ state, params: { id: ids[1] } }));
  assert.match(point, /この点を根拠にしている永久ノート/);
  assert.match(point, /href="#\/note\/ncite1"/);
  assert.match(point, /data-action="new-note" data-point="[^"]+">この点を根拠に永久ノートを書く<\/button>/);
  assert.match(point, /data-action="cite-point"/);
  assert.doesNotMatch(String(pointView.render({ state, params: { id: ids[0] } })), /この点を根拠にしている永久ノート/);
  assert.match(String(pointView.render({ state, params: { id: 'hnothing' } })), /この点は見つかりません/);
  // 点のカードから点の画面へ行ける（読み上げに名前がある）
  assert.match(line, /<a class="icon-btn" href="#\/point\/[^"]+" aria-label="点のページを開く（永久ノート）">↗<\/a>/);
  assert.deepEqual(notesCiting(state.library, new Set([ids[1]])).map((n) => n.id), ['ncite1']);
});

test('NIH-150: 永久ノートの画面に、根拠の点が重なるほかの永久ノートが出る（自分・消したノートは出さない。無ければ何も出ない）', async () => {
  const { noteView } = await import('../web/js/views/notes.js');
  const { state, ids, hs } = noteState();
  addNote(state.library, { title: '自分のノート', pointIds: [ids[0], ids[1]] }, T, 'nself1');
  addNote(state.library, { title: '<i>重なる</i>ノート', pointIds: [ids[1], ids[2]] }, T2, 'nover1');
  addNote(state.library, { title: '消したノート', pointIds: [ids[0]] }, T, 'ngone1');
  deleteNote(state.library, 'ngone1', T2);
  addNote(state.library, { title: '関係ないノート', pointIds: [hs[10].id] }, T, 'nother1');
  addNote(state.library, { title: '根拠の無いノート' }, T, 'nempty1');
  assert.deepEqual(notesSharingEvidence(state.library, notesOf(state.library).nself1).map((n) => n.id), ['nover1']);
  const out = String(noteView.render({ state, params: { id: 'nself1' } }));
  assert.match(out, /<h2>根拠が重なる永久ノート<\/h2>/);
  assert.match(out, /href="#\/note\/nover1"/);
  assert.match(out, /&lt;i&gt;重なる&lt;\/i&gt;ノート/);
  assert.doesNotMatch(out, /href="#\/note\/nself1"/, '自分は出さない');
  assert.doesNotMatch(out, /ngone1|nother1|nempty1/);
  // 重なる側からも戻れる
  assert.match(String(noteView.render({ state, params: { id: 'nover1' } })), /href="#\/note\/nself1"/);
  // 重なるノートが無ければ何も出ない（根拠の無いノートも）
  assert.doesNotMatch(String(noteView.render({ state, params: { id: 'nother1' } })), /根拠が重なる永久ノート/);
  assert.doesNotMatch(String(noteView.render({ state, params: { id: 'nempty1' } })), /根拠が重なる永久ノート/);
});

test('G3-1 / C8: ノートの一覧・ノートの画面・書くシート・検索（文字はエスケープする。受け箱のメモに「永久ノートにする」）', async () => {
  const { notesView, noteView, noteSheet, citeSheet, notesSummaryBlock } = await import('../web/js/views/notes.js');
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { home } = await import('../web/js/views/library.js');
  const { state, ids } = noteState();
  addNote(state.library, { title: '<b>題</b>', body: '本文 <img src=x onerror=alert(1)>\n2 行目', pointIds: [ids[0]], from: { kind: 'line', id: 'l1', name: '仕組みの線' } }, T, 'nui1');
  addNote(state.library, { title: '別のノート', body: '' }, T2, 'nui2');
  const list = String(notesView.render({ state, query: new URLSearchParams() }));
  assert.match(list, /<h1>永久ノート<\/h1>/);
  assert.match(list, /data-action="new-note">＋ ノート<\/button>/);
  assert.match(list, /<span class="note-title">&lt;b&gt;題&lt;\/b&gt;<\/span>/);
  assert.doesNotMatch(list, /<img src=x/);
  assert.match(list, /aria-label="永久ノートを探す"/);
  assert.match(String(notesView.render({ state, query: new URLSearchParams('q=別の') })), /1 件/);
  const page = String(noteView.render({ state, params: { id: 'nui1' } }));
  assert.match(page, /<h1 class="note-h1">&lt;b&gt;題&lt;\/b&gt;<\/h1>/);
  assert.match(page, /<a href="#\/knowledge\/line\/l1">線\(グループ\)「仕組みの線」<\/a>から作成/);
  assert.match(page, /data-action="edit-note" data-id="nui1"/);
  assert.equal((page.match(/<article class="hl"/g) || []).length, 1, '根拠の点のカード');
  assert.match(String(noteView.render({ state, params: { id: 'nnothing' } })), /このノートは見つかりません/);
  // 書くシート: 題・本文・根拠の点（チェックを外すと外れる）。新しく書くときは削除ボタンが無い
  const sheet = String(noteSheet(state.library, notesOf(state.library).nui1));
  assert.match(sheet, /<input type="text" name="title" maxlength="100" value="&lt;b&gt;題&lt;\/b&gt;"/);
  assert.match(sheet, /<textarea name="body" rows="8" maxlength="10000"/);
  assert.match(sheet, /<input type="checkbox" name="point" value="[^"]+" checked>/);
  assert.match(sheet, /value="delete">このノートを削除/);
  assert.doesNotMatch(String(noteSheet(state.library, null)), /value="delete"/);
  assert.match(String(noteSheet(state.library, null, [ids[1]])), /name="point" value="[^"]+" checked/);
  // 根拠にするシート: まだ根拠にしていないノートだけを選べる
  const cite = String(citeSheet(state.library, state.library.highlights[ids[0]]));
  assert.match(cite, /value="nui2"/);
  assert.doesNotMatch(cite, /value="nui1"/);
  // 知識の画面に永久ノートの欄
  assert.match(String(knowledge.render({ state })), /<h2>永久ノート<\/h2><a class="small" href="#\/notes">すべて見る（2）<\/a>/);
  assert.match(String(notesSummaryBlock({ ...state, library: emptyLibrary() })), /この線を永久ノートにする/);
  // 受け箱のメモに「永久ノートにする」
  addThought(state.library, { text: '受け箱のメモ' }, T);
  assert.match(String(home.render({ state, shuffle: 0 })), /data-action="thought-to-note" data-id="t[0-9a-z]+">永久ノートにする<\/button>/);
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  for (const f of ['core/notes.js', 'core/note-evidence.js', 'core/point-ids.js', 'js/views/notes.js', 'js/views/point.js', 'js/note-actions.js']) assert.ok(sw.includes(`'${f}'`), `${f} をオフライン用に持つ`);
});

test('G3-1: 検索の画面に、検索語に当たる永久ノートが出る（点とは分けて、先頭 5 件と件数）', async () => {
  const { search } = await import('../web/js/views/library.js');
  const { state } = noteState();
  for (let i = 0; i < 6; i++) addNote(state.library, { title: `環境のノート${i}`, body: '' }, `2026-10-04T12:0${i}:00.000Z`, `nsearch${i}`);
  addNote(state.library, { title: '関係ないノート' }, T, 'nsearchx');
  // 検索の画面は描いたあとに結果を差し込むので、差し込み先だけの小さな DOM で確かめる
  const boxes = { '#search-filters': { innerHTML: '' }, '#search-results': { innerHTML: '' }, '#search-wishlist': { innerHTML: '' } };
  const root = { querySelector: (sel) => boxes[sel] || { addEventListener() {}, value: '環境' } };
  const query = new URLSearchParams('q=環境');
  search.mount(root, { state, query });
  const out = boxes['#search-results'].innerHTML;
  assert.match(out, /<h2>永久ノート<\/h2><a class="small" href="#\/notes\?q=%E7%92%B0%E5%A2%83">永久ノートで見る（6 件）<\/a>/);
  assert.equal((out.match(/class="note-item"/g) || []).length, 5);
  assert.doesNotMatch(out, /関係ないノート/);
});

test('画面: シートでチェックボックス・ラジオボタンの上で Enter を押しても「保存」になる。PC を設定していない画面は、編集のたびに localhost の PC へ同期しない', () => {
  const ui = readFileSync(join(WEB, 'js/ui.js'), 'utf8');
  assert.match(ui, /const TEXT_INPUT = \/\^\(text\|search\|url\|email\|tel\|number\|password\|checkbox\|radio\)\$\/;/);
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const body = app.slice(app.indexOf('function autoSyncAfterChange() {'), app.indexOf('\n}\n', app.indexOf('function autoSyncAfterChange() {')));
  assert.match(body, /if \(!canAutoSync\(\)\) return;/);
});

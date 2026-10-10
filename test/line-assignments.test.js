// #66 受け箱の思いつきを、自分で選んだ線(グループ)に入れる（外せる・同期される・分析し直しても消えない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { addThought, deleteThought, updateThought } from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { analyzeLibrary } from '../web/core/analysis/pipeline.js';
import { assignThoughtToLine, assignedThoughtIds, lineAssignmentOf, unassignThought } from '../web/core/line-assignments.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';
const LINE = { id: 'l1', name: '仕組みの線' };

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

function analysisOf(lib, lines = [{ id: 'l1', name: '仕組みの線' }, { id: 'l2', name: '注意の線' }]) {
  const [a, b, c, d] = Object.keys(lib.highlights);
  return {
    version: 2,
    createdAt: T1,
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48 },
    lines: lines.map((l, i) => ({ ...l, summary: '要約', insight: '', keywords: [], highlightIds: i ? [c, d] : [a, b], bookIds: [] })),
    planes: [{ id: 'p1', name: '面', summary: '要約', lineIds: lines.map((l) => l.id) }],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, loaded: true, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null });

test('#66: 思いつきを線(グループ)に入れる・外す。入れたものは、その線(グループ)の点として数える', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '朝に重い仕事をする' }, T1);
  assignThoughtToLine(lib, t.id, LINE, T2);
  assert.deepEqual(lineAssignmentOf(lib, t.id), { lineId: 'l1', lineName: '仕組みの線' });
  assert.deepEqual(assignedThoughtIds(lib, 'l1'), [t.id]);
  assert.ok(lib.updatedAt >= T2, '同期で届くよう、ライブラリの更新時刻を進める');
  unassignThought(lib, t.id, T3);
  assert.equal(lineAssignmentOf(lib, t.id), null);
  assert.deepEqual(assignedThoughtIds(lib, 'l1'), []);
  // 無いメモ・線の ID の形が違うものは入れない
  assert.throws(() => assignThoughtToLine(lib, 'tnothere', LINE, T3), /メモが見つかりません/);
  assert.throws(() => assignThoughtToLine(lib, t.id, { id: '../x', name: 'x' }, T3), /線\(グループ\)/);
});

test('#66: 消した・捨てたメモは、線(グループ)の点に出さない（入れた記録は残る）', () => {
  const lib = emptyLibrary();
  const a = addThought(lib, { text: '捨てるメモ' }, T1);
  const b = addThought(lib, { text: '消すメモ' }, T1);
  assignThoughtToLine(lib, a.id, LINE, T2);
  assignThoughtToLine(lib, b.id, LINE, T2);
  updateThought(lib, a.id, { status: 'discarded' }, T3);
  deleteThought(lib, b.id, T3);
  assert.deepEqual(assignedThoughtIds(lib, 'l1'), []);
});

test('#66: 入れた・外したことは同期・バックアップで残る（新しい方。どちら向きに統合しても同じ）', () => {
  const pc = emptyLibrary();
  const t = addThought(pc, { text: 'メモ' }, T1);
  const phone = structuredClone(pc);
  assignThoughtToLine(phone, t.id, LINE, T2);
  const merged = mergeLibraries(pc, phone);
  assert.deepEqual(lineAssignmentOf(merged, t.id), { lineId: 'l1', lineName: '仕組みの線' });
  // PC で外した（あと）→ スマホの入れた（前）より新しいので外れたまま
  unassignThought(merged, t.id, T3);
  assert.equal(lineAssignmentOf(mergeLibraries(merged, phone), t.id), null);
  assert.equal(lineAssignmentOf(mergeLibraries(phone, merged), t.id), null);
});

test('#66: 同期で届いた壊れた値は捨て、手元の記録を壊さない（__proto__ の鍵・形の違う値・不正な線の ID）', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: 'メモ' }, T1);
  assignThoughtToLine(lib, t.id, LINE, T2);
  // JSON で届いた本物の __proto__ の鍵と、手元より新しい時刻の壊れた値
  const broken = JSON.parse(`{"lineAssignments":{"__proto__":{"id":"${t.id}","lineId":"x","updatedAt":"2026-10-05T00:00:00.000Z"},"${t.id}":{"lineId":42,"updatedAt":"2026-10-05T00:00:00.000Z"},"tother":"nope"}}`);
  const merged = mergeLibraries(lib, { ...emptyLibrary(), ...broken });
  assert.deepEqual(lineAssignmentOf(merged, t.id), { lineId: 'l1', lineName: '仕組みの線' }, '手元の記録が残る');
  assert.equal(Object.getPrototypeOf(merged.lineAssignments), Object.prototype, '入れ物の継承元を書き換えない');
  assert.deepEqual(Object.keys(merged.lineAssignments), [t.id]);
  const badId = { ...emptyLibrary(), lineAssignments: { [t.id]: { id: t.id, lineId: '../x', lineName: 'x', updatedAt: '2026-10-05T00:00:00.000Z' } } };
  assert.deepEqual(lineAssignmentOf(mergeLibraries(lib, badId), t.id), { lineId: 'l1', lineName: '仕組みの線' });
});

test('#66: 時刻が同じ記録どうしでも、どちら向きに統合しても同じ結果になる', () => {
  const a = emptyLibrary();
  const t = addThought(a, { text: 'メモ' }, T1);
  const b = structuredClone(a);
  assignThoughtToLine(a, t.id, LINE, T2);
  assignThoughtToLine(b, t.id, { id: 'l2', name: '注意の線' }, T2);
  assert.deepEqual(lineAssignmentOf(mergeLibraries(a, b), t.id), lineAssignmentOf(mergeLibraries(b, a), t.id));
});

test('#66: 分析がまだ届いていない端末では、入れた線(グループ)を「無くなった」と言わず、入れたときの名前で出す', async () => {
  const { inboxBlock } = await import('../web/js/views/thoughts.js');
  const lib = emptyLibrary();
  const t = addThought(lib, { text: 'メモ' }, T1);
  assignThoughtToLine(lib, t.id, LINE, T2);
  const out = String(inboxBlock(st(lib, null)));
  assert.doesNotMatch(out, /無くなりました/);
  assert.match(out, /自分で入れた線\(グループ\): <a href="#\/knowledge\/line\/l1">仕組みの線<\/a>/);
});

test('#66: 分析し直しても、自分で入れた分は消えない', async () => {
  const lib = sample();
  const t = addThought(lib, { text: 'まったく関係のない思いつき' }, T1);
  assignThoughtToLine(lib, t.id, LINE, T2);
  const llm = { chatModel: 'stub', embed: null, chatJson: async (p) => (p.name === 'line' ? { name: '線', summary: '', insight: '', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '' } : { title: '核', core: '', relations: [], principles: [], questions: [] }) };
  await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
  assert.deepEqual(lineAssignmentOf(lib, t.id), { lineId: 'l1', lineName: '仕組みの線' });
});

test('#66: 受け箱のカードに「線(グループ)に入れる」。入れたら線の名前と「外す」が出る', async () => {
  const { inboxBlock } = await import('../web/js/views/thoughts.js');
  const lib = sample();
  const t = addThought(lib, { text: '受け箱のメモ' }, T1);
  const a = analysisOf(lib);
  const before = String(inboxBlock(st(lib, a)));
  assert.match(before, new RegExp(`data-action="thought-to-line" data-id="${t.id}">線\\(グループ\\)に入れる</button>`));
  assignThoughtToLine(lib, t.id, LINE, T2);
  const after = String(inboxBlock(st(lib, a)));
  assert.match(after, /自分で入れた線\(グループ\): <a href="#\/knowledge\/line\/l1">仕組みの線<\/a>/);
  assert.match(after, new RegExp(`data-action="thought-unline" data-id="${t.id}">線\\(グループ\\)から外す</button>`));
});

test('#66: 入れた思いつきは、その線(グループ)の画面の点の一覧に出る。線(グループ)が無くなったら、そのことがカードに出る', async () => {
  const { lineView } = await import('../web/js/views/knowledge.js');
  const { inboxBlock } = await import('../web/js/views/thoughts.js');
  const lib = sample();
  const t = addThought(lib, { text: '自分で入れたメモ' }, T1);
  assignThoughtToLine(lib, t.id, LINE, T2);
  const page = String(lineView.render({ state: st(lib, analysisOf(lib)), params: { id: 'l1' } }));
  assert.match(page, /<h2>つながっている点<\/h2><span class="small muted">3<\/span>/, 'AI の 2 点 + 自分で入れた 1 点');
  assert.match(page, /自分で入れたメモ/);
  assert.doesNotMatch(String(lineView.render({ state: st(lib, analysisOf(lib)), params: { id: 'l2' } })), /自分で入れたメモ/);
  // 最初から作り直して線(グループ)の ID が変わった
  const rebuilt = analysisOf(lib, [{ id: 'l9', name: '新しい線' }]);
  const card = String(inboxBlock(st(lib, rebuilt)));
  assert.match(card, /自分で入れた線\(グループ\)「仕組みの線」は、分析し直して無くなりました/);
  assert.match(card, /data-action="thought-unline"/);
});

test('#66: 操作: 線(グループ)を選ぶシートで入れ、外す。保存してから同期する', async () => {
  const { fakeApp, formData, button } = await import('./helpers/app-actions.js');
  const { lineSheet } = await import('../web/js/views/thoughts.js');
  const lib = sample();
  const t = addThought(lib, { text: 'メモ' }, T1);
  const st = { library: lib, analysis: analysisOf(lib), loaded: true };
  const app = fakeApp(st);
  app.actions['thought-to-line'](button({ id: t.id }));
  assert.equal(app.sheets[0].content, String(lineSheet(t, st.analysis.lines)));
  await app.sheets[0].onSubmit(formData({ line: 'l2' }));
  assert.equal(lineAssignmentOf(lib, t.id).lineId, 'l2');
  assert.deepEqual(app.log, ['openSheet', 'persist', 'toast', 'render', 'sync']);
  // シートを開いている間に分析し直して、選んだ線(グループ)が無くなったら入れない（シートに理由を出す）
  st.analysis = analysisOf(lib, [{ id: 'l1', name: '仕組みの線' }]);
  await assert.rejects(app.sheets[0].onSubmit(formData({ line: 'l2' })), /分析し直して無くなりました/);
  // 外す
  app.log.length = 0;
  await app.actions['thought-unline'](button({ id: t.id }));
  assert.equal(lineAssignmentOf(lib, t.id), null);
  assert.deepEqual(app.log, ['persist', 'toast', 'render', 'sync']);
  // ほかの端末の同期で先に外れていたら、描き直すだけ（保存・同期しない）
  app.log.length = 0;
  await app.actions['thought-unline'](button({ id: t.id }));
  assert.deepEqual(app.log, ['render']);
  // 線(グループ)がまだ無ければ、シートを開かずに知らせる
  const none = fakeApp({ library: lib, analysis: null, loaded: true });
  none.actions['thought-to-line'](button({ id: t.id }));
  assert.deepEqual(none.log, ['toast']);
  const sheet = String(lineSheet({ text: '<メモ>' }, analysisOf(lib).lines));
  assert.match(sheet, /<select name="line"[^>]*>/);
  assert.match(sheet, /<option value="l1">仕組みの線<\/option>/);
  assert.match(sheet, /&lt;メモ&gt;/);
});

// NIH-193 線(グループ)と面を消せる。点は消さない。次の分析でも同じものは作らない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { dismiss, dismissalsOf, dismissedPointSets, resemblesDismissed, skipDismissedLines, skipDismissedPlanes, undoDismiss, withoutDismissed } from '../web/core/dismissals.js';
import { startFakeLlm } from './helpers/fake-llm.js';
import { button, fakeApp } from './helpers/app-actions.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  return lib;
}

/** 線 3 本（l1・l2 は面 p1、l3 は面 p2）の小さな分析 */
function analysisOf(lib) {
  const [a, b, c, d, e, f, g] = Object.keys(lib.highlights);
  const line = (id, highlightIds) => ({ id, name: `線${id}`, summary: '', insight: '', keywords: [], highlightIds, bookIds: [] });
  return {
    version: 2,
    createdAt: T1,
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 7, lines: 3, planes: 2, isolated: 1 },
    lines: [line('l1', [a, b]), line('l2', [c, d]), line('l3', [e, f])],
    planes: [{ id: 'p1', name: '面1', summary: '', lineIds: ['l1', 'l2'] }, { id: 'p2', name: '面2', summary: '', lineIds: ['l3'] }],
    solid: { title: '核', core: '', relations: [{ from: 'p1', to: 'p2', type: '支える', description: '' }], principles: [], questions: [] },
    isolated: [g],
    discoveries: [{ id: 'd1', kind: 'line', lineId: 'l1', lineName: '線l1', reason: '', pointIds: [a, b], foundAt: T1 }],
    changes: { previousAt: T1, addedLines: [{ id: 'l1', name: '線l1', size: 2 }], grownLines: [], removedLines: [], connectedPoints: [{ pointId: a, lineId: 'l1' }] },
    recommendations: [{ title: '本', planeId: 'p2' }],
  };
}

const st = (library, analysis) => ({ library, analysis, loaded: true, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null });

test('NIH-193: 線を消すと分析から外れ、その点は「まだつながらない点」になる。点そのものは消えない', () => {
  const lib = sample();
  const a = analysisOf(lib);
  const before = structuredClone(lib.highlights);
  const record = dismiss(lib, a, 'line', 'l1', T2);
  assert.deepEqual(record.pointIds, a.lines[0].highlightIds);
  assert.equal(lib.updatedAt, T2, '同期で届くよう、ライブラリの更新時刻を進める');
  assert.deepEqual(lib.highlights, before, '点は変えない');
  const shown = withoutDismissed(a, lib);
  assert.deepEqual(shown.lines.map((l) => l.id), ['l2', 'l3']);
  assert.deepEqual(shown.planes.find((p) => p.id === 'p1').lineIds, ['l2']);
  for (const id of a.lines[0].highlightIds) assert.ok(shown.isolated.includes(id), '消した線の点は、まだつながらない点として残る');
  assert.equal(shown.stats.lines, 2);
  assert.equal(shown.stats.isolated, 3);
  assert.deepEqual(shown.discoveries, [], '消した線の発見は出さない');
  assert.deepEqual(shown.changes.addedLines, []);
  assert.deepEqual(shown.changes.connectedPoints, []);
  assert.equal(a.lines.length, 3, '元の分析は変えない');
  assert.equal(withoutDismissed(shown, lib), shown, '外すものが無ければ同じ物を返す');
  assert.throws(() => dismiss(lib, a, 'line', 'lnone', T2), /線\(グループ\)が見つかりません/);
  // ほかの端末から届いた分析の中の壊れた要素で止まらない
  const broken = { ...a, solid: { ...a.solid, relations: [null] }, changes: { addedLines: [null], grownLines: [null], connectedPoints: [null] } };
  assert.deepEqual(withoutDismissed(broken, lib).solid.relations, []);
});

test('NIH-193: 戻した記録は点を持たない（同期を重くしない）', () => {
  const lib = sample();
  dismiss(lib, analysisOf(lib), 'line', 'l1', T2);
  undoDismiss(lib, 'l1', T3);
  assert.deepEqual(dismissalsOf(lib).l1.pointIds, []);
  assert.equal(dismissedPointSets(lib, 'line').length, 0);
});

test('NIH-193: 面を消すと面だけが外れ、その線と点は残る', () => {
  const lib = sample();
  const a = analysisOf(lib);
  const record = dismiss(lib, a, 'plane', 'p2', T2);
  assert.deepEqual(record.pointIds, a.lines[2].highlightIds, '面の点 = 面の線の点');
  const shown = withoutDismissed(a, lib);
  assert.deepEqual(shown.planes.map((p) => p.id), ['p1']);
  assert.deepEqual(shown.lines.map((l) => l.id), ['l1', 'l2', 'l3'], '線は残る');
  assert.deepEqual(shown.isolated, a.isolated);
  assert.deepEqual(shown.solid.relations, [], '消した面との関係は出さない');
  assert.equal(shown.recommendations[0].planeId, null);
  // 面の線をすべて消した面も出さない
  dismiss(lib, a, 'line', 'l1', T2);
  dismiss(lib, a, 'line', 'l2', T2);
  assert.deepEqual(withoutDismissed(a, lib).planes, []);
});

test('NIH-193: 元に戻すと、また出る。消した・戻したは同期で届く（新しい方。向きに依らない。壊れた値は捨てる）', () => {
  const pc = emptyLibrary();
  const phone = sample();
  const a = analysisOf(phone);
  dismiss(phone, a, 'line', 'l1', T2);
  const merged = mergeLibraries(pc, phone);
  assert.deepEqual(withoutDismissed(a, merged).lines.map((l) => l.id), ['l2', 'l3']);
  undoDismiss(merged, 'l1', T3);
  assert.equal(withoutDismissed(a, merged), a, '戻したら外さない');
  assert.equal(dismissalsOf(mergeLibraries(merged, phone)).l1.dismissed, false, '戻した方が新しい');
  assert.equal(dismissalsOf(mergeLibraries(phone, merged)).l1.dismissed, false);
  const broken = JSON.parse('{"dismissals":{"__proto__":{"id":"x","kind":"line","dismissed":true},"l9":{"id":"l9","kind":"solid","dismissed":true},"l8":{"id":"l8","kind":"line","dismissed":"yes"},"../x":{"id":"../x","kind":"line","dismissed":true},"l7":{"id":"l7","kind":"line","dismissed":true,"pointIds":["h1","<b>",3]}}}');
  const m2 = mergeLibraries(phone, { ...emptyLibrary(), ...broken });
  assert.deepEqual(Object.keys(m2.dismissals).sort(), ['l1', 'l7']);
  assert.deepEqual(m2.dismissals.l7.pointIds, ['h1'], '点の ID の形でないものは捨てる');
});

test('NIH-193: 点の半分以上が消したときの点と重なる新しい線・面は作らない（作ってよいものは残す）', () => {
  const sets = [new Set(['h1', 'h2', 'h3'])];
  assert.equal(resemblesDismissed(['h1', 'h2', 'h9', 'h8'], sets), true);
  assert.equal(resemblesDismissed(['h1', 'h7', 'h9', 'h8'], sets), false);
  assert.equal(resemblesDismissed(['h1', 'h9'], sets), false, '消した線の点 1 つと新しい点 1 つの線は作れる');
  const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const carried = { groups: [{ id: null, members: [0, 1, 2] }, { id: null, members: [3, 4] }, { id: 'lkeep', members: [5, 0] }], isolated: [] };
  const out = skipDismissedLines(carried, ids, sets);
  assert.deepEqual(out.groups.map((g) => g.id ?? g.members.join()), ['3,4', 'lkeep'], '引き継いだ線（ID あり）は残す');
  assert.deepEqual(out.isolated, [0, 1, 2]);
  // 面: 消した面に似た面の線は、いちばん近いほかの面に入る
  const lines = [{ highlightIds: ['h1', 'h2'] }, { highlightIds: ['h3'] }, { highlightIds: ['h4', 'h5'] }];
  const v = (x, y) => Float32Array.from([x, y]);
  const planes = skipDismissedPlanes([{ id: null, members: [0, 1] }, { id: null, members: [2] }], lines, [v(1, 0), v(1, 0), v(0.9, 0.1)], sets);
  assert.deepEqual(planes, [{ id: null, members: [2, 0, 1] }]);
  // ほかに入れる面が無ければそのまま
  const only = [{ id: null, members: [0, 1] }];
  assert.equal(skipDismissedPlanes(only, lines, [v(1, 0), v(1, 0)], sets), only);
});

async function withFake(run) {
  const fake = await startFakeLlm();
  try {
    await run(createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' }));
  } finally {
    await fake.close();
  }
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

test('NIH-193: 消した線は、次の分析（引き継ぐ・最初から作り直す）でも作られない。点は分析に残る', async () => {
  await withFake(async (llm) => {
    const lib = sample();
    const first = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), options: { recommend: false } })).analysis;
    const target = [...first.lines].sort((x, y) => y.highlightIds.length - x.highlightIds.length)[0];
    dismiss(lib, first, 'line', target.id, T2);
    const sets = dismissedPointSets(lib, 'line');
    for (const full of [false, true]) {
      const next = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), previous: first, options: { recommend: false, full } })).analysis;
      assert.ok(!next.lines.some((l) => l.id === target.id), `full=${full}: 消した線の ID が戻らない`);
      assert.ok(!next.lines.some((l) => resemblesDismissed(l.highlightIds, sets)), `full=${full}: 消した線と同じ点の線を作らない`);
      const placed = new Set([...next.lines.flatMap((l) => l.highlightIds), ...next.isolated]);
      for (const id of target.highlightIds) assert.ok(placed.has(id), `full=${full}: 消した線の点 ${id} は分析に残る`);
      assert.ok(!next.planes.some((p) => p.lineIds.includes(target.id)));
      if (!full) assert.ok(!next.changes.removedLines.some((l) => l.id === target.id), '自分で消した線を「消えた線」と数えない');
    }
  });
});

test('NIH-193: 消した面は、次の分析でも作られず、その線はほかの面に入る', async () => {
  await withFake(async (llm) => {
    const lib = sample();
    const first = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), options: { recommend: false } })).analysis;
    assert.ok(first.planes.length >= 2, 'サンプルで面が 2 つ以上できる');
    const target = first.planes[0];
    dismiss(lib, first, 'plane', target.id, T2);
    const sets = dismissedPointSets(lib, 'plane');
    const next = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), previous: first, options: { recommend: false } })).analysis;
    assert.ok(!next.planes.some((p) => p.id === target.id));
    assert.ok(!next.planes.some((p) => sameSet(p.lineIds, target.lineIds)));
    const inPlane = new Set(next.planes.flatMap((p) => p.lineIds));
    for (const id of target.lineIds) assert.ok(inPlane.has(id), `面の線 ${id} はほかの面に入る`);
    const rebuilt = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), previous: first, options: { recommend: false, full: true } })).analysis;
    if (rebuilt.planes.length > 1) assert.ok(!rebuilt.planes.some((p) => resemblesDismissed(p.lineIds.flatMap((id) => rebuilt.lines.find((l) => l.id === id).highlightIds), sets)));
  });
});

test('NIH-193: 線・面の画面に「消す」ボタン。押すと確かめてから消し、通知から元に戻せる', async () => {
  const { lineView, planeView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib);
  assert.match(String(lineView.render({ state: st(lib, a), params: { id: 'l1' } })), /data-action="dismiss-concept" data-kind="line" data-id="l1">この線\(グループ\)を消す<\/button>/);
  assert.match(String(planeView.render({ state: st(lib, a), params: { id: 'p1' } })), /data-action="dismiss-concept" data-kind="plane" data-id="p1">この面を消す<\/button>/);

  const state = st(lib, a);
  const asked = [];
  const app = fakeApp(state, { confirm: (m) => (asked.push(m), true) });
  await app.actions['dismiss-concept'](button({ kind: 'line', id: 'l1' }));
  assert.match(asked[0], /線\(グループ\)「線l1」を消しますか？ 点は消えません/);
  assert.deepEqual(state.analysis.lines.map((l) => l.id), ['l2', 'l3']);
  assert.deepEqual(app.log, ['persist', 'saveAnalysis', 'go #/lines', 'toast', 'sync']);
  const undo = app.toasts[0].action;
  assert.equal(undo.label, '元に戻す');
  await undo.run();
  assert.equal(state.analysis, a, '消す前の分析に戻る');
  assert.equal(dismissalsOf(lib).l1.dismissed, false);
  assert.ok(app.log.includes('go #/knowledge/line/l1'));

  // 確かめで「いいえ」なら何もしない
  const no = fakeApp(state, { confirm: () => false });
  await no.actions['dismiss-concept'](button({ kind: 'plane', id: 'p1' }));
  assert.deepEqual(no.log, []);
  assert.equal(state.analysis, a);
});

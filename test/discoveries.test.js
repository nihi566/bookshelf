// G7 発見を届ける: 前回との差から発見を作る・ホームに未読を出す・開くと既読（端末の間で同期）・今日の点に別の本の点を添える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { DISCOVERIES_KEEP, discoveryId, findDiscoveries, mergeDiscoveries } from '../web/core/analysis/discoveries.js';
import { markDiscoveryRead, mergeReads, readsOf, unreadDiscoveries } from '../web/core/discovery-reads.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const T = '2026-10-04T10:00:00.000Z';

test('G7-1: 前回との差から発見を作る（本をまたいでつながった点・新しい線・つながった「まだつながっていない点」）', () => {
  const book = { a1: 'A', a2: 'A', b1: 'B', b2: 'B', c1: 'C', iso: 'C', n1: 'B', n2: 'C' };
  const previous = { lines: [{ id: 'L1', highlightIds: ['a1', 'a2', 'b1'] }], isolated: ['iso'] };
  const lines = [
    // 既にある線に、本 C の新しい点 n2 と、前回つながらなかった点 iso が入った
    { id: 'L1', name: '線一', summary: '共通する考え', highlightIds: ['a1', 'n2', 'a2', 'b1', 'iso'] },
    // 新しい線
    { id: 'L2', name: '線二', summary: '新しい考え', highlightIds: ['b2', 'n1', 'c1'] },
  ];
  const ds = findDiscoveries({ previous, lines, sourceOf: (id) => book[id], vectorOf: () => undefined, now: T });
  const byKind = Object.fromEntries(ds.map((d) => [d.kind, d]));
  assert.deepEqual(ds.map((d) => d.kind), ['isolated', 'cross', 'line'], 'まだつながらなかった点 → 本をまたいだ点 → 新しい線 の順');
  assert.deepEqual(byKind.cross.pointIds, ['n2', 'a1'], '別の本の点とつながった');
  assert.equal(byKind.cross.reason, '共通する考え');
  assert.equal(byKind.cross.lineName, '線一');
  assert.deepEqual(byKind.isolated.pointIds, ['iso', 'a1']);
  assert.deepEqual(byKind.line.pointIds, ['b2', 'c1'], '新しい線は別の本の 2 点');
  assert.equal(byKind.line.id, discoveryId('line', 'L2', ['c1', 'b2']), 'ID は組から決まる');
  // 同じ本の中だけで増えた点は「本をまたいだ」発見にしない
  const same = findDiscoveries({ previous, lines: [{ id: 'L1', name: 'x', summary: '', highlightIds: ['a1', 'a2', 'b1', 'x1'] }], sourceOf: (id) => (id === 'x1' ? 'A' : book[id]), vectorOf: () => undefined, now: T });
  assert.deepEqual(same.map((d) => d.pointIds), [['x1', 'b1']], 'x1（本 A）は別の本 B の点とだけ組む');
});

test('G7-1: 1 冊だけでできた新しい線・伸ばしただけの Kindle の線は発見にしない。同じ 2 点は種類が違っても 1 つに', () => {
  const book = { a1: 'A', a2: 'A', a3: 'A', b1: 'B', old: 'B', ext: 'B', i1: 'C', n1: 'D' };
  const src = (id) => book[id];
  // 1 冊だけの新しい線
  const single = findDiscoveries({ previous: { lines: [], isolated: [] }, lines: [{ id: 'N', name: 'n', summary: '', highlightIds: ['a1', 'a2', 'a3'] }], sourceOf: src, vectorOf: () => undefined, now: T });
  assert.deepEqual(single, []);
  // Kindle で伸ばした点（old → ext）は、前回からその線にいた点として扱う
  const previous = { lines: [{ id: 'L', highlightIds: ['a1', 'old'] }], isolated: ['i1'] };
  const extended = findDiscoveries({ previous, lines: [{ id: 'L', name: 'l', summary: '', highlightIds: ['a1', 'ext'] }], sourceOf: src, vectorOf: () => undefined, formerIdsOf: (id) => (id === 'ext' ? ['old'] : []), now: T });
  assert.deepEqual(extended, []);
  // まだつながらなかった点 i1 と増えた点 n1 が互いにいちばん近い相手でも、発見は 1 つ
  const v = { a1: [1, 0], i1: [0, 1], n1: [0, 1] };
  const pair = findDiscoveries({ previous, lines: [{ id: 'L', name: 'l', summary: '', highlightIds: ['a1', 'old', 'i1', 'n1'] }], sourceOf: src, vectorOf: (id) => (v[id] ? Float32Array.from(v[id]) : undefined), now: T });
  assert.deepEqual(pair.map((d) => [d.kind, [...d.pointIds].sort()]), [['isolated', ['i1', 'n1']]]);
});

test('G7-1: 分析でも、伸ばしただけの Kindle の線は発見にしない', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = emptyLibrary();
    mergeParsed(lib, SAMPLE_BOOKS);
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    // 線に入っている Kindle の点を、同じ位置のまま伸ばして取り込み直す
    const kindle = first.lines.flatMap((l) => l.highlightIds).map((id) => lib.highlights[id]).find((h) => h?.source === 'kindle');
    mergeParsed(lib, [{ title: lib.books[kindle.bookId].title, source: 'kindle', highlights: [{ text: `${kindle.text}そして続く。`, location: kindle.location, locationEnd: kindle.locationEnd + 1 }] }]);
    const ext = Object.values(lib.highlights).find((h) => h.text === `${kindle.text}そして続く。`);
    assert.equal(lib.highlights[kindle.id].supersededBy, ext.id);
    const second = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    assert.ok(second.lines.some((l) => l.highlightIds.includes(ext.id)), '伸ばした点も線に入る');
    assert.ok(!second.discoveries.some((d) => d.pointIds.includes(ext.id) && d.kind === 'cross'), '伸ばしただけでは発見にしない');
  } finally {
    await fake.close();
  }
});

test('形の壊れた発見が届いても、画面は落ちない（分析結果の形の確認にも入れる）', async () => {
  const { analysisShapeError } = await import('../web/core/analysis/shape.js');
  const { home } = await import('../web/js/views/library.js');
  const { discoveriesView, discoveryView } = await import('../web/js/views/discoveries.js');
  const base = { createdAt: T, lines: [], planes: [], solid: {}, isolated: [] };
  assert.match(analysisShapeError({ ...base, discoveries: [{ id: 'd1', kind: 'cross' }] }), /発見/);
  assert.match(analysisShapeError({ ...base, discoveries: 'x' }), /発見/);
  assert.equal(analysisShapeError({ ...base, discoveries: [{ id: 'd1', pointIds: ['h1', 'h2'] }] }), '');
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS);
  const state = { library, analysis: { ...base, discoveries: [{ id: 'd1', kind: 'cross' }, null, { id: 'd2', pointIds: 'x' }, 5] }, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
  assert.doesNotThrow(() => String(home.render({ state, shuffle: 0 })));
  assert.match(String(discoveriesView.render({ state })), /まだ発見はありません/);
  assert.match(String(discoveryView.render({ state, params: { id: 'd1' } })), /この発見は見つかりません/);
});

test('G7-1: 発見は前回までのものの前に積み、同じものは 1 つに・点が消えたものは外す・最大 60 件', () => {
  const d = (id, pts = ['h1', 'h2']) => ({ id, kind: 'cross', lineId: 'l', lineName: '', reason: '', pointIds: pts, foundAt: T });
  const merged = mergeDiscoveries([d('d1'), d('d2')], [d('d2'), d('d3', ['h1', 'gone']), d('d4'), null, { id: 5 }], (id) => id !== 'gone');
  assert.deepEqual(merged.map((x) => x.id), ['d1', 'd2', 'd4']);
  assert.equal(mergeDiscoveries(Array.from({ length: 80 }, (_, i) => d(`d${i}`))).length, DISCOVERIES_KEEP);
});

test('G7-1: 分析のたびに発見を作る（最初の分析・作り直しでは作らない）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = emptyLibrary();
    mergeParsed(lib, SAMPLE_BOOKS);
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    assert.deepEqual(first.discoveries, [], '最初の分析では作らない');
    // 別の本として、既にある線の点とほぼ同じことを書いた点が増える
    const line = first.lines.find((l) => l.highlightIds.length >= 3 && l.highlightIds.every((id) => id.startsWith('h')));
    const src = lib.highlights[line.highlightIds[0]];
    mergeParsed(lib, [{ title: '別の本で同じことを言っていた', source: 'kindle', highlights: [{ text: `${src.text}まさに。` }] }]);
    const added = Object.values(lib.highlights).find((h) => h.text === `${src.text}まさに。`);
    const second = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    const found = second.discoveries.find((x) => x.pointIds.includes(added.id));
    assert.ok(found, '増えた点の発見がある');
    assert.equal(found.kind, 'cross');
    const partner = lib.highlights[found.pointIds.find((id) => id !== added.id)];
    assert.notEqual(partner.bookId, added.bookId, '別の本の点とつながった');
    assert.equal(found.lineId, line.id);
    assert.equal(found.foundAt, second.createdAt);
    // 思いつきも点として発見に入る（思いつきは本とは別の出どころ）
    const t = addThought(lib, { text: `${lib.highlights[line.highlightIds[1]].text}と思った` });
    const third = (await analyzeLibrary({ library: lib, llm, cache, previous: second, options: { recommend: false } })).analysis;
    assert.ok(third.discoveries.some((x) => x.pointIds.includes(t.id)), '思いつきの発見');
    assert.ok(third.discoveries.some((x) => x.id === found.id), '前の発見も持ち越す');
    const rebuilt = (await analyzeLibrary({ library: lib, llm, cache, previous: third, options: { recommend: false, full: true } })).analysis;
    assert.deepEqual(rebuilt.discoveries.map((x) => x.id), third.discoveries.map((x) => x.id), '作り直しでは新しく作らず、前のものを持ち越す');
  } finally {
    await fake.close();
  }
});

test('引用を短くするとき、2 つの単位でできた文字（𠮷・絵文字）を途中で切らない', async () => {
  const { truncate } = await import('../web/core/text.js');
  assert.equal(truncate('あいう𠮷えお', 5), 'あいう𠮷…');
  assert.equal(truncate('𠮷𠮷', 2), '𠮷𠮷', '2 文字なら切らない');
  assert.equal(truncate('短い', 10), '短い');
  assert.ok(!/[\uD800-\uDBFF]…/.test(truncate('a'.repeat(38) + '😀😀😀', 40)));
});

test('既読の形が壊れていても読める（文字列などは無いものとして扱う）', () => {
  const lib = emptyLibrary();
  lib.discoveryReads = 'abc';
  assert.deepEqual(readsOf(lib), {});
  assert.equal(markDiscoveryRead(lib, 'd1', T), true);
  assert.deepEqual(lib.discoveryReads, { d1: T });
});

test('G7-2: 既読は端末の間で同期される（どちらかで読めば既読・向きに依らない・壊れた値は捨てる）', () => {
  const phone = emptyLibrary();
  const pc = emptyLibrary();
  assert.equal(markDiscoveryRead(phone, 'd1', '2026-10-04T10:00:00.000Z'), true);
  assert.equal(markDiscoveryRead(phone, 'd1', '2026-10-04T11:00:00.000Z'), false, '2 回目は何もしない');
  markDiscoveryRead(pc, 'd1', '2026-10-04T09:00:00.000Z');
  markDiscoveryRead(pc, 'd2', '2026-10-04T09:30:00.000Z');
  for (const m of [mergeLibraries(phone, pc), mergeLibraries(pc, phone)]) assert.deepEqual(m.discoveryReads, { d1: '2026-10-04T09:00:00.000Z', d2: '2026-10-04T09:30:00.000Z' });
  assert.deepEqual(mergeReads({ d1: 'a', 'x!': 'b', d3: 5 }, null), { d1: 'a' });
  const legacy = emptyLibrary();
  delete legacy.discoveryReads;
  assert.deepEqual(readsOf(legacy), {});
  const disc = (id) => ({ id, kind: 'cross', pointIds: ['h1', 'h2'] });
  assert.deepEqual(unreadDiscoveries({ discoveries: [disc('d1'), disc('d9')] }, mergeLibraries(phone, pc)).map((d) => d.id), ['d9']);
});

function stateWith(discoveries) {
  const library = emptyLibrary();
  mergeParsed(library, SAMPLE_BOOKS);
  const hs = Object.values(library.highlights);
  const byBook = (i) => hs.filter((h) => h.bookId === hs[i].bookId);
  const [a, b] = [hs[0], hs.find((h) => h.bookId !== hs[0].bookId)];
  const analysis = {
    createdAt: T,
    stats: { points: 48 },
    lines: [{ id: 'l1', name: '仕組みの線', summary: '仕組みが行動をつくる', insight: '', keywords: [], highlightIds: [a.id, b.id, ...byBook(0).slice(1, 3).map((h) => h.id)], bookIds: [] }],
    planes: [],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
    discoveries: discoveries(a, b),
  };
  return { state: { library, analysis, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null }, a, b };
}

test('G7-2: ホームの上の方に、未読の発見が新しい順に最大 3 件と、その件数が出る', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { state, a, b } = stateWith((a, b) => Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, kind: i % 2 ? 'cross' : 'line', lineId: 'l1', lineName: '仕組み<線>', reason: '理由', pointIds: [a.id, b.id], foundAt: T })));
  markDiscoveryRead(state.library, 'd1');
  const out = String(home.render({ state, shuffle: 0 }));
  assert.match(out, /<h2 id="disc-title">発見 <span class="count">4<\/span><\/h2>/);
  const block = out.match(/<section class="discoveries"[\s\S]*?<\/section>/)[0];
  assert.deepEqual([...block.matchAll(/href="#\/discovery\/(d\d)"/g)].map((m) => m[1]), ['d0', 'd2', 'd3'], '新しい順に未読の 3 件');
  assert.match(block, /ほか 1 件の未読を見る/);
  assert.match(block, /線\(グループ\)「仕組み&lt;線&gt;」/, 'エスケープする');
  assert.ok(out.indexOf('class="discoveries"') < out.indexOf('今日の点'), 'ホームの上の方（今日の点より前）');
  assert.ok(block.includes(a.text.slice(0, 10)) && block.includes(b.text.slice(0, 10)), 'どの点とどの点か');
  // すべて読めば出さない
  for (const i of [0, 2, 3, 4]) markDiscoveryRead(state.library, `d${i}`);
  assert.doesNotMatch(String(home.render({ state, shuffle: 0 })), /class="discoveries"/);
});

test('G7-2: 点を消した発見はホームの未読に数えない（すべての発見では「消えた点」と出る）', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { discoveriesView } = await import('../web/js/views/discoveries.js');
  const { updateHighlight } = await import('../web/core/model.js');
  const { state, a, b } = stateWith((a, b) => [{ id: 'd0', kind: 'cross', lineId: 'l1', lineName: '線', reason: '', pointIds: [a.id, b.id], foundAt: T }]);
  updateHighlight(state.library, b.id, { deleted: true });
  assert.doesNotMatch(String(home.render({ state, shuffle: 0 })), /class="discoveries"/);
  const list = String(discoveriesView.render({ state }));
  assert.match(list, /1 件（未読 1 件）/);
  assert.match(list, /（消えた点）/);
  assert.ok(list.includes(a.text.slice(0, 10)));
});

test('G7-2: 発見を開くと「どの点とどの点が、なぜつながったか」が見え、既読になる', async () => {
  const { discoveryView } = await import('../web/js/views/discoveries.js');
  const { state, a, b } = stateWith((a, b) => [{ id: 'd0', kind: 'cross', lineId: 'l1', lineName: '仕組みの線', reason: '理由', pointIds: [a.id, b.id], foundAt: T }]);
  const out = String(discoveryView.render({ state, params: { id: 'd0' } }));
  assert.match(out, /<h1>本をまたいだつながり<\/h1>/);
  assert.match(out, /同じ線\(グループ\)「<a href="#\/knowledge\/line\/l1">仕組みの線<\/a>」に入りました。仕組みが行動をつくる/);
  assert.equal((out.match(/<article class="hl"/g) || []).length, 2, '両側の点');
  assert.ok(out.includes(a.text) && out.includes(b.text));
  const opened = [];
  discoveryView.mount({}, { state, params: { id: 'd0' }, markDiscoveryRead: (id) => opened.push(id) });
  assert.deepEqual(opened, ['d0']);
  // 開いたら端末に保存して同期する（2 回目は既読なので保存しない）
  const { fakeApp } = await import('./helpers/app-actions.js');
  const app = fakeApp({ ...state, loaded: true });
  await app.readDiscovery('d0');
  assert.ok(readsOf(state.library).d0);
  assert.deepEqual(app.log, ['persist', 'sync']);
  await app.readDiscovery('d0');
  assert.deepEqual(app.log, ['persist', 'sync']);
  // 保存に失敗したら知らせる（画面は開いたまま）
  const failing = fakeApp({ ...stateWith(() => []).state, loaded: true }, { persist: async () => { throw new Error('保存できません'); } });
  await failing.readDiscovery('d1');
  assert.deepEqual(failing.log, ['toast']);
});

test('G7-3: 今日の点に、その点とつながる別の本の点を 1 件添える（つながる点が無ければ添えない）', async () => {
  const { partnerBlock, partnerOf } = await import('../web/js/views/discoveries.js');
  const { state, a, b } = stateWith(() => []);
  const m = partnerOf(state, a);
  assert.equal(m.point.id, b.id, '同じ線の、別の本の点');
  assert.notEqual(m.point.bookId, a.bookId);
  const out = String(partnerBlock(state, a));
  assert.match(out, /つながる別の本の点 ・ <a href="#\/knowledge\/line\/l1">線\(グループ\)「仕組みの線」<\/a>/);
  const lone = Object.values(state.library.highlights).find((h) => !state.analysis.lines[0].highlightIds.includes(h.id));
  assert.equal(String(partnerBlock(state, lone)), '', '線に入っていない点には添えない');
  // ホームの今日の点に出る
  const { home } = await import('../web/js/views/library.js');
  state.analysis.lines[0].highlightIds = Object.keys(state.library.highlights);
  assert.match(String(home.render({ state, shuffle: 0 })), /<div class="partner">/);
});

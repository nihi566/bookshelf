// G5-2 増分の分析（変わったところだけ AI を呼ぶ・線の ID を保つ）と G3-7 線の大きさ、G5-4 前回からの変化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed, updateHighlight } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, deserializeCache, emptyCache, serializeCache } from '../web/core/analysis/pipeline.js';
import { carryLines, carryPlanes } from '../web/core/analysis/incremental.js';
import { diffAnalyses, hasChanges } from '../web/core/analysis/changes.js';
import { l2normalize } from '../web/core/analysis/vectors.js';
import { startFakeLlm } from './helpers/fake-llm.js';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

// G5-2 の回数には、おすすめの本と G6 の遠い組み合わせの判定を含めない
const notFar = (b) => b.response_format?.json_schema?.name !== 'far';
const chatsSince = (fake, from) => fake.calls.bodies.slice(from).filter(notFar).length;

/** 線 1 本に入っている点の文に、ほんの少し言葉を足した新しい点を、別の本として足す（その線の近くに来る） */
function addNearPoint(lib, analysis) {
  const line = analysis.lines.find((l) => l.highlightIds.length >= 3 && l.highlightIds.every((id) => id.startsWith('h')));
  const src = lib.highlights[line.highlightIds[0]];
  mergeParsed(lib, [{ title: '新しく読んだ本', source: 'kindle', highlights: [{ text: `${src.text}まさに。`, location: 1 }] }], { now: '2026-10-05T00:00:00.000Z' });
  const added = Object.values(lib.highlights).find((h) => h.text === `${src.text}まさに。`);
  return { line, added };
}

test('G5-2: 点を 1 件足した再分析で AI を呼ぶのは 5 回以下。新しい点は近い既存の線に加わり、既存の線の ID は変わらない', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    assert.equal(first.incremental, false);
    const { line, added } = addNearPoint(lib, first);

    const before = { bodies: fake.calls.bodies.length, embed: fake.calls.embed };
    const second = (await analyzeLibrary({ library: lib, llm, cache: deserializeCache(JSON.parse(JSON.stringify(serializeCache(cache)))), previous: first, options: { recommend: false } })).analysis;
    const used = chatsSince(fake, before.bodies) + (fake.calls.embed - before.embed);
    assert.ok(used <= 5, `AI を呼んだ回数 ${used}（チャット ${chatsSince(fake, before.bodies)}・埋め込み ${fake.calls.embed - before.embed}）`);
    assert.ok(second.stats.calls.chat + second.stats.calls.embed <= 5);
    assert.equal(second.incremental, true);
    // 新しい点は、元にした点のある既存の線に加わる（線の ID はそのまま）
    const joined = second.lines.find((l) => l.highlightIds.includes(added.id));
    assert.equal(joined?.id, line.id);
    // 前回の線はすべて同じ ID で残る
    const ids = new Set(second.lines.map((l) => l.id));
    for (const l of first.lines) assert.ok(ids.has(l.id), `線 ${l.id} が消えた`);
    // 面も同じ ID で残る
    assert.deepEqual(second.planes.map((p) => p.id).sort(), first.planes.map((p) => p.id).sort());
    // 前回からの変化: 大きくなったのはその線だけ。新しくつながった点は、足した点と（中心が動いたので入った）前回つながらなかった点
    assert.deepEqual(second.changes.grownLines.map((g) => g.id), [line.id]);
    assert.ok(second.changes.connectedPoints.some((p) => p.pointId === added.id && p.lineId === line.id));
    assert.ok(second.changes.connectedPoints.every((p) => p.lineId === line.id && (p.pointId === added.id || first.isolated.includes(p.pointId))));
    assert.equal(second.changes.addedLines.length + second.changes.removedLines.length, 0);
  } finally {
    await fake.close();
  }
});

test('G5-2: キャッシュが無くても、前回の結果を引き継げば変わっていない線・面・立体は AI を呼ばない', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const first = (await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis;
    // サンプルの点と同じ文字の並びを 1 つも持たない思いつき（偽の埋め込みでは近さが 0）
    addThought(lib, { text: 'zz qq xx vv ww' });
    const before = fake.calls.bodies.length;
    const second = (await analyzeLibrary({ library: lib, llm, previous: first, options: { recommend: false } })).analysis;
    // キャッシュが空なので点の埋め込みはやり直すが、線・面・立体は前回の結果を使う
    assert.equal(chatsSince(fake, before), 0);
    assert.deepEqual(second.lines.map((l) => [l.id, l.name]), first.lines.map((l) => [l.id, l.name]));
    assert.equal(second.solid.title, first.solid.title);
  } finally {
    await fake.close();
  }
});

test('増分の分析: 点を消すと、残った点で同じ ID の線のまま。最初から作り直す（full）と前回を引き継がない', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    const line = first.lines.find((l) => l.highlightIds.length >= 3);
    updateHighlight(lib, line.highlightIds[0], { deleted: true });
    const second = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    const same = second.lines.find((l) => l.id === line.id);
    assert.deepEqual(same.highlightIds.sort(), line.highlightIds.slice(1).sort());
    const rebuilt = (await analyzeLibrary({ library: lib, llm, cache, previous: second, options: { recommend: false, full: true } })).analysis;
    assert.equal(rebuilt.incremental, false);
    assert.equal(rebuilt.changes.rebuilt, true);
    // 前の版（線の大きさが違う）の分析は引き継がない
    const old = (await analyzeLibrary({ library: lib, llm, cache, previous: { ...first, version: 1 }, options: { recommend: false } })).analysis;
    assert.equal(old.incremental, false);
  } finally {
    await fake.close();
  }
});

test('carryLines: 上限に達した線には加えず、遠い点どうしは無理に束ねない', () => {
  const v = (x, y, z = 0) => l2normalize(Float32Array.from([x, y, z]));
  const ids = ['a', 'b', 'c', 'd', 'e', 'far'];
  const vectors = [v(1, 0.01), v(1, 0.02), v(1, 0.03), v(1, 0.015), v(1, 0.025), v(0, 0, 1)];
  const { lines, isolated } = carryLines({ ids, vectors, previousLines: [{ id: 'L', highlightIds: ['a', 'b', 'c'] }], targetSize: 8, maxSize: 4, maxGroups: 10 });
  const L = lines.find((l) => l.id === 'L');
  assert.deepEqual(L.members.map((i) => ids[i]), ['a', 'b', 'c', 'd'], '上限の 4 点まで（d が先に入り、e は入れない）');
  // 残った近い点 1 つと遠い点 1 つは、近さの基準を満たさないので線にしない
  assert.equal(lines.length, 1);
  assert.deepEqual(isolated.map((i) => ids[i]), ['e', 'far']);
});

test('carryLines: 同じ話題の新しい点はたいてい既存の線に入り、無関係な点はつながらない点になる（自分を除いた中心で比べる）', () => {
  // 64 次元・話題 40 個 × 10 点で線を作り、同じ話題の点 100 件と、どの話題とも関係ない点 20 件を足す
  let s = 11;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const centers = Array.from({ length: 40 }, () => l2normalize(Float32Array.from({ length: 64 }, () => rand() - 0.5)));
  const draw = (t) => l2normalize(Float32Array.from(centers[t], (x) => x + (rand() - 0.5) * 0.35));
  const base = Array.from({ length: 400 }, (_, i) => draw(i % 40));
  const ids = base.map((_, i) => `h${i}`);
  const first = carryLines({ ids, vectors: base, targetSize: 8, maxSize: 20, maxGroups: 400 });
  const previousLines = first.lines.map((l, k) => ({ id: `l${k}`, highlightIds: l.members.map((i) => ids[i]) }));
  const added = Array.from({ length: 100 }, (_, i) => draw((i * 7) % 40));
  const unrelated = Array.from({ length: 20 }, () => l2normalize(Float32Array.from({ length: 64 }, () => rand() - 0.5)));
  const allIds = [...ids, ...added.map((_, i) => `n${i}`), ...unrelated.map((_, i) => `x${i}`)];
  const r = carryLines({ ids: allIds, vectors: [...base, ...added, ...unrelated], previousLines, previousIsolated: first.isolated.map((i) => ids[i]), targetSize: 8, maxSize: 20, maxGroups: 400 });
  const iso = new Set(r.isolated.map((i) => allIds[i]));
  const lostNew = added.filter((_, i) => iso.has(`n${i}`)).length;
  const keptOut = unrelated.filter((_, i) => iso.has(`x${i}`)).length;
  assert.ok(lostNew <= 15, `同じ話題の点がつながらない: ${lostNew}/100`);
  assert.ok(keptOut >= 18, `無関係な点が線に入った: ${20 - keptOut}/20`);
  // 前回の線の ID はすべて残る
  assert.deepEqual(r.lines.filter((l) => l.id).map((l) => l.id).sort(), previousLines.map((l) => l.id).sort());
});

test('carryLines: 前回つながらなかった点は、点が加わって中心が動いた線に十分近ければ入る（何も増えなければ動かさない）', () => {
  const v = (x, y, z = 0) => l2normalize(Float32Array.from([x, y, z]));
  const ids = ['a', 'b', 'c', 'old', 'new'];
  // 線 L（a・b・c）の少し外に、前回つながらなかった点 old。今回 new が old の側に増え、L の中心が old に寄る
  const vectors = [v(1, 0), v(1, 0.1), v(1, -0.1), v(1, 0.2), v(1, 0.12)];
  const prev = { previousLines: [{ id: 'L', highlightIds: ['a', 'b', 'c'] }], previousIsolated: ['old'], targetSize: 8, maxSize: 20, maxGroups: 10 };
  const same = carryLines({ ids: ids.slice(0, 4), vectors: vectors.slice(0, 4), ...prev });
  assert.deepEqual(same.isolated.map((i) => ids[i]), ['old'], '何も増えなければ動かさない');
  const r = carryLines({ ids, vectors, ...prev });
  assert.deepEqual(r.lines.find((l) => l.id === 'L').members.map((i) => ids[i]).sort(), ['a', 'b', 'c', 'new', 'old']);
  assert.deepEqual(r.isolated, []);
});

test('carryLines: 線の数が上限に達していたら、増分でも新しい線は作らない', () => {
  const v = (x, y, z) => l2normalize(Float32Array.from([x, y, z]));
  const ids = ['a', 'b', 'n1', 'n2'];
  const vectors = [v(1, 0, 0), v(1, 0.01, 0), v(0, 0, 1), v(0, 0.01, 1)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'L', highlightIds: ['a', 'b'] }], targetSize: 8, maxSize: 20, maxGroups: 1 });
  assert.deepEqual(r.lines.map((l) => l.id), ['L']);
  assert.deepEqual(r.isolated.map((i) => ids[i]), ['n1', 'n2']);
});

test('G5-2: 埋め込みモデルが無い（文字 n-gram）ときも、点を 1 件ずつ足した再分析で AI を呼ぶのは 5 回以下。使わなくなった AI の結果はキャッシュから外す', async () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  let chat = 0;
  // 遠い組み合わせの判定（G6）は数えない
  const llm = { chatModel: 'stub', chatJson: async (p) => (p.name === 'far' ? { shared: false, idea: '', explanation: '' } : (chat++, p.name === 'line' ? { name: `線${chat}`, summary: '要約', insight: '', keywords: [] } : p.name === 'plane' ? { name: `面${chat}`, summary: '要約' } : { title: '核', core: '', relations: [], principles: [], questions: [] })) };
  const cache = emptyCache();
  let prev = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
  const extra = ['習慣は小さな仕組みから始まる。', '注意を守ることは時間を守ること。', '書くことで考えがまとまる。', '信頼は約束を守ることで生まれる。', '休むことも仕事の一部である。', '環境を変えると行動が変わる。'];
  for (const [i, text] of extra.entries()) {
    mergeParsed(lib, [{ title: `足した本 ${i}`, source: 'kindle', highlights: [{ text }] }]);
    const before = chat;
    prev = (await analyzeLibrary({ library: lib, llm, cache, previous: prev, options: { recommend: false } })).analysis;
    assert.ok(chat - before <= 5, `${i + 1} 件目: AI を ${chat - before} 回呼んだ`);
    assert.equal(prev.stats.calls.chat, chat - before);
  }
  const sigs = new Set([...prev.lines.map((l) => l.sig), ...prev.planes.map((p) => p.sig), prev.solid.sig]);
  assert.deepEqual(Object.keys(cache.llm).filter((k) => !sigs.has(k)), [], '今回使った結果だけが残る');
});

test('carryPlanes: 前回の面を引き継ぎ、新しい線は近い面に入る。線 1 本だけの面は残さない', () => {
  const v = (x, y) => l2normalize(Float32Array.from([x, y]));
  const lineIds = ['l1', 'l2', 'l3', 'l4', 'new'];
  const vectors = [v(1, 0), v(1, 0.1), v(0, 1), v(0.1, 1), v(0.05, 1)];
  const planes = carryPlanes({ lineIds, vectors, previousPlanes: [{ id: 'P', lineIds: ['l1', 'l2'] }, { id: 'Q', lineIds: ['l3', 'l4'] }, { id: 'R', lineIds: ['gone'] }], maxPlanes: 12 });
  assert.deepEqual(planes.map((p) => p.id), ['P', 'Q']);
  assert.ok(planes[1].members.includes(4), '新しい線は近い面 Q に入る');
  const lone = carryPlanes({ lineIds: ['a', 'b', 'c'], vectors: [v(1, 0), v(1, 0.1), v(0, 1)], previousPlanes: [{ id: 'P', lineIds: ['a', 'b'] }, { id: 'S', lineIds: ['c'] }], maxPlanes: 12 });
  assert.equal(lone.length, 1);
  assert.equal(lone[0].members.length, 3);
});

test('G3-7: 点 1,000 件の試験用データで、線 1 本に入る点の数の中央値が 10 以下（前の設定では 10 を超えていた）', async () => {
  // 話題 80 個のまわりに散らばる 1,000 点（話題の大きさはばらばら・シード固定）
  let s = 7;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const dims = 64;
  const centers = Array.from({ length: 80 }, () => l2normalize(Float32Array.from({ length: dims }, () => rand() - 0.5)));
  const weights = centers.map(() => rand() ** 2 + 0.05);
  const total = weights.reduce((a, b) => a + b, 0);
  const texts = [];
  const vecs = new Map();
  for (let i = 0; i < 1000; i++) {
    let r = rand() * total;
    let t = 0;
    while ((r -= weights[t]) > 0 && t < 79) t++;
    const text = `試験用の点 ${i}`;
    texts.push(text);
    vecs.set(text, l2normalize(Float32Array.from(centers[t], (x) => x + (rand() - 0.5) * 0.35)));
  }
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '試験用の本', source: 'kindle', highlights: texts.map((text, i) => ({ text, location: i })) }]);
  const llm = {
    chatModel: 'stub',
    embedModel: 'stub-embed',
    embed: async (xs) => xs.map((t) => vecs.get(t.split('\n')[0]) || l2normalize(Float32Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0)))),
    chatJson: async (p) => (p.name === 'line' ? { name: '線', summary: '要約', insight: '', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '要約' } : { title: '核', core: '核', relations: [], principles: [], questions: [] }),
  };
  const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };
  const now = (await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis;
  const m = median(now.lines.map((l) => l.highlightIds.length));
  assert.ok(m <= 10, `中央値 ${m}（線 ${now.lines.length} 本）`);
  assert.ok(now.planes.length <= 12);
  const old = (await analyzeLibrary({ library: lib, llm, options: { recommend: false, granularity: 5, maxLines: 40 } })).analysis;
  assert.ok(median(old.lines.map((l) => l.highlightIds.length)) > 10, '前の設定（点 5 件で線 1 本・上限 40 本）では大きすぎた');
});

test('G5-4: 前回からの変化（増えた線・大きくなった線・消えた線・新しくつながった点）', () => {
  const prev = { createdAt: 'T1', lines: [{ id: 'a', name: 'A', highlightIds: ['h1', 'h2'] }, { id: 'b', name: 'B', highlightIds: ['h3', 'h4'] }], isolated: ['h5'] };
  const next = { lines: [{ id: 'a', name: 'A', highlightIds: ['h1', 'h2', 'h5'] }, { id: 'c', name: 'C', highlightIds: ['h6', 't1'] }], isolated: [] };
  const d = diffAnalyses(prev, next);
  assert.equal(d.previousAt, 'T1');
  assert.deepEqual(d.addedLines, [{ id: 'c', name: 'C', size: 2 }]);
  assert.deepEqual(d.grownLines, [{ id: 'a', name: 'A', added: 1 }]);
  assert.deepEqual(d.removedLines, [{ id: 'b', name: 'B', size: 2 }]);
  assert.deepEqual(d.connectedPoints, [{ pointId: 'h5', lineId: 'a' }, { pointId: 'h6', lineId: 'c' }, { pointId: 't1', lineId: 'c' }]);
  assert.equal(hasChanges(d), true);
  assert.equal(diffAnalyses(null, next), null);
  assert.equal(hasChanges(diffAnalyses(prev, prev)), false);
});

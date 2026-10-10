// G6 遠いものを結ぶ: 遠い組み合わせの候補・AI の判定・反応（面白い・ちがう）・発見・おすすめの種類
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeLibraries, mergeParsed, setFeedback, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { REQUIRED_KINDS, analyzeLibrary, deserializeCache, emptyCache, recommendBooks, serializeCache } from '../web/core/analysis/pipeline.js';
import { FAR_KEEP, FAR_MAX_PAIRS, FAR_MAX_REPS, farCandidates, farId, farVerdict, judgeFarPairs, mergeFarConnections, pickReps } from '../web/core/analysis/far.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { dot, l2normalize } from '../web/core/analysis/vectors.js';
import { applyImport, makeBackup } from '../web/core/importing.js';
import { farConnectionById, farReactionsOf, mergeFarReactions, normalizeFarReaction, reactFar, visibleFarConnections, wrongFarIds } from '../web/core/far-reactions.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const T = '2026-10-04T12:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

/** シード固定の代表の点: 面 6 つ（各 4 本の線）と、まだつながらない点 8 つ。本は 3 本の線ごとに 1 冊 */
function syntheticReps() {
  let s = 11;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const dims = 24;
  const centers = Array.from({ length: 6 }, () => Array.from({ length: dims }, () => rand() - 0.5));
  const near = (c, spread) => l2normalize(Float32Array.from(c.map((x) => x + (rand() - 0.5) * spread)));
  const reps = [];
  for (let p = 0; p < 6; p++) for (let k = 0; k < 4; k++) reps.push({ id: `h${p}${k}`, vector: near(centers[p], 0.8), plane: `P${p}`, source: `b${Math.floor((p * 4 + k) / 3)}`, isolated: false });
  for (let k = 0; k < 8; k++) reps.push({ id: `t${k}`, vector: near(centers[k % 6], 2.5), plane: null, source: `t${k}`, isolated: true });
  return reps;
}

const eligible = (reps) => {
  const out = [];
  for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) if (reps[i].source !== reps[j].source && !(reps[i].plane && reps[i].plane === reps[j].plane)) out.push(dot(reps[i].vector, reps[j].vector));
  return out.sort((x, y) => x - y);
};

test('G6-1 / G6-2: 候補は別の本・別の面の組で、意味の近さが低めの帯から最大 10 組。同じ入力なら同じ候補（並びにも依らない）', () => {
  const reps = syntheticReps();
  const c = farCandidates({ reps });
  assert.equal(c.length, FAR_MAX_PAIRS);
  const byId = new Map(reps.map((r) => [r.id, r]));
  const sims = eligible(reps);
  const lo = sims[Math.floor(0.15 * sims.length)];
  const hi = sims[Math.floor(0.45 * sims.length)];
  const used = new Set();
  for (const p of c) {
    const [a, b] = [byId.get(p.a), byId.get(p.b)];
    assert.notEqual(a.source, b.source, '別の本');
    assert.ok(!(a.plane && a.plane === b.plane), '別の面');
    assert.ok(p.sim >= lo && p.sim <= hi, `近さが帯の外: ${p.sim}`);
    assert.equal(p.id, farId(p.a, p.b));
    assert.ok(p.a < p.b, '組の 2 点は ID の順');
    assert.ok(!used.has(p.a) && !used.has(p.b), '同じ点は 1 回の分析で 1 組まで');
    used.add(p.a);
    used.add(p.b);
  }
  // 近すぎる組（線で足りる）・遠すぎる組（こじつけ）は選ばない
  assert.ok(c.every((p) => p.sim < sims[sims.length - 1] && p.sim > sims[0]));
  assert.deepEqual(farCandidates({ reps }), c, '同じ入力なら同じ候補');
  assert.deepEqual(farCandidates({ reps: [...reps].reverse() }), c, '入力の並びに依らない');
  assert.deepEqual(farCandidates({ reps: reps.slice(0, 1) }), []);
});

test('G6-3: まだつながっていない点を含む組を、候補に優先して入れる（先頭の 5 組。全部をそれにはしない）', () => {
  const reps = syntheticReps();
  const c = farCandidates({ reps });
  const isIsolated = (p) => p.a.startsWith('t') || p.b.startsWith('t');
  const withIsolated = c.filter(isIsolated);
  assert.ok(withIsolated.length >= FAR_MAX_PAIRS / 2, `まだつながらない点を含む組が ${withIsolated.length} 組`);
  assert.ok(c.slice(0, FAR_MAX_PAIRS / 2).every(isIsolated), '先頭の 5 組は、まだつながらない点を含む組');
  assert.ok(c.some((p) => !isIsolated(p)), '線どうしの組も試す');
  // 同じ点を「まだつながらない点」と扱わないと、選ばれない組がある（＝優先して入れている）
  const plain = farCandidates({ reps: reps.map((r) => ({ ...r, isolated: false })) });
  assert.ok(withIsolated.some((p) => !plain.some((q) => q.id === p.id)));
});

test('G6-2: AI の判定は候補の数まで（最大 10 回）。共通する考えと説明がそろった組だけを遠いつながりにし、読めない答えは「ない」と区別する', async () => {
  const candidates = farCandidates({ reps: syntheticReps() });
  let calls = 0;
  const answers = [{ shared: true, idea: '注意は資源', explanation: '2 つとも、限られた注意の使い方を言っている。' }, { shared: false }, { shared: true, idea: '', explanation: '説明だけ' }, { shared: 'true', idea: '  間の取り方 ', explanation: '休むことと待つことは同じ。' }, { result: true }];
  const remembered = [];
  const llm = { chatJson: async () => answers[calls++ % answers.length] };
  const r = await judgeFarPairs({ candidates, llm, promptOf: (c) => ({ name: 'far', user: c.id }), remember: (c, v) => remembered.push(v === null ? 'unreadable' : v.shared), now: T });
  assert.equal(calls, candidates.length);
  assert.equal(r.calls, candidates.length);
  assert.ok(r.calls <= FAR_MAX_PAIRS);
  assert.equal(remembered.length, candidates.length, '答えが返った組はすべて残す（二度判定しない）');
  assert.deepEqual(remembered.slice(0, 5), [true, false, 'unreadable', true, 'unreadable'], '「ある」なのに共通する考えが空・shared が無い答えは、読めない答え');
  assert.deepEqual(r.found.map((f) => f.idea).slice(0, 2), ['注意は資源', '間の取り方']);
  assert.ok(r.found.every((f) => f.idea && f.explanation && f.foundAt === T && f.a && f.b));
  assert.equal(farVerdict({ shared: true, idea: 'x', explanation: '' }), null);
  assert.equal(farVerdict(null), null);
  assert.deepEqual(farVerdict({ shared: 'false' }), { shared: false });
});

test('G6-2: AI への依頼が続けて 2 回失敗したら、残りの組は次の分析に回す（分析は止めない。間に答えが返れば数え直す）。中止は止める', async () => {
  const candidates = farCandidates({ reps: syntheticReps() });
  let calls = 0;
  const broken = { chatJson: async () => (calls++, Promise.reject(new Error('LLM サーバに接続できません'))) };
  const remembered = [];
  const r = await judgeFarPairs({ candidates, llm: broken, promptOf: () => ({}), remember: (c) => remembered.push(c.id), now: T });
  assert.equal(calls, 2);
  assert.deepEqual(r.found, []);
  assert.deepEqual(remembered, [], '失敗した組は判定しなかったことにする');
  assert.match(r.error, /接続できません/);
  // 失敗・成功・失敗・成功…は「続けて」ではないので、最後まで試す
  let k = 0;
  const flaky = { chatJson: async () => (k++ % 2 === 0 ? Promise.reject(new Error('一時的な失敗')) : { shared: false }) };
  const r2 = await judgeFarPairs({ candidates, llm: flaky, promptOf: () => ({}), now: T });
  assert.equal(r2.calls, candidates.length);
  // 依頼を作る処理の誤り（こちらの不具合）は、AI の失敗として隠さない
  await assert.rejects(judgeFarPairs({ candidates, llm: flaky, promptOf: () => { throw new TypeError('作れない'); }, now: T }), /作れない/);
  const ctrl = new AbortController();
  const aborting = { chatJson: async () => (ctrl.abort(), Promise.reject(new Error('中止しました'))) };
  await assert.rejects(judgeFarPairs({ candidates, llm: aborting, promptOf: () => ({}), signal: ctrl.signal, now: T }), /中止/);
});

test('G6-1: 分析のたびに遠い組み合わせを AI が判定し、あると判定した組だけを説明と両側の点とともに残す（線・面・立体の回数には数えない）', async () => {
  // 1 組目・3 組目…は「ある」、2 組目・4 組目…は「ない」と答える
  let n = 0;
  const fake = await startFakeLlm({ far: () => (n++ % 2 === 0 ? { shared: true, idea: '共通<考え>', explanation: '同じ原理の別の現れ。' } : { shared: false, idea: '', explanation: '' }) });
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
    const bodies = fake.calls.bodies.filter((b) => b.response_format?.json_schema?.name === 'far');
    const prompts = bodies.map((b) => b.messages[1].content);
    assert.ok(prompts.length >= 1 && prompts.length <= FAR_MAX_PAIRS);
    assert.equal(analysis.stats.far.calls, prompts.length);
    assert.equal(analysis.stats.far.candidates, prompts.length);
    const yes = Math.ceil(prompts.length / 2);
    assert.ok(prompts.length >= 2, `判定した組 ${prompts.length}（試験の前提）`);
    assert.equal(analysis.farConnections.length, yes, 'あると判定した組だけ');
    const planeOf = new Map(analysis.planes.flatMap((p) => p.lineIds.map((id) => [id, p.id])));
    const lineOf = new Map(analysis.lines.flatMap((l) => l.highlightIds.map((id) => [id, l.id])));
    for (const f of analysis.farConnections) {
      const [a, b] = [lib.highlights[f.a], lib.highlights[f.b]];
      assert.ok(a && b, '両側の点');
      assert.notEqual(a.bookId, b.bookId, '別の本');
      const [pa, pb] = [planeOf.get(lineOf.get(f.a)), planeOf.get(lineOf.get(f.b))];
      assert.ok(!pa || !pb || pa !== pb, '別の面（まだつながらない点はどの面とも別）');
      assert.equal(f.explanation, '同じ原理の別の現れ。');
      assert.equal(f.foundAt, analysis.createdAt);
    }
    // AI には 2 つの点の文を [A] [B] として見せる
    const one = prompts[0];
    assert.match(one, /\[A\][\s\S]*\[B\]/);
    assert.match(one, /別の本・別のテーマ/);
    // 線・面・立体の AI の回数（G5-2）には入れない
    assert.equal(analysis.stats.calls.chat, fake.calls.bodies.filter((b) => ['line', 'plane', 'solid'].includes(b.response_format?.json_schema?.name)).length);
    assert.equal(analysisShapeError(analysis), '');
  } finally {
    await fake.close();
  }
});

test('G6-2: 同じデータなら同じ候補（キャッシュが無い 2 回の分析で、AI に見せる組が同じ）。前に判定した組は判定し直さない', async () => {
  const fake = await startFakeLlm();
  try {
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const farPrompts = (from) => fake.calls.bodies.slice(from).filter((b) => b.response_format?.json_schema?.name === 'far').map((b) => b.messages[1].content);
    await analyzeLibrary({ library: sampleLibrary(), llm, options: { recommend: false } });
    const first = farPrompts(0);
    const mid = fake.calls.bodies.length;
    const cache = emptyCache();
    await analyzeLibrary({ library: sampleLibrary(), llm, cache, options: { recommend: false } });
    assert.deepEqual(farPrompts(mid), first, '同じデータなら同じ候補');
    // 保存したキャッシュでもう一度: 判定済みの組は飛ばし、まだ試していない組だけを判定する
    const end = fake.calls.bodies.length;
    await analyzeLibrary({ library: sampleLibrary(), llm, cache: deserializeCache(JSON.parse(JSON.stringify(serializeCache(cache)))), options: { recommend: false } });
    const again = farPrompts(end);
    assert.ok(again.length <= FAR_MAX_PAIRS);
    assert.ok(again.every((p) => !first.includes(p)), '前に判定した組は判定し直さない');
  } finally {
    await fake.close();
  }
});

test('遠い組み合わせの判定のキャッシュ: 消えた点・文を書き換えた点の判定は外す（保存を重くしない・書き換えたら判定し直す）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
    const keys = Object.keys(cache.far);
    assert.ok(keys.length >= 2);
    const [edited, removed] = keys;
    const ed = cache.far[edited];
    const rm = cache.far[removed];
    updateHighlight(lib, ed.a, { userNote: '自分の言葉に書き換えた' });
    // 書き換えた点と同じ点を含まない組の点を消す
    const gone = [rm.a, rm.b].find((id) => id !== ed.a && id !== ed.b);
    updateHighlight(lib, gone, { deleted: true });
    await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
    assert.ok(!(edited in cache.far), '書き換えた点の古い判定は外す');
    assert.ok(!(removed in cache.far), '消した点の判定は外す');
    assert.ok(Object.values(cache.far).every((v) => v.a !== gone && v.b !== gone));
    assert.ok(Object.values(cache.far).every((v) => !lib.highlights[v.a].deleted && !lib.highlights[v.b].deleted));
    // 古い版のキャッシュ（far が無い）でも動く
    const legacy = deserializeCache({ embeddings: { model: '', vectors: {} }, llm: {} });
    assert.deepEqual(legacy.far, {});
    const broken = { ...emptyCache(), far: 'x' };
    await analyzeLibrary({ library: lib, llm, cache: broken, options: { recommend: false } });
    assert.equal(typeof broken.far, 'object');
  } finally {
    await fake.close();
  }
});

test('G6-4: 「面白い」とした組は分析の結果から消えても残り続け、「ちがう」とした組は二度と出ない（候補にも入らない）', async () => {
  const fake = await startFakeLlm({ far: () => ({ shared: true, idea: '共通する考え', explanation: '同じことを別の言葉で言っている。' }) });
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const first = (await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis;
    assert.ok(first.farConnections.length >= 2);
    const [good, bad] = first.farConnections;
    assert.equal(reactFar(lib, good, 'interesting', T).status, 'interesting');
    reactFar(lib, bad, 'wrong', T);
    assert.deepEqual([...wrongFarIds(lib)], [bad.id]);
    // 「ちがう」とした組は画面に出さない。「面白い」は印付きで出る
    const shown = visibleFarConnections(first, lib);
    assert.ok(!shown.some((f) => f.id === bad.id));
    assert.equal(shown.find((f) => f.id === good.id).status, 'interesting');
    // キャッシュも前回の結果も無く、同じ組をもう一度選べる状態でも、反応を付けた組は AI に見せない（「ちがう」は結果にも入れない）
    const from = fake.calls.bodies.length;
    const fresh = (await analyzeLibrary({ library: lib, llm, options: { recommend: false } })).analysis;
    const prompts = fake.calls.bodies.slice(from).filter((b) => b.response_format?.json_schema?.name === 'far').map((b) => b.messages[1].content);
    const shows = (f) => (p) => p.includes(lib.highlights[f.a].text.slice(0, 30)) && p.includes(lib.highlights[f.b].text.slice(0, 30));
    assert.ok(prompts.length >= 1 && prompts.length <= FAR_MAX_PAIRS, 'ほかの組は判定する');
    assert.ok(!prompts.some(shows(bad)), '「ちがう」の組は AI に見せない');
    assert.ok(!prompts.some(shows(good)), '「面白い」の組も判定し直さない');
    assert.ok(!fresh.farConnections.some((f) => f.id === bad.id));
    assert.ok(visibleFarConnections(fresh, lib).some((f) => f.id === good.id), '「面白い」は残り続ける');
    // 前回の結果から持ち越すときは、「ちがう」の組も結果には残し（取り消せるように）、画面には出さない
    const second = (await analyzeLibrary({ library: lib, llm, previous: first, options: { recommend: false } })).analysis;
    assert.ok(second.farConnections.some((f) => f.id === bad.id));
    assert.ok(!visibleFarConnections(second, lib).some((f) => f.id === bad.id), '「ちがう」の組は画面に出ない');
    assert.ok(second.farConnections.some((f) => f.id === good.id));
    // 分析の結果から消えても（上限を超えた・別の端末の結果）、「面白い」は残り続ける
    const gone = { ...second, farConnections: [] };
    assert.deepEqual(visibleFarConnections(gone, lib).map((f) => f.id), [good.id]);
    // 反応を外すと、ただの遠いつながりに戻る
    assert.equal(reactFar(lib, good, 'interesting', T).status, '');
    assert.deepEqual(visibleFarConnections(gone, lib), []);
    // 分析し直したあとでも、「ちがう」を取り消せば、また出る
    assert.equal(reactFar(lib, bad, 'wrong', T).status, '');
    assert.ok(visibleFarConnections(second, lib).some((f) => f.id === bad.id));
    const third = (await analyzeLibrary({ library: lib, llm, previous: second, options: { recommend: false } })).analysis;
    assert.ok(visibleFarConnections(third, lib).some((f) => f.id === bad.id));
  } finally {
    await fake.close();
  }
});

test('G6-4: 反応は、候補の分野を狭めるのには使わない（「ちがう」とした組の点・本も、次からの分析でほかの組の候補に入り続ける）', () => {
  const reps = syntheticReps();
  const sourceOf = new Map(reps.map((r) => [r.id, r.source]));
  // 1 回目の分析の候補のうち 1 組を「ちがう」とし、残りは判定済みとして、次からの分析を候補が尽きるまで続ける
  const skipped = new Set();
  const first = farCandidates({ reps });
  const wrong = first[0];
  for (const c of first) skipped.add(c.id);
  const later = [];
  for (let run = 0; run < 50; run++) {
    const next = farCandidates({ reps, skip: (c) => skipped.has(c.id) });
    if (!next.length) break;
    for (const c of next) {
      skipped.add(c.id);
      later.push(c);
    }
  }
  assert.ok(!later.some((c) => c.id === wrong.id), '「ちがう」の組は二度と出ない');
  const has = (id) => (c) => c.a === id || c.b === id;
  assert.ok(later.some(has(wrong.a)) && later.some(has(wrong.b)), 'その 2 つの点は、ほかの組で試し続ける');
  const fromBook = (s) => (c) => sourceOf.get(c.a) === s || sourceOf.get(c.b) === s;
  assert.ok(later.some(fromBook(sourceOf.get(wrong.a))) && later.some(fromBook(sourceOf.get(wrong.b))), 'その本も候補に入り続ける');
});

test('C3: 遠いつながりへの反応は同期・バックアップの取り込みで失われず、統合の向きに依らない。壊れた値は捨てる', () => {
  const far = (id, a, b) => ({ id, a, b, idea: '考え', explanation: '説明' });
  const phone = emptyLibrary();
  const pc = emptyLibrary();
  const f1 = far(farId('h1', 'h2'), 'h1', 'h2');
  const f2 = far(farId('h3', 'h4'), 'h3', 'h4');
  reactFar(phone, f1, 'interesting', '2026-10-04T10:00:00.000Z');
  reactFar(pc, f1, 'wrong', '2026-10-04T11:00:00.000Z');
  reactFar(pc, f2, 'interesting', '2026-10-04T09:00:00.000Z');
  const ab = mergeLibraries(phone, pc);
  const ba = mergeLibraries(pc, phone);
  assert.deepEqual(ab.farReactions, ba.farReactions, '向きに依らない');
  assert.equal(ab.farReactions[f1.id].status, 'wrong', '付けた時刻が新しい方');
  assert.equal(ab.farReactions[f2.id].status, 'interesting');
  // 古い形のデータ（反応が無い）と統合しても消えない
  const legacy = emptyLibrary();
  delete legacy.farReactions;
  assert.deepEqual(mergeLibraries(legacy, ab).farReactions, ab.farReactions);
  assert.deepEqual(farReactionsOf(legacy), {});
  // バックアップの取り込み
  const restored = applyImport({ library: emptyLibrary() }, { backups: [makeBackup(ab, null)] }).library;
  assert.deepEqual(restored.farReactions, ab.farReactions);
  // 壊れた値: ID の形が違う・点が無い・知らない反応は捨てるか空にする
  const merged = mergeFarReactions({ x: { id: 'bad id', a: 'h1', b: 'h2', status: 'wrong' }, [f1.id]: { ...f1, status: 'love', updatedAt: T } }, { [f2.id]: { id: f2.id, a: 5, b: 'h4' } });
  assert.deepEqual(Object.keys(merged), [f1.id]);
  assert.equal(merged[f1.id].status, '');
  assert.throws(() => reactFar(phone, f1, 'love'), /不明な反応/);
  assert.throws(() => reactFar(phone, { id: 'x' }, 'wrong'), /見つかりません/);
});

test('G6-5: 新しい遠いつながりは発見に入る（前回の分析があるとき。前に見つかった組は発見にし直さない）', async () => {
  const fake = await startFakeLlm({ far: () => ({ shared: true, idea: '共通する考え', explanation: 'なぜつながるか。' }) });
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    assert.ok(first.farConnections.length >= 1);
    assert.deepEqual(first.discoveries, [], '最初の分析では作らない');
    const second = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    const fresh = second.farConnections.filter((f) => !first.farConnections.some((x) => x.id === f.id));
    assert.ok(fresh.length >= 1, '2 回目は前に判定していない組を試す');
    const farDisc = second.discoveries.filter((d) => d.kind === 'far');
    assert.deepEqual(farDisc.map((d) => farId(...d.pointIds)).sort(), fresh.map((f) => f.id).sort());
    for (const d of farDisc) {
      assert.equal(d.lineName, '共通する考え');
      assert.equal(d.reason, 'なぜつながるか。');
      assert.equal(d.foundAt, second.createdAt);
    }
    assert.ok(farDisc.every((d) => second.discoveries.indexOf(d) < farDisc.length), '同じ回の発見の中では先に出す');
    // 作り直した分析でも、新しく見つかった遠いつながりは発見にする（線の ID に依らない）
    const rebuilt = (await analyzeLibrary({ library: lib, llm, cache, previous: second, options: { recommend: false, full: true } })).analysis;
    const newer = rebuilt.farConnections.filter((f) => !second.farConnections.some((x) => x.id === f.id));
    assert.equal(rebuilt.discoveries.filter((d) => d.kind === 'far' && newer.some((f) => f.id === farId(...d.pointIds))).length, newer.length);
  } finally {
    await fake.close();
  }
});

test('遠いつながりの持ち越し: 同じ組は 1 つに・点が消えた組は外し、最大 50 件。形の壊れたものは分析の形として受け入れない', () => {
  const f = (i, a = `h${i}`, b = `h${i + 1000}`) => ({ id: farId(a, b), a, b, idea: '', explanation: '', foundAt: T });
  const merged = mergeFarConnections([f(1), f(2)], [f(2), f(3, 'h3', 'hgone'), f(4), null, { id: 5 }], (id) => id !== 'hgone');
  assert.deepEqual(merged.map((x) => x.id), [f(1).id, f(2).id, f(4).id]);
  // 届いた物に余計な欄があっても持ち越さない
  assert.deepEqual(Object.keys(mergeFarConnections([{ ...f(5), extra: 'x', idea: '考え' }])[0]).sort(), ['a', 'b', 'explanation', 'foundAt', 'id', 'idea']);
  assert.equal(mergeFarConnections(Array.from({ length: 80 }, (_, i) => f(i))).length, FAR_KEEP);
  // 「ちがう」とした組は上限の数に入れずに残す（新しい組に押し出されず、取り消せばまた出る）
  const old = Array.from({ length: 5 }, (_, i) => f(100 + i));
  const kept = mergeFarConnections(Array.from({ length: 80 }, (_, i) => f(i)), old, () => true, new Set(old.map((x) => x.id)));
  assert.equal(kept.length, FAR_KEEP + old.length);
  assert.ok(old.every((x) => kept.some((y) => y.id === x.id)));
  const base = { createdAt: T, lines: [], planes: [], solid: {} };
  assert.match(analysisShapeError({ ...base, farConnections: [{ id: 'f1' }] }), /遠いつながり/);
  assert.match(analysisShapeError({ ...base, farConnections: 'x' }), /遠いつながり/);
  assert.equal(analysisShapeError({ ...base, farConnections: [f(1)] }), '');
});

/** 遠いつながりを画面に出すための状態（サンプルの点 a と、別の本の点との組にする。fars(pair) の pair(i, …) は i 番目の組。b は 0 番目の相手） */
function farState(fars) {
  const library = sampleLibrary();
  const hs = Object.values(library.highlights);
  const [a, b] = [hs[0], hs.find((h) => h.bookId !== hs[0].bookId)];
  const others = hs.filter((h) => h.bookId !== a.bookId);
  const pair = (i, idea, explanation) => {
    const [x, y] = [a.id, others[i].id].sort();
    return { id: farId(x, y), a: x, b: y, idea, explanation, foundAt: T };
  };
  const farConnections = fars(pair);
  const analysis = {
    createdAt: T,
    stats: { points: 48, calls: { chat: 0, embed: 0 }, far: { candidates: 3, calls: 3, found: farConnections.length } },
    model: { chat: 'fake', embed: 'fake-embed' },
    lines: [{ id: 'l1', name: '仕組みの線', summary: '', insight: '', keywords: [], highlightIds: [a.id], bookIds: [] }],
    planes: [],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: [b.id],
    recommendations: [],
    farConnections,
    discoveries: [],
  };
  return { state: { library, analysis, settings: { ai: { mode: 'direct', companionUrl: '' }, autoSync: false }, servedByCompanion: false, pcInfo: null, job: null }, a, b };
}

test('G6-1 / C8: 知識の画面に「遠いつながり」が、共通する考え・説明・両側の点・反応のボタンとともに出る（文字はエスケープする）', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { farView } = await import('../web/js/views/far.js');
  const { state, a, b } = farState((pair) => Array.from({ length: 4 }, (_, i) => pair(i, `共通<b>${i}</b>`, '説明 <img src=x onerror=alert(1)>')));
  const out = String(knowledge.render({ state }));
  assert.match(out, /<h2>遠いつながり<\/h2><span class="small muted">4<\/span>/);
  assert.equal((out.match(/class="card far-card stack"/g) || []).length, 3, '知識の画面には 3 件まで');
  assert.match(out, /すべて見る（4）/);
  assert.match(out, /<h3>共通&lt;b&gt;0&lt;\/b&gt;<\/h3>/);
  assert.doesNotMatch(out, /<img src=x/);
  assert.ok(out.includes(a.text.slice(0, 20)) && out.includes(b.text.slice(0, 20)), '両側の点');
  assert.match(out, /線\(グループ\)「仕組みの線」/);
  assert.match(out, /まだつながっていない点/);
  // 反応のボタン: キーボードで押せる button・押した状態を読み上げる aria-pressed・ボタンの名前
  assert.match(out, /<div class="chips far-react" role="group" aria-label="「共通&lt;b&gt;0&lt;\/b&gt;」への反応">/, '反応のまとまりの名前は、カードごとに共通する考えで分かる');
  assert.match(out, /<button type="button" class="chip" data-action="far-react" data-id="f[0-9a-z]+" data-status="interesting" aria-pressed="false">面白い<\/button>/);
  assert.match(out, /data-status="wrong" aria-pressed="false">ちがう<\/button>/);
  assert.match(out, /ほかに遠い組の判定 3/);
  const list = String(farView.render({ state }));
  assert.equal((list.match(/class="card far-card stack"/g) || []).length, 4);
  // 「ちがう」とした組は一覧から消え、取り消せる欄にだけ出る
  reactFar(state.library, state.analysis.farConnections[0], 'wrong', T);
  const after = String(farView.render({ state }));
  assert.equal((after.match(/class="card far-card stack"/g) || []).length, 3);
  assert.match(after, /「ちがう」とした組/);
  assert.match(after, /<button type="button" class="btn small" data-action="far-react" data-id="f[0-9a-z]+" data-status="wrong" aria-label="「共通&lt;b&gt;0&lt;\/b&gt;」の「ちがう」を取り消す">取り消す<\/button>/);
  // 片側の点を消した組は出さない（ホームの発見と同じ）
  updateHighlight(state.library, state.analysis.farConnections[1].b, { deleted: true });
  assert.equal((String(farView.render({ state })).match(/class="card far-card stack"/g) || []).length, 2);
  assert.match(String(knowledge.render({ state })), /<h2>遠いつながり<\/h2><span class="small muted">2<\/span>/);
});

test('G6-1: 遠いつながりが無いときも、理由を出す（黙って空にしない）', async () => {
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { state } = farState(() => []);
  assert.match(String(knowledge.render({ state })), /前回の分析では 3 組を読み、共通する考えのある組は見つかりませんでした/);
  state.analysis.farNote = '遠い組み合わせの判定に失敗しました（接続できません）。次の分析でもう一度試します。';
  assert.match(String(knowledge.render({ state })), /遠い組み合わせの判定に失敗しました/);
  delete state.analysis.stats.far;
  assert.match(String(knowledge.render({ state })), /まだ遠いつながりはありません/);
});

test('G6-5: 遠いつながりの発見は、ホーム・すべての発見に「遠いつながり」として出て、開くと反応できる。「ちがう」とした組の発見は出さない', async () => {
  const { home } = await import('../web/js/views/library.js');
  const { discoveriesView, discoveryView } = await import('../web/js/views/discoveries.js');
  const { farDiscovery } = await import('../web/core/analysis/discoveries.js');
  const { state } = farState((pair) => [pair(0, '仕組みが先', '環境を変えると行動が変わる、という同じ考え。')]);
  const d = farDiscovery(state.analysis.farConnections[0]);
  state.analysis.discoveries = [d];
  const out = String(home.render({ state, shuffle: 0 }));
  assert.match(out, /<a class="disc-item far" href="#\/discovery\/d[0-9a-z]+">/);
  assert.match(out, /<span class="disc-kind">遠いつながり <span class="badge new">未読<\/span><\/span>/);
  assert.match(out, /共通する考え「仕組みが先」/);
  const page = String(discoveryView.render({ state, params: { id: d.id } }));
  assert.match(page, /<h1>遠いつながり<\/h1>/);
  assert.match(page, /環境を変えると行動が変わる、という同じ考え。/);
  assert.match(page, /data-action="far-react"/);
  reactFar(state.library, state.analysis.farConnections[0], 'wrong', T);
  assert.doesNotMatch(String(home.render({ state, shuffle: 0 })), /class="discoveries"/);
  assert.match(String(discoveriesView.render({ state })), /0 件（未読 0 件）/);
  assert.match(String(discoveryView.render({ state, params: { id: d.id } })), /「ちがう」としたか、分析し直して消えました/);
});

test('G6-4: 反応を付ける相手は、画面に出ている遠いつながりか、「ちがう」とした組なら反応の記録から探す（取り消せる）', () => {
  const { state } = farState((pair) => [pair(0, '考え', '説明'), pair(1, '別の考え', '別の説明')]);
  const [x, y] = state.analysis.farConnections;
  assert.equal(farConnectionById(state.analysis, state.library, x.id).id, x.id);
  reactFar(state.library, y, 'wrong', T);
  // 画面からは消えるが、反応の記録から探せる（取り消すため）
  assert.ok(!visibleFarConnections(state.analysis, state.library).some((f) => f.id === y.id));
  assert.equal(farConnectionById({ farConnections: [] }, state.library, y.id).idea, '別の考え');
  assert.equal(farConnectionById(state.analysis, state.library, 'constructor'), null, '入れ物の継承した名前は引かない');
  assert.equal(farConnectionById(state.analysis, state.library, 'fnothing'), null);
  // app.js: 押したら端末に保存して同期する
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  assert.match(app, /\[\/\^\\\/knowledge\\\/far\$\/, farView, 'knowledge'\]/);
  assert.match(app, /async 'far-react'\(el\) \{[\s\S]*?farConnectionById\(state\.analysis, state\.library, el\.dataset\.id\)[\s\S]*?reactFar\(state\.library, f, el\.dataset\.status\)[\s\S]*?await persistLibrary\(\);[\s\S]*?autoSyncAfterChange\(\);/);
  const sw = readFileSync(join(WEB, 'sw.js'), 'utf8');
  for (const f of ['js/views/far.js', 'core/analysis/far.js', 'core/far-reactions.js']) assert.ok(sw.includes(`'${f}'`), `${f} をオフライン用に持つ`);
});

// 届いたデータ・AI の答えの形（同期で届く反応・ほかの端末の分析・AI の出力は信用しない）
const goodFar = { id: farId('h1', 'h2'), a: 'h1', b: 'h2', idea: '考え', explanation: '説明', foundAt: T };

test('同期で届いた反応の形を確かめる（反応の型・点の ID・組と ID の対応・時刻）。壊れた値で止まらない', () => {
  const ok = { id: goodFar.id, a: 'h1', b: 'h2', idea: '考え', explanation: '説明', status: 'wrong', updatedAt: '2026-10-04T10:00:00.000Z' };
  assert.deepEqual(normalizeFarReaction(ok, T), ok);
  assert.equal(normalizeFarReaction({ ...ok, status: ['wrong'] }).status, '', '配列の反応は「反応なし」');
  assert.equal(normalizeFarReaction({ ...ok, status: { toString: 1 } }).status, '');
  assert.equal(normalizeFarReaction({ ...ok, a: 'h1'.padEnd(5_000_000, 'x') }), null, '長すぎる点の ID は捨てる');
  assert.equal(normalizeFarReaction({ ...ok, b: 'h3' }), null, 'ID と組が合わないものは捨てる');
  assert.equal(normalizeFarReaction({ ...ok, updatedAt: 'zzzz' }).updatedAt, '', '時刻の形でなければ勝たない');
  // 未来すぎる時刻は、今の時刻に直す（いつまでも勝ち続けない。消すと、時計の進んだ端末の操作が負ける）
  assert.equal(normalizeFarReaction({ ...ok, updatedAt: '2999-01-01T00:00:00.000Z' }, T).updatedAt, T);
  // 正しい時刻の反応が、壊れた時刻の反応に勝つ（向きに依らない）
  for (const merged of [mergeFarReactions({ [ok.id]: { ...ok, status: 'interesting', updatedAt: 'zzzz' } }, { [ok.id]: ok }), mergeFarReactions({ [ok.id]: ok }, { [ok.id]: { ...ok, status: 'interesting', updatedAt: 'zzzz' } })]) assert.equal(merged[ok.id].status, 'wrong');
  // 時計が 2 日進んだスマホの「ちがう」は、PC の 1 時間前の「面白い」に勝つ（向きに依らない）
  const pc = { [ok.id]: { ...ok, status: 'interesting', updatedAt: '2026-10-04T11:00:00.000Z' } };
  const phone = { [ok.id]: { ...ok, status: 'wrong', updatedAt: '2026-10-06T12:00:00.000Z' } };
  for (const merged of [mergeFarReactions(pc, phone, T), mergeFarReactions(phone, pc, T)]) assert.deepEqual([merged[ok.id].status, merged[ok.id].updatedAt], ['wrong', T]);
});

test('空白だけの長い文の反応が届いても、形を整える処理はすぐ終わる（先に切ってから整える）', () => {
  const long = ' '.repeat(200_000);
  const t = performance.now();
  const r = normalizeFarReaction({ ...goodFar, idea: long, explanation: `説明${long}`, status: '', updatedAt: '' });
  assert.ok(performance.now() - t < 1000, `${Math.round(performance.now() - t)} ms`);
  assert.deepEqual([r.idea, r.explanation], ['', '説明']);
});

test('形の壊れた遠いつながり（文字にできない値・組と合わない ID など）は分析の形として受け入れず、画面も止まらない', async () => {
  const base = { createdAt: T, lines: [], planes: [], solid: {} };
  assert.match(analysisShapeError({ ...base, farConnections: [{ ...goodFar, idea: { toString: 1 } }] }), /遠いつながり/);
  assert.match(analysisShapeError({ ...base, farConnections: [{ ...goodFar, id: farId('h1', 'h3') }] }), /遠いつながり/);
  assert.match(analysisShapeError({ ...base, farNote: { toString: 1 } }), /farNote/);
  assert.match(analysisShapeError({ ...base, stats: { far: { candidates: 'x', calls: 1, found: 0 } } }), /stats\.far/);
  assert.equal(analysisShapeError({ ...base, farNote: '説明', stats: { far: { candidates: 1, calls: 1, found: 0 } }, farConnections: [goodFar] }), '');
  // 画面: 文字にできない値は空として描く（例外で画面全体が描けなくならない。esc は text-safety.test.js）
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const { farView } = await import('../web/js/views/far.js');
  const { state } = farState(() => []);
  state.analysis.farConnections = [{ ...goodFar, idea: { toString: 1 } }];
  state.analysis.farNote = { toString: 1 };
  assert.doesNotThrow(() => String(knowledge.render({ state })));
  assert.doesNotThrow(() => String(farView.render({ state })));
});

test('AI の答えの制御文字は落とす（端末・画面にそのまま出さない）。長い答えは文字の途中で切らない', () => {
  const v = farVerdict({ shared: true, idea: '考え\u001b[31m赤', explanation: '説明\u0007です\n次の行' });
  assert.equal(v.idea, '考え [31m赤');
  assert.equal(v.explanation, '説明 です 次の行');
  const long = farVerdict({ shared: true, idea: '𠮟'.repeat(60), explanation: 'x' }).idea;
  assert.doesNotMatch(long, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, '半端な文字が残らない');
  assert.ok(long.endsWith('…'));
});

test('代表の点が多くても（点 1 万件超で、まだつながらない点が数千）、候補は上限の数の代表の点から選ぶ', () => {
  const reps = Array.from({ length: 7000 }, (_, i) => ({ id: `t${i.toString(36)}`, vector: l2normalize(Float32Array.from([Math.cos(i), Math.sin(i), (i % 7) / 7])), plane: null, source: `t${i}`, isolated: true }));
  assert.equal(pickReps(reps).length, FAR_MAX_REPS);
  const t = performance.now();
  const c = farCandidates({ reps: pickReps(reps) });
  assert.ok(performance.now() - t < 5000, `${Math.round(performance.now() - t)} ms`);
  assert.equal(c.length, FAR_MAX_PAIRS);
  assert.deepEqual(farCandidates({ reps }), farCandidates({ reps: reps.slice(0, FAR_MAX_REPS) }), '渡された代表の点が多すぎても、上限の数までしか使わない');
  // 線の代表を先に、まだつながらない点は、前に判定した組に入った回数が少ない点から
  const mixed = [...reps.slice(0, 3), { id: 'h1', isolated: false }, { id: 'h2', isolated: false }];
  const counts = { t0: 5, t1: 0, t2: 1 };
  assert.deepEqual(pickReps(mixed, (id) => counts[id] || 0, 4).map((r) => r.id), ['h1', 'h2', 't1', 't2']);
});

/** 線・面・立体だけを答える AI（遠い組み合わせの判定は far に任せる） */
const stubLlm = (far) => ({
  chatModel: 'stub',
  chatJson: async (p) => (p.name === 'far' ? far(p) : p.name === 'line' ? { name: '線', summary: '要約', insight: '', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '要約' } : { title: '核', core: '核', relations: [], principles: [], questions: [] }),
});

test('C6: 埋め込みモデルが無いとき（文字 n-gram）も、遠い組み合わせを選んで判定する', async () => {
  const { analysis } = await analyzeLibrary({ library: sampleLibrary(), llm: stubLlm(() => ({ shared: true, idea: '共通する考え', explanation: 'なぜつながるか。' })), options: { recommend: false } });
  assert.equal(analysis.model.embed, 'tfidf');
  assert.ok(analysis.stats.far.calls >= 1);
  assert.equal(analysis.farConnections.length, analysis.stats.far.found);
  assert.ok(analysis.farConnections.length >= 1);
});

test('判定のあとで分析を中止しても（分析は保存されない）、「ある」と判定した組は、次の分析で判定し直さずに結果と発見に入る', async () => {
  const fake = await startFakeLlm({ far: () => ({ shared: true, idea: '共通する考え', explanation: 'なぜつながるか。' }) });
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    // 2 回目: 遠い組み合わせを判定したあと、おすすめの段階で中止する（分析は保存されないが、キャッシュは保存される）
    const ctrl = new AbortController();
    const mid = fake.calls.bodies.length;
    await assert.rejects(analyzeLibrary({ library: lib, llm, cache, previous: first, signal: ctrl.signal, onProgress: (p) => p.stage === 'recommend' && ctrl.abort(), options: { fetchImpl: async () => Response.json({ items: [] }) } }), /中止/);
    const farPrompts = (from, to) => fake.calls.bodies.slice(from, to).filter((b) => b.response_format?.json_schema?.name === 'far').map((b) => b.messages[1].content);
    const aborted = farPrompts(mid);
    const yes = Object.values(cache.far).filter((v) => v.shared && !first.farConnections.some((f) => f.id === farId(v.a, v.b)));
    assert.ok(aborted.length >= 1 && yes.length >= 1, '中止した回に「ある」と判定した組がある（試験の前提）');
    const end = fake.calls.bodies.length;
    const third = (await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } })).analysis;
    for (const v of yes) {
      const id = farId(v.a, v.b);
      assert.ok(third.farConnections.some((f) => f.id === id), '中止した回の「ある」も結果に入る');
      assert.ok(third.discoveries.some((d) => d.kind === 'far' && farId(...d.pointIds) === id), '前の分析に届いていないので、新しい発見');
    }
    assert.ok(farPrompts(end).every((p) => !aborted.includes(p)), '判定し直さない');
    // 届いた回のものは、次の分析で入れ直さない（発見が重ならない）
    const fourth = (await analyzeLibrary({ library: lib, llm, cache, previous: third, options: { recommend: false } })).analysis;
    assert.equal(fourth.discoveries.filter((d) => d.kind === 'far' && d.foundAt === fourth.createdAt && yes.some((v) => farId(v.a, v.b) === farId(...d.pointIds))).length, 0);
  } finally {
    await fake.close();
  }
});

test('答えが読めなかった組は次の分析でもう一度だけ試し、2 回読めなければ試さない（いつも同じ組で止まらない）', async () => {
  const asked = [];
  const llm = stubLlm((p) => (asked.push(p.user), { result: '読めない答え' }));
  const lib = sampleLibrary();
  const cache = emptyCache();
  await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
  const firstRun = [...asked];
  assert.ok(firstRun.length >= 1);
  await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
  const secondRun = asked.slice(firstRun.length);
  assert.deepEqual(secondRun, firstRun, '1 回読めなかった組は、次の分析でもう一度試す');
  await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
  assert.ok(asked.slice(firstRun.length + secondRun.length).every((p) => !firstRun.includes(p)), '2 回読めなかった組は試さない');
  assert.ok(Object.values(cache.far).every((v) => v.unreadable >= 1 && v.shared === undefined), '「ない」とは覚えない');
});

test('遠い組み合わせの判定に失敗したら、理由を残し（URL の利用者名・パスワードは伏せる）、2 回で残りは次の分析に回す', async () => {
  const failing = stubLlm(() => Promise.reject(new Error('LLM サーバに接続できません (http://user:secret@127.0.0.1:9): fetch failed')));
  const { analysis } = await analyzeLibrary({ library: sampleLibrary(), llm: failing, options: { recommend: false } });
  assert.equal(analysis.stats.far.calls, 2);
  assert.deepEqual(analysis.farConnections, []);
  assert.match(analysis.farNote, /http:\/\/\*\*\*@127\.0\.0\.1:9/);
  assert.doesNotMatch(analysis.farNote, /secret/);
  assert.ok(analysis.lines.length > 0, 'それまでの結果（線・面・立体）は残る');
  // 長いエラー文でも、分析の形として受け入れられる長さに切る
  const verbose = stubLlm(() => Promise.reject(new Error('x'.repeat(5000))));
  const long = (await analyzeLibrary({ library: sampleLibrary(), llm: verbose, options: { recommend: false } })).analysis;
  assert.ok(long.farNote.length < 400);
  assert.equal(analysisShapeError(long), '');
});

// G6-6 おすすめの本の種類
const vol = (id, title) => ({ id, volumeInfo: { title, authors: ['著者'], publishedDate: '2020', infoLink: `https://books.google.com/?id=${id}` } });
const planesAnalysis = { solid: { core: '小さな仕組みが行動を変える', questions: ['どうすれば続くか'] }, planes: [{ id: 'p1', name: '習慣', summary: '習慣と行動' }, { id: 'p2', name: '学び', summary: '学び方' }] };
// 検索語ごとに別の本が見つかる書誌 DB
const booksFor = (q) => [vol(`${q}-1`, `${q}の本 1`), vol(`${q}-2`, `${q}の本 2`)];
const fetchBooks = async (url) => Response.json({ items: booksFor(new URL(url).searchParams.get('q') || '') });

/** 「深める」しか選ばない AI（実データの qwen2.5:7b で、おすすめがすべて「深める」になった） */
function deepenOnlyLlm(log) {
  return {
    chatModel: 'stub',
    chatJson: async (p) => {
      log.push(p);
      if (p.name === 'searches') return { searches: [{ query: '習慣', plane: 'P1', kind: 'deepen' }, { query: '行動', plane: 'P1', kind: 'deepen' }] };
      if (p.name === 'searches-kind') return { searches: [{ query: p.user.includes('「broaden」') ? '隣の分野' : '反対の立場', plane: 'P2', kind: 'deepen' }] };
      if (p.name === 'picks') return { picks: [1, 2, 3, 4, 5, 6].map((candidate) => ({ candidate, plane: 'P1', kind: 'deepen', reason: '深める' })) };
      if (p.name === 'picks-kind') return { picks: [{ candidate: 2, plane: 'P2', kind: 'deepen', reason: `${p.user.includes('「broaden」') ? '広げる' : '揺さぶる'}理由` }] };
      if (p.name === 'recommendations') return { books: Array.from({ length: 8 }, (_, i) => ({ title: `深める本 ${i}`, author: 'A', plane: 'P1', kind: 'deepen', reason: '深める' })) };
      if (p.name === 'recommendations-kind') return { books: [{ title: p.user.includes('「broaden」') ? '広げる本' : '揺さぶる本', author: 'B', plane: 'P2', kind: 'deepen', reason: '足した理由' }] };
      throw new Error(`知らない依頼: ${p.name}`);
    },
  };
}

test('G6-6: AI が「深める」しか選ばなくても、おすすめに「広げる」と「揺さぶる」を 1 冊以上ずつ入れる（書誌 DB の候補から）', async () => {
  const log = [];
  const recs = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm: deepenOnlyLlm(log), fetchImpl: fetchBooks, count: 6 });
  assert.equal(recs.length, 6);
  for (const kind of REQUIRED_KINDS) assert.ok(recs.some((r) => r.kind === kind), `${kind} が無い`);
  const broaden = recs.find((r) => r.kind === 'broaden');
  assert.equal(broaden.query, '隣の分野', '広げる方向で探した候補から');
  assert.equal(broaden.reason, '広げる理由');
  assert.equal(recs.find((r) => r.kind === 'challenge').query, '反対の立場');
  // 最初の依頼から、広げる・揺さぶるを 1 つ以上ずつ入れるよう頼んでいる
  assert.match(log.find((p) => p.name === 'searches').user, /「broaden」と「challenge」を 1 つ以上ずつ入れる/);
  assert.match(log.find((p) => p.name === 'picks').user, /「broaden」と「challenge」を 1 つ以上ずつ入れる/);
  // 足すときは、その種類だけを頼む（揺さぶるだけを頼むときも、興味なしの方向に近くても入れると伝える）
  const kindSearch = log.filter((p) => p.name === 'searches-kind');
  assert.equal(kindSearch.length, 2);
  assert.deepEqual(kindSearch.map((p) => p.schema.properties.searches.items.properties.kind.enum), [['broaden'], ['challenge']]);
  assert.match(kindSearch[1].user, /興味なしとした方向に近くても入れる/);
  assert.doesNotMatch(kindSearch[0].user, /興味なしとした方向に近くても入れる/);
});

test('G6-6: 足りない種類を足す依頼の答えが壊れていても（null など）、選べた本は捨てない（書誌 DB の道）', async () => {
  const llm = {
    chatModel: 'stub',
    chatJson: async (p) => {
      if (p.name === 'searches') return { searches: [null, { query: '習慣', plane: 'P1', kind: 'deepen' }] };
      if (p.name === 'searches-kind') return { searches: [null, 3, { query: p.user.includes('「broaden」') ? '隣の分野' : '反対の立場', plane: 'P2', kind: 'x' }] };
      if (p.name === 'picks') return { picks: [null, { candidate: 1, plane: 'P1', kind: 'deepen', reason: '深める' }] };
      if (p.name === 'picks-kind') return { picks: [null, 'x'] };
      throw new Error(`知らない依頼: ${p.name}`);
    },
  };
  const recs = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm, fetchImpl: fetchBooks, count: 6 });
  assert.deepEqual(recs.map((r) => [r.kind, r.query]), [['deepen', '習慣'], ['broaden', '隣の分野'], ['challenge', '反対の立場']]);
  assert.ok(recs.slice(1).every((r) => r.reason.endsWith('足しました。')), 'AI が理由を書けなかったときは決まった理由');
});

test('G6-6: 「興味なし」の反応があっても「揺さぶる」の枠は残る', async () => {
  const lib = emptyLibrary();
  // 反応は新しい順に並ぶので、時刻を決めて並びを固定する（同じミリ秒かどうかで並びが変わらないように）
  setFeedback(lib, { title: '反対の立場の本 1', author: '著者' }, 'no', '2026-10-04T10:00:01.000Z');
  setFeedback(lib, { title: '耳の痛い本', author: '著者' }, 'no', '2026-10-04T10:00:00.000Z');
  const log = [];
  const recs = await recommendBooks({ library: lib, analysis: planesAnalysis, llm: deepenOnlyLlm(log), fetchImpl: fetchBooks, count: 6 });
  const challenge = recs.filter((r) => r.kind === 'challenge');
  assert.equal(challenge.length, 1);
  assert.notEqual(challenge[0].title, '反対の立場の本 1', '興味なしとした本そのものは出さない');
  assert.match(log.find((p) => p.name === 'searches').user, /興味なしとした本: 反対の立場の本 1、耳の痛い本/);
  assert.match(log.find((p) => p.name === 'searches').user, /「challenge」は、興味なしとした方向に近くても入れる/);
});

test('G6-6: 書誌 DB で探せないときも、AI に書名を挙げさせる道で「広げる」「揺さぶる」を足す。候補が無い種類は作らない', async () => {
  const log = [];
  const recs = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm: deepenOnlyLlm(log), verify: false, count: 6 });
  assert.equal(recs.length, 6);
  assert.deepEqual(recs.filter((r) => r.kind !== 'deepen').map((r) => [r.title, r.kind]), [['広げる本', 'broaden'], ['揺さぶる本', 'challenge']]);
  assert.deepEqual(log.filter((p) => p.name === 'recommendations-kind').map((p) => p.schema.properties.books.items.properties.kind.enum), [['broaden'], ['challenge']]);
  // 足すための依頼が失敗しても、選べた本は捨てない（その種類の候補が無いときは足さない）
  const failing = { chatModel: 'stub', chatJson: async (p) => (p.name.endsWith('-kind') ? Promise.reject(new Error('壊れた応答')) : deepenOnlyLlm([]).chatJson(p)) };
  const kept = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm: failing, verify: false, count: 6 });
  assert.equal(kept.length, 6);
  assert.ok(kept.every((r) => r.kind === 'deepen'));
  // 書誌 DB の道: 足す種類の検索（隣の分野・反対の立場）で何も見つからなければ、その種類の本を作らない（AI 任せの書名も足さない）
  const noBooks = async (url) => {
    const q = new URL(url).searchParams.get('q') || '';
    return Response.json({ items: /隣|反/.test(q) ? [] : booksFor(q) });
  };
  const log2 = [];
  const partial = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm: deepenOnlyLlm(log2), fetchImpl: noBooks, count: 6 });
  assert.equal(partial.length, 4, '見つかった候補（習慣・行動の 4 冊）だけ');
  assert.ok(partial.every((r) => r.kind === 'deepen' && r.verified));
  assert.equal(log2.filter((p) => p.name === 'searches-kind').length, 2, '足す種類の検索は試した');
  assert.equal(log2.filter((p) => p.name === 'picks-kind').length, 0);
});

test('G6-6: AI の答えに壊れた本（null など）が混ざっても止まらない', async () => {
  const llm = {
    chatModel: 'stub',
    chatJson: async (p) => (p.name === 'recommendations' ? { books: [null, 5, { title: '深める本', author: 'A', plane: 'P1', kind: 'deepen', reason: 'r' }] } : { books: [null, { title: '足した本', author: 'B', plane: 'P2', kind: 'x', reason: 'r' }] }),
  };
  const recs = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm, verify: false, count: 6 });
  assert.deepEqual(recs.map((r) => [r.title, r.kind]), [['深める本', 'deepen'], ['足した本', 'broaden']], '揺さぶるの依頼にも同じ書名が返ったので、それは足さない');
});

test('G6-6: AI が選んだ種類がそろっていれば、足さない（余分に AI を呼ばない）', async () => {
  const log = [];
  const llm = {
    chatModel: 'stub',
    chatJson: async (p) => {
      log.push(p.name);
      if (p.name === 'searches') return { searches: [{ query: '習慣', plane: 'P1', kind: 'deepen' }, { query: '隣', plane: 'P2', kind: 'broaden' }, { query: '反対', plane: 'P2', kind: 'challenge' }] };
      return { picks: [{ candidate: 1, plane: 'P1', kind: 'deepen', reason: 'a' }, { candidate: 3, plane: 'P2', kind: 'broaden', reason: 'b' }, { candidate: 5, plane: 'P2', kind: 'challenge', reason: 'c' }] };
    },
  };
  const recs = await recommendBooks({ library: emptyLibrary(), analysis: planesAnalysis, llm, fetchImpl: fetchBooks, count: 6 });
  assert.deepEqual(recs.map((r) => r.kind), ['deepen', 'broaden', 'challenge']);
  assert.deepEqual(log, ['searches', 'picks']);
});

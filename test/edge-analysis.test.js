// 分析まわり（web/core/analysis/*）の境界のテスト: 空・1 件・ゼロ/同一/NaN ベクトル・k > n・壊れた LLM 出力・
// 中止/タイムアウト・特殊文字・増分の分析での消えた点・決定性・入力を書き換えないこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient, extractJson, LlmError, normalizeBaseUrl } from '../web/core/analysis/llm.js';
import { analyzeLibrary, deserializeCache, emptyCache, lineSample, recommendBooks, recommendationNote, serializeCache } from '../web/core/analysis/pipeline.js';
import { centroid, dot, groupLines, groupPoints, kmeans, l2normalize, tfidfEmbed } from '../web/core/analysis/vectors.js';
import { carryLines, carryPlanes } from '../web/core/analysis/incremental.js';
import { diffAnalyses, hasChanges } from '../web/core/analysis/changes.js';
import { discoveryId, findDiscoveries, isDiscovery, mergeDiscoveries, DISCOVERIES_KEEP, DISCOVERIES_PER_ANALYSIS } from '../web/core/analysis/discoveries.js';
import { analysisShapeError, isAnalysisShape, isAnalysisTime } from '../web/core/analysis/shape.js';
import { linePrompt, planePrompt, pickPrompt, pointLine, preferenceLines, recommendPrompt, searchPrompt, solidPrompt } from '../web/core/analysis/prompts.js';
import { matchVolume, parseCinii, parseNdlRss, searchBooks, verifyBooks } from '../web/core/analysis/recommend.js';

const axis = (i, dims = 4) => Float32Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
const near = (i, eps, dims = 4) => l2normalize(Float32Array.from({ length: dims }, (_, j) => (j === i ? 1 : j === (i + 1) % dims ? eps : 0)));

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

function libraryOf(texts) {
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: 'テストの本', source: 'kindle', highlights: texts.map((text, i) => ({ text, location: i + 1 })) }], { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

/** 決まった答えを返す LLM（chatJson の答えを依頼の name ごとに差し替えられる） */
function stubLlm(answers = {}, { embedModel = '' } = {}) {
  const calls = [];
  const defaults = {
    line: (p) => ({ name: `概念${calls.length}`, summary: '共通の考え。', insight: '問い。', keywords: ['a', 'b'] }),
    plane: () => ({ name: 'テーマ', summary: '束ねたテーマ。' }),
    solid: () => ({ title: '核', core: '中心。', relations: [], principles: ['する'], questions: ['か？'] }),
  };
  return {
    calls,
    chatModel: 'stub',
    embedModel,
    async chatJson(p) {
      calls.push(p.name);
      const f = answers[p.name] ?? defaults[p.name];
      return typeof f === 'function' ? f(p) : f;
    },
    async embed(texts) {
      return texts.map((t) => tfidfEmbed([t, 'x'])[0]);
    },
  };
}

/** chat/completions に決まった本文を返す fetch */
function chatFetch(contents, seen = []) {
  let i = 0;
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    const c = contents[Math.min(i++, contents.length - 1)];
    if (c instanceof Response) return c;
    return Response.json({ choices: [{ message: { role: 'assistant', content: c } }] });
  };
}

// ---------- vectors ----------

test('edge vectors: l2normalize はゼロベクトルで NaN を出さず、入力を書き換えない', () => {
  const z = new Float32Array(3);
  assert.deepEqual([...l2normalize(z)], [0, 0, 0]);
  const v = Float32Array.from([3, 4]);
  const n = l2normalize(v);
  assert.deepEqual([...v], [3, 4]);
  assert.ok(Math.abs(n[0] - 0.6) < 1e-6 && Math.abs(n[1] - 0.8) < 1e-6);
  assert.deepEqual([...l2normalize([])], []);
});

test('edge vectors: dot は同じベクトルで 1、直交で 0、ゼロで 0', () => {
  assert.ok(Math.abs(dot(axis(0), axis(0)) - 1) < 1e-9);
  assert.equal(dot(axis(0), axis(1)), 0);
  assert.equal(dot(new Float32Array(4), axis(2)), 0);
});

test('edge vectors: tfidfEmbed は空配列・空文字・記号だけ・1 文字・絵文字でも有限の値を返す', () => {
  assert.deepEqual(tfidfEmbed([]), []);
  const vs = tfidfEmbed(['', '。、！？', 'あ', '😀😀😀', 'naïve café', '注意は資源']);
  assert.equal(vs.length, 6);
  for (const v of vs) {
    assert.equal(v.length, 1024);
    assert.ok([...v].every(Number.isFinite));
  }
  // 中身の無い文はゼロベクトル（NaN にしない）
  assert.ok([...vs[0]].every((x) => x === 0));
  assert.ok(Math.abs(dot(vs[5], vs[5]) - 1) < 1e-5);
  // 決定的
  assert.deepEqual([...tfidfEmbed(['注意は資源', '別の文'])[0]], [...tfidfEmbed(['注意は資源', '別の文'])[0]]);
});

test('edge vectors: centroid は 1 本ならそのベクトル、逆向き 2 本ならゼロ', () => {
  assert.deepEqual([...centroid([axis(1)])], [...axis(1)]);
  const neg = Float32Array.from(axis(1), (x) => -x);
  assert.ok([...centroid([axis(1), neg])].every((x) => x === 0));
});

test('edge vectors: kmeans は k > n・k = 0・n = 1・同一ベクトルでも全員を割り当てる', () => {
  const r1 = kmeans([axis(0)], 5);
  assert.deepEqual(r1.assign, [0]);
  const r0 = kmeans([axis(0), axis(1)], 0);
  assert.equal(r0.centroids.length, 1);
  assert.deepEqual(r0.assign, [0, 0]);
  const same = Array.from({ length: 6 }, () => axis(2));
  const rs = kmeans(same, 3);
  assert.equal(rs.assign.length, 6);
  assert.ok(rs.assign.every((a) => a >= 0 && a < rs.centroids.length));
  const big = kmeans([axis(0), axis(1), axis(2)], 10);
  assert.equal(new Set(big.assign).size, 3);
});

test('edge vectors: kmeans は上限（maxSize）があっても全員を割り当て、入力を書き換えない', () => {
  const vecs = [...Array(5)].map(() => near(0, 0.01)).concat([axis(1)]);
  const copy = vecs.map((v) => [...v]);
  const { assign } = kmeans(vecs, 2, { maxSize: 1 });
  assert.equal(assign.length, 6);
  assert.ok(assign.every((a) => a === 0 || a === 1));
  assert.deepEqual(vecs.map((v) => [...v]), copy);
});

test('edge vectors: kmeans は NaN を含んでも落ちず、全員を割り当てる', () => {
  const vecs = [axis(0), Float32Array.from([NaN, 0, 0, 0]), axis(1), axis(1)];
  const { assign } = kmeans(vecs, 2);
  assert.equal(assign.length, 4);
  assert.ok(assign.every((a) => Number.isInteger(a) && a >= 0));
});

test('edge vectors: groupPoints は 0 件・1 件・minSize 未満ですべて「まだつながらない点」', () => {
  assert.deepEqual(groupPoints([]), { groups: [], isolated: [] });
  assert.deepEqual(groupPoints([axis(0)]), { groups: [], isolated: [0] });
  assert.deepEqual(groupPoints([axis(0), axis(1)], { minSize: 3 }), { groups: [], isolated: [0, 1] });
});

test('edge vectors: groupPoints は同一ベクトルを 1 本の線にまとめ、全員がちょうど 1 回出る', () => {
  const same = Array.from({ length: 7 }, () => axis(3));
  const { groups, isolated } = groupPoints(same, { targetSize: 2 });
  const all = [...groups.flat(), ...isolated].sort((a, b) => a - b);
  assert.deepEqual(all, [...same.keys()]);
  assert.ok(groups.every((g) => g.length >= 2));
});

test('edge vectors: groupPoints はゼロベクトルばかりでも落ちず、全員がちょうど 1 回出る', () => {
  const zeros = Array.from({ length: 5 }, () => new Float32Array(4));
  const { groups, isolated } = groupPoints(zeros);
  assert.deepEqual([...groups.flat(), ...isolated].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('edge vectors: groupPoints は NaN を含んでも落ちず、全員がちょうど 1 回出る', () => {
  const vecs = [axis(0), axis(0), Float32Array.from([NaN, NaN, 0, 0]), axis(1), axis(1)];
  const { groups, isolated } = groupPoints(vecs, { targetSize: 2 });
  assert.deepEqual([...groups.flat(), ...isolated].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('edge vectors: groupPoints は minSimilarity を数で渡すとそれより遠い点を外す', () => {
  const vecs = [axis(0), near(0, 0.05), near(0, 0.1), axis(1)];
  const { groups, isolated } = groupPoints(vecs, { targetSize: 4, minSimilarity: 0.9 });
  assert.deepEqual(groups, [[0, 1, 2]]);
  assert.deepEqual(isolated, [3]);
});

test('edge vectors: groupLines は 0 本で空、1〜2 本で 1 つの面、同一ベクトルでも 1 本の面を作らない', () => {
  assert.deepEqual(groupLines([]), []);
  assert.deepEqual(groupLines([axis(0)]), [[0]]);
  assert.deepEqual(groupLines([axis(0), axis(1)]), [[0, 1]]);
  const g3 = groupLines([axis(0), axis(1), axis(2)]);
  assert.deepEqual(g3.flat().sort(), [0, 1, 2]);
  assert.ok(g3.every((g) => g.length >= 2));
  const same = groupLines(Array.from({ length: 9 }, () => axis(0)));
  assert.deepEqual(same.flat().sort((a, b) => a - b), [...Array(9).keys()]);
  assert.ok(same.every((g) => g.length >= 2));
});

test('edge vectors: groupPoints / groupLines は同じ入力で同じ結果（決定的）', () => {
  const texts = SAMPLE_BOOKS.flatMap((b) => b.highlights.map((h) => h.text));
  const vecs = tfidfEmbed(texts);
  assert.deepEqual(groupPoints(vecs), groupPoints(vecs));
  assert.deepEqual(groupLines(vecs.slice(0, 15)), groupLines(vecs.slice(0, 15)));
});

// ---------- llm: extractJson ----------

test('edge llm: extractJson はコードフェンス・think・前後の説明文から JSON を取り出す', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```JSON\n[1,2]\n```'), [1, 2]);
  assert.deepEqual(extractJson('```\n{"a":"b"}\n```'), { a: 'b' });
  assert.deepEqual(extractJson('<think>{"wrong":1}</think>{"right":2}'), { right: 2 });
  assert.deepEqual(extractJson('考えた</think>\n{"x":1}'), { x: 1 });
  assert.deepEqual(extractJson('はい、結果です: {"name":"注意"} 以上です'), { name: '注意' });
  assert.deepEqual(extractJson('{"s":"中に } と { と \\" がある"} 後ろ'), { s: '中に } と { と " がある' });
  assert.deepEqual(extractJson('{"nested":{"a":[1,{"b":2}]}} trailing }'), { nested: { a: [1, { b: 2 }] } });
  assert.deepEqual(extractJson('{"emoji":"😀","jp":"日本語"}'), { emoji: '😀', jp: '日本語' });
});

test('edge llm: extractJson は読めない出力で undefined（例外にしない）', () => {
  for (const s of ['', '   ', 'JSON はありません', '{"a":1', '{"a": {"b": 1}', '[注] {"a": [1, {"b": 2}', '{"a":', '```json\n{"a":\n```', '{bad json}', undefined, null, '<think>まだ考え中']) {
    assert.equal(extractJson(s), undefined, JSON.stringify(s));
  }
});

test('edge llm: extractJson は前に括弧つきの説明があっても、後ろの JSON を取り出す', () => {
  assert.deepEqual(extractJson('[注] 以下が出力です: {"name":"注意"}'), { name: '注意' });
  assert.deepEqual(extractJson('形式 {name, summary} で出力します。\n{"name":"線","summary":"説明"}'), { name: '線', summary: '説明' });
});

test('edge llm: normalizeBaseUrl は末尾のスラッシュと /v1 を落とし、空や null で空文字', () => {
  assert.equal(normalizeBaseUrl('http://x:1/v1/'), 'http://x:1');
  assert.equal(normalizeBaseUrl('  http://x:1///  '), 'http://x:1');
  assert.equal(normalizeBaseUrl('https://pc.ts.net/llm/v1'), 'https://pc.ts.net/llm');
  assert.equal(normalizeBaseUrl(null), '');
  assert.equal(normalizeBaseUrl(undefined), '');
});

// ---------- llm: chatJson ----------

test('edge llm: chatJson はフェンス付き・think 付きの応答を読む', async () => {
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch(['<think>…</think>```json\n{"name":"線"}\n```']) });
  assert.deepEqual(await llm.chatJson({ system: 's', user: 'u' }), { name: '線' });
});

test('edge llm: chatJson は壊れた JSON のあと言い直しを頼み、読めた応答を返す', async () => {
  const seen = [];
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch(['{"name": "途中で切れ', '{"name":"線"}'], seen) });
  assert.deepEqual(await llm.chatJson({ system: 's', user: 'u' }), { name: '線' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].messages.length, 4);
  assert.equal(seen[1].messages[2].role, 'assistant');
});

test('edge llm: chatJson は読めない応答が続くと LlmError（無限に呼ばない）', async () => {
  const seen = [];
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch(['ずっと説明文'], seen) });
  await assert.rejects(llm.chatJson({ system: 's', user: 'u' }), LlmError);
  assert.ok(seen.length <= 6);
});

test('edge llm: chatJson は null やただの数・文字列の応答を、指定の形の JSON として返さない', async () => {
  const seen = [];
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch(['null', '42', '{"name":"線"}'], seen) });
  assert.deepEqual(await llm.chatJson({ system: 's', user: 'u' }), { name: '線' });
  assert.equal(seen.length, 3);
});

test('edge llm: chatJson は本文が空なら json_schema → json_object → none と緩める', async () => {
  const seen = [];
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch(['', '', '{"ok":true}'], seen) });
  assert.deepEqual(await llm.chatJson({ system: 's', user: 'u', schema: { type: 'object' } }), { ok: true });
  assert.equal(seen[0].response_format.type, 'json_schema');
  assert.equal(seen[1].response_format.type, 'json_object');
  assert.equal(seen[2].response_format, undefined);
});

test('edge llm: chatJson は choices の無い応答でも落ちず、最後は LlmError', async () => {
  const fetchImpl = async () => Response.json({});
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl });
  await assert.rejects(llm.chatJson({ system: 's', user: 'u' }), LlmError);
});

test('edge llm: 400 で reasoning を拒まれたら reasoning_effort を外して送り直す', async () => {
  const seen = [];
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch([new Response('unknown field reasoning_effort', { status: 400 }), '{"a":1}'], seen) });
  assert.deepEqual(await llm.chatJson({ system: 's', user: 'u' }), { a: 1 });
  assert.equal(seen[0].reasoning_effort, 'none');
  assert.equal(seen[1].reasoning_effort, undefined);
});

test('edge llm: 500 や 404 は送り直さず LlmError（status と本文を持つ）', async () => {
  for (const status of [500, 404]) {
    const seen = [];
    const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: chatFetch([new Response('boom', { status })], seen) });
    const e = await llm.chatJson({ system: 's', user: 'u' }).catch((x) => x);
    assert.ok(e instanceof LlmError);
    assert.equal(e.status, status);
    assert.equal(e.body, 'boom');
    assert.equal(seen.length, 1);
  }
});

test('edge llm: 応答が JSON でなければ LlmError', async () => {
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: async () => new Response('<html>proxy error</html>', { status: 200 }) });
  await assert.rejects(llm.listModels(), LlmError);
});

test('edge llm: 接続できないと LlmError、中止済みの signal なら送らない', async () => {
  let sent = 0;
  const llm = createLlmClient({
    baseUrl: 'http://llm',
    chatModel: 'm',
    fetchImpl: async () => {
      sent++;
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(llm.chatJson({ system: 's', user: 'u' }), (e) => e instanceof LlmError && /接続できません/.test(e.message));
  const ctrl = new AbortController();
  ctrl.abort();
  sent = 0;
  await assert.rejects(llm.chatJson({ system: 's', user: 'u', signal: ctrl.signal }), (e) => e instanceof LlmError && /中止/.test(e.message));
  assert.equal(sent, 0);
});

test('edge llm: タイムアウトで LlmError', async () => {
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl, timeoutMs: 20 });
  await assert.rejects(llm.chatJson({ system: 's', user: 'u' }), (e) => e instanceof LlmError && /timeout/.test(e.message));
});

test('edge llm: 応答の本文が届かないままでもタイムアウトする（ヘッダだけ返して止まるサーバ）', async () => {
  const fetchImpl = async (url, { signal }) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  });
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl, timeoutMs: 20 });
  const result = await Promise.race([llm.listModels().then(() => 'ok', (e) => e), new Promise((r) => setTimeout(() => r('hung'), 500))]);
  assert.ok(result instanceof LlmError, `結果: ${result}`);
});

test('edge llm: 本文を受け取っている途中の中止にも応える', async () => {
  const ctrl = new AbortController();
  const fetchImpl = async (url, { signal }) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  });
  const llm = createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl });
  setTimeout(() => ctrl.abort(), 10);
  const result = await Promise.race([llm.chatJson({ system: 's', user: 'u', signal: ctrl.signal }).then(() => 'ok', (e) => e), new Promise((r) => setTimeout(() => r('hung'), 500))]);
  assert.ok(result instanceof LlmError && /中止/.test(result.message), `結果: ${result}`);
});

test('edge llm: embed は 0 件で呼ばず、件数が合わなければ LlmError、index 順に並べる', async () => {
  let calls = 0;
  const mk = (data) =>
    createLlmClient({
      baseUrl: 'http://llm',
      chatModel: 'm',
      embedModel: 'e',
      fetchImpl: async () => {
        calls++;
        return Response.json({ data });
      },
    });
  assert.deepEqual(await mk([]).embed([]), []);
  assert.equal(calls, 0);
  await assert.rejects(mk([{ index: 0, embedding: [1, 0] }]).embed(['a', 'b']), LlmError);
  const out = await mk([{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }]).embed(['a', 'b']);
  assert.deepEqual([...out[0]], [1, 0]);
  assert.deepEqual([...out[1]], [0, 1]);
  await assert.rejects(createLlmClient({ baseUrl: 'http://llm', chatModel: 'm', fetchImpl: async () => Response.json({}) }).embed(['a']), LlmError);
});

test('edge llm: embed は batchSize ごとに送り、進み具合を知らせる', async () => {
  const sizes = [];
  const progress = [];
  const llm = createLlmClient({
    baseUrl: 'http://llm',
    chatModel: 'm',
    embedModel: 'e',
    fetchImpl: async (url, init) => {
      const { input } = JSON.parse(init.body);
      sizes.push(input.length);
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, index] })) });
    },
  });
  const out = await llm.embed(['a', 'b', 'c', 'd', 'e'], { batchSize: 2, onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(out.length, 5);
  assert.deepEqual(sizes, [2, 2, 1]);
  assert.deepEqual(progress, [[2, 5], [4, 5], [5, 5]]);
});

// ---------- prompts ----------

test('edge prompts: 特殊文字・改行・絵文字・長い文を含む点でもプロンプトを作れる（改行は詰め、長さは切る）', () => {
  const p = { text: '"引用"\n\n{json}\t`code` 😀'.repeat(50), label: '『本』"<script>"'.repeat(5), note: 'メモ\nです', userNote: '自分\n\nの', tags: ['a b', '#c', ...Array(10).fill('x')] };
  const line = pointLine(p, 0);
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith('[1]『'));
  assert.ok((line.match(/#/g) || []).length <= 8 + 1);
  const pr = linePrompt([p, { text: '短い', label: '' }]);
  assert.equal(pr.name, 'line');
  assert.ok(pr.user.includes('[2]'));
  assert.deepEqual(pr.schema.required, ['name', 'summary', 'insight', 'keywords']);
});

test('edge prompts: 思いつきの点は書名ではなく「読者自身の言葉」の見出し', () => {
  const s = pointLine({ text: '思ったこと', label: '思いつき', thought: true }, 4);
  assert.ok(s.startsWith('[5]（思いつき・読者自身の言葉）'));
});

test('edge prompts: planePrompt / solidPrompt / recommend 系は空の面・空の立体でも作れる', () => {
  assert.ok(planePrompt([]).user.includes('面'));
  assert.ok(planePrompt([{ name: 'a', summary: 's' }], { more: 3 }).user.includes('3 本'));
  const solid = solidPrompt([]);
  assert.deepEqual(solid.schema.properties.relations.items.properties.from.enum, []);
  const lines = Array.from({ length: 15 }, (_, i) => ({ name: `線${i}` }));
  assert.ok(solidPrompt([{ name: 'p', summary: 's', lines }]).user.includes('ほか 3 本'));
  const rec = recommendPrompt({ solid: null, planes: [], readTitles: [] });
  assert.ok(rec.user.includes('核: (なし)'));
  assert.ok(rec.user.includes('まだ答えが無い問い: (なし)'));
  assert.ok(searchPrompt({ solid: undefined, planes: [] }).user.includes('(なし)'));
  assert.ok(pickPrompt({ solid: {}, planes: [], candidates: [] }).user.includes('候補'));
});

test('edge prompts: preferenceLines は空・未指定で空文字、20 冊までに切る', () => {
  assert.equal(preferenceLines(), '');
  assert.equal(preferenceLines({ want: [], no: [] }), '');
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `本${i}` }));
  const s = preferenceLines({ want: many });
  assert.ok(s.includes('本19') && !s.includes('本20'));
});

test('edge prompts: recommendPrompt は既読 60 冊までに切り、避ける本を載せる', () => {
  const readTitles = Array.from({ length: 70 }, (_, i) => `既読${i}`);
  const s = recommendPrompt({ solid: { core: 'c', questions: ['q'] }, planes: [{ name: 'p', summary: 's' }], readTitles, avoid: ['避ける本'] }).user;
  assert.ok(s.includes('既読59') && !s.includes('既読60'));
  assert.ok(s.includes('避ける本'));
});

// ---------- changes ----------

test('edge changes: 前回が無い・線が無いと null、同じ分析どうしは変化なし', () => {
  assert.equal(diffAnalyses(null, { lines: [] }), null);
  assert.equal(diffAnalyses({}, { lines: [] }), null);
  const a = { createdAt: 't', lines: [{ id: 'l1', name: 'A', highlightIds: ['h1', 'h2'] }] };
  const d = diffAnalyses(a, a);
  assert.equal(hasChanges(d), false);
  assert.equal(hasChanges(null), false);
});

test('edge changes: 消えた線・増えた線・新しくつながった点を数え、入力を書き換えない', () => {
  const prev = { createdAt: 't0', lines: [{ id: 'l1', name: 'A', highlightIds: ['h1', 'h2'] }, { id: 'l2', name: 'B' }] };
  const next = { lines: [{ id: 'l1', name: 'A', highlightIds: ['h1', 'h2', 'h3'] }, { id: 'l3', name: 'C', highlightIds: ['h4', 'h1'] }] };
  const snap = JSON.stringify([prev, next]);
  const d = diffAnalyses(prev, next);
  assert.deepEqual(d.addedLines, [{ id: 'l3', name: 'C', size: 2 }]);
  assert.deepEqual(d.grownLines, [{ id: 'l1', name: 'A', added: 1 }]);
  assert.deepEqual(d.removedLines, [{ id: 'l2', name: 'B', size: 0 }]);
  assert.deepEqual(d.connectedPoints, [{ pointId: 'h3', lineId: 'l1' }, { pointId: 'h4', lineId: 'l3' }]);
  assert.equal(JSON.stringify([prev, next]), snap);
  assert.equal(hasChanges(d), true);
});

test('edge changes: 今回の線が無い（next.lines 無し）ときは前回の線がすべて消えた扱い', () => {
  const d = diffAnalyses({ lines: [{ id: 'l1', name: 'A', highlightIds: ['h'] }] }, {});
  assert.deepEqual(d.removedLines, [{ id: 'l1', name: 'A', size: 1 }]);
  assert.equal(d.previousAt, '');
});

// ---------- discoveries ----------

test('edge discoveries: 前回も今回も空なら発見なし、前回の線・isolated が無くても落ちない', () => {
  assert.deepEqual(findDiscoveries({ previous: {}, lines: [], sourceOf: (x) => x, vectorOf: () => undefined, now: 't' }), []);
});

test('edge discoveries: 1 冊だけでできた新しい線は発見にしない、別の本があれば line の発見', () => {
  const sourceOf = (id) => id[0];
  const base = { previous: { lines: [] }, sourceOf, vectorOf: () => undefined, now: 't' };
  assert.deepEqual(findDiscoveries({ ...base, lines: [{ id: 'l', name: 'L', highlightIds: ['a1', 'a2'] }] }), []);
  const [d] = findDiscoveries({ ...base, lines: [{ id: 'l', name: 'L', summary: 'S', highlightIds: ['a1', 'a2', 'b1'] }] });
  assert.equal(d.kind, 'line');
  assert.deepEqual(d.pointIds, ['a1', 'b1']);
  assert.equal(d.reason, 'S');
  assert.ok(isDiscovery(d));
});

test('edge discoveries: 前回 isolated だった点が線に入ると isolated、ベクトルでいちばん近い相手を選ぶ', () => {
  const vecs = { p: axis(0), q: axis(1), r: near(0, 0.1) };
  const ds = findDiscoveries({
    previous: { lines: [{ id: 'l', highlightIds: ['q', 'r'] }], isolated: ['p'] },
    lines: [{ id: 'l', name: 'L', highlightIds: ['q', 'r', 'p'] }],
    sourceOf: (id) => id,
    vectorOf: (id) => vecs[id],
    now: 't',
  });
  assert.equal(ds.length, 1);
  assert.equal(ds[0].kind, 'isolated');
  assert.deepEqual(ds[0].pointIds, ['p', 'r']);
});

test('edge discoveries: 伸ばしただけの点（formerIdsOf）は新しくつながった点にしない', () => {
  const ds = findDiscoveries({
    previous: { lines: [{ id: 'l', highlightIds: ['old', 'x'] }] },
    lines: [{ id: 'l', name: 'L', highlightIds: ['new', 'x'] }],
    sourceOf: (id) => id,
    vectorOf: () => undefined,
    formerIdsOf: (id) => (id === 'new' ? ['old'] : []),
    now: 't',
  });
  assert.deepEqual(ds, []);
});

test('edge discoveries: 1 回の発見は上限まで、同じ 2 点は 1 つに', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const ds = findDiscoveries({
    previous: { lines: [{ id: 'l', highlightIds: ['base'] }] },
    lines: [{ id: 'l', name: 'L', highlightIds: ['base', ...ids] }],
    sourceOf: (id) => id,
    vectorOf: () => undefined,
    now: 't',
  });
  assert.ok(ds.length <= DISCOVERIES_PER_ANALYSIS);
  const keys = ds.map((d) => [...d.pointIds].sort().join('|'));
  assert.equal(new Set(keys).size, keys.length);
});

test('edge discoveries: discoveryId は点の順に依らない', () => {
  assert.equal(discoveryId('cross', 'l', ['a', 'b']), discoveryId('cross', 'l', ['b', 'a']));
  assert.notEqual(discoveryId('cross', 'l', ['a', 'b']), discoveryId('line', 'l', ['a', 'b']));
});

test('edge discoveries: mergeDiscoveries は壊れた発見・重複・消えた点を外し、上限で切る。入力は書き換えない', () => {
  const d = (id, p = ['a', 'b']) => ({ id, pointIds: p });
  const prev = [d('1'), null, { id: 2 }, d('3', ['a']), d('4', ['a', 'gone']), ...Array.from({ length: 80 }, (_, i) => d(`x${i}`))];
  const snap = JSON.stringify(prev);
  const out = mergeDiscoveries([d('1'), d('new')], prev, (id) => id !== 'gone');
  assert.equal(out[0].id, '1');
  assert.equal(out[1].id, 'new');
  assert.ok(!out.some((x) => x.id === '4' || x.id === '3'));
  assert.equal(out.length, DISCOVERIES_KEEP);
  assert.equal(JSON.stringify(prev), snap);
  assert.deepEqual(mergeDiscoveries([], 'not an array'), []);
});

// ---------- shape ----------

test('edge shape: 壊れた分析を拒み、最小の正しい形を受け入れる', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  const ok = { createdAt: '2026-10-01T00:00:00.000Z', lines: [], planes: [], solid: {} };
  assert.equal(analysisShapeError(ok, now), '');
  assert.ok(isAnalysisShape(ok, now));
  for (const bad of [null, [], 'x', 1, { ...ok, createdAt: 'yesterday' }, { ...ok, createdAt: '2030-01-01T00:00:00Z' }, { ...ok, lines: [{ id: 'l' }] }, { ...ok, lines: [null] }, { ...ok, planes: {} }, { ...ok, solid: [] }, { ...ok, version: 1.5 }, { ...ok, isolated: [1] }, { ...ok, discoveries: [{ id: 'd', pointIds: ['a'] }] }, { ...ok, lines: [{ id: 'x'.repeat(81), highlightIds: [] }] }]) {
    assert.notEqual(analysisShapeError(bad, now), '', JSON.stringify(bad));
  }
  assert.equal(isAnalysisTime('2026-10-04T23:59:59Z', now), true);
  assert.equal(isAnalysisTime('2026-02-30T00:00:00Z', now), true === Number.isFinite(Date.parse('2026-02-30T00:00:00Z')));
  assert.equal(isAnalysisTime(12345, now), false);
});

// ---------- incremental ----------

test('edge incremental: 点が 0 件なら線も isolated も空', () => {
  assert.deepEqual(carryLines({ ids: [], vectors: [], previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }], targetSize: 4, maxSize: 10, maxGroups: 10 }), { lines: [], isolated: [] });
  assert.deepEqual(carryLines({ ids: [], vectors: [], targetSize: 4, maxSize: 10, maxGroups: 10 }), { lines: [], isolated: [] });
});

test('edge incremental: 前回の線の点が消えて 2 点未満になった線はほどき、残った点は isolated に', () => {
  const ids = ['a', 'c'];
  const vectors = [axis(0), axis(1)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }, { id: 'l2', highlightIds: ['c', 'd'] }], targetSize: 4, maxSize: 10, maxGroups: 10 });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.isolated, [0, 1]);
});

test('edge incremental: 同じ点が前回の 2 本の線にあっても、1 本にだけ入る', () => {
  const ids = ['a', 'b', 'c'];
  const vectors = [axis(0), near(0, 0.1), near(0, 0.2)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }, { id: 'l2', highlightIds: ['b', 'c', 'a'] }], targetSize: 4, maxSize: 10, maxGroups: 10 });
  const all = [...r.lines.flatMap((l) => l.members), ...r.isolated].sort();
  assert.deepEqual(all, [0, 1, 2]);
  assert.equal(r.lines[0].id, 'l1');
});

test('edge incremental: 何も増えていなければ線を新しく作らない', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const vectors = [axis(0), near(0, 0.1), axis(2), near(2, 0.1)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }], previousIsolated: ['c', 'd'], targetSize: 2, maxSize: 10, maxGroups: 10 });
  assert.deepEqual(r.lines, [{ id: 'l1', members: [0, 1] }]);
  assert.deepEqual(r.isolated, [2, 3]);
});

test('edge incremental: まったく似ていない新しい点（近さ 0 以下）は既存の線に加えない', () => {
  const ids = ['a', 'b', 'x'];
  const vectors = [axis(0), axis(0), axis(1)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }], targetSize: 4, maxSize: 10, maxGroups: 10 });
  assert.deepEqual(r.lines[0].members, [0, 1]);
  assert.deepEqual(r.isolated, [2]);
});

test('edge incremental: 上限（maxSize）に達した線には加えない', () => {
  const ids = ['a', 'b', 'x'];
  const vectors = [axis(0), near(0, 0.05), near(0, 0.02)];
  const r = carryLines({ ids, vectors, previousLines: [{ id: 'l1', highlightIds: ['a', 'b'] }], targetSize: 4, maxSize: 2, maxGroups: 10 });
  assert.deepEqual(r.lines[0].members, [0, 1]);
  assert.deepEqual(r.isolated, [2]);
});

test('edge incremental: 前回の線が無ければ groupPoints と同じく全員がちょうど 1 回出る、入力は書き換えない', () => {
  const texts = SAMPLE_BOOKS.flatMap((b) => b.highlights.map((h) => h.text));
  const vectors = tfidfEmbed(texts);
  const ids = texts.map((_, i) => `h${i}`);
  const snap = vectors.map((v) => [...v]);
  const r = carryLines({ ids, vectors, targetSize: 5, maxSize: 13, maxGroups: 60 });
  assert.deepEqual([...r.lines.flatMap((l) => l.members), ...r.isolated].sort((a, b) => a - b), [...ids.keys()]);
  assert.ok(r.lines.every((l) => l.id === null));
  assert.deepEqual(vectors.map((v) => [...v]), snap);
  assert.deepEqual(carryLines({ ids, vectors, targetSize: 5, maxSize: 13, maxGroups: 60 }), r);
});

test('edge incremental: carryPlanes は線が 0 本で空、前回の面の線がすべて消えたら新しく束ねる', () => {
  assert.deepEqual(carryPlanes({ lineIds: [], vectors: [], previousPlanes: [{ id: 'p1', lineIds: ['l1'] }], maxPlanes: 4 }), []);
  const r = carryPlanes({ lineIds: ['a', 'b', 'c'], vectors: [axis(0), axis(1), axis(2)], previousPlanes: [{ id: 'p1', lineIds: ['gone'] }], maxPlanes: 4 });
  assert.ok(r.every((p) => p.id === null));
  assert.deepEqual(r.flatMap((p) => p.members).sort(), [0, 1, 2]);
});

test('edge incremental: carryPlanes は新しい線を近い面に加え、線 1 本の面はまとめ、面の ID を保つ', () => {
  const lineIds = ['a', 'b', 'c', 'd', 'new'];
  const vectors = [axis(0), near(0, 0.1), axis(2), near(2, 0.1), near(2, 0.2)];
  const r = carryPlanes({ lineIds, vectors, previousPlanes: [{ id: 'p1', lineIds: ['a', 'b'] }, { id: 'p2', lineIds: ['c', 'd'] }], maxPlanes: 4 });
  assert.deepEqual(r, [{ id: 'p1', members: [0, 1] }, { id: 'p2', members: [2, 3, 4] }]);
  const lone = carryPlanes({ lineIds: ['a', 'b', 'c'], vectors: [axis(0), near(0, 0.1), axis(2)], previousPlanes: [{ id: 'p1', lineIds: ['a', 'b'] }, { id: 'p2', lineIds: ['c', 'gone'] }], maxPlanes: 4 });
  assert.equal(lone.length, 1);
  assert.deepEqual(lone[0].members.sort(), [0, 1, 2]);
});

// ---------- recommend ----------

test('edge recommend: matchVolume は空の書名・記号だけの書名で一致させない', () => {
  assert.equal(matchVolume([{ title: '' }], { title: '' }), null);
  assert.equal(matchVolume([{ title: '！！' }], { title: '？？' }), null);
  assert.equal(matchVolume([], { title: 'x' }), null);
  assert.deepEqual(matchVolume([{ title: '注意の科学', authors: '山田 太郎', description: 'd' }], { title: '注意の科学', author: '山田太郎' }), { title: '注意の科学', authors: '山田 太郎' });
  assert.equal(matchVolume([{ title: '注意の科学', authors: '佐藤' }], { title: '注意の科学', author: '山田' }), null);
});

test('edge recommend: parseNdlRss / parseCinii は空・壊れた入力で空配列', () => {
  assert.deepEqual(parseNdlRss(''), []);
  assert.deepEqual(parseNdlRss(undefined), []);
  assert.deepEqual(parseNdlRss('<item><dc:title>A &amp; B</dc:title><category>雑誌</category></item>'), []);
  assert.equal(parseNdlRss('<item><dc:title>A &amp; B</dc:title></item>')[0].title, 'A & B');
  assert.deepEqual(parseCinii(null), []);
  assert.deepEqual(parseCinii({ '@graph': [{ items: 'x' }] }), []);
  assert.deepEqual(parseCinii({ '@graph': [{ items: [{ title: '' }, {}] }] }), []);
});

test('edge recommend: verifyBooks は 0 冊で空、通信できなければ verified を付けない、入力を書き換えない', async () => {
  assert.deepEqual(await verifyBooks([], { fetchImpl: async () => Response.json({}) }), []);
  const recs = [{ title: '本', author: '人' }];
  const out = await verifyBooks(recs, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(out, [{ title: '本', author: '人' }]);
  assert.ok(!('verified' in recs[0]));
});

test('edge recommend: searchBooks は空の検索語でも落ちない（どこも見つからなければ空）', async () => {
  const fetchImpl = async (url) => (String(url).includes('ndl') ? new Response('<rss></rss>') : new Response('', { status: 503 }));
  assert.deepEqual(await searchBooks('', { fetchImpl }), []);
  assert.deepEqual(await searchBooks('   ', { fetchImpl }), []);
});

// ---------- pipeline ----------

test('edge pipeline: 点が 4 件未満なら分かりやすいエラー（AI を呼ばない）', async () => {
  const llm = stubLlm();
  await assert.rejects(analyzeLibrary({ library: emptyLibrary(), llm }), /0 件/);
  await assert.rejects(analyzeLibrary({ library: libraryOf(['ひとつだけ']), llm }), /1 件/);
  assert.equal(llm.calls.length, 0);
});

test('edge pipeline: LLM が指定と違う形（空の配列）を返しても分析は落ちず、既定の名前を使う', async () => {
  const lib = sampleLibrary();
  const llm = stubLlm({ line: () => [], plane: () => [], solid: () => [] });
  const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
  assert.ok(analysis.lines.length > 0);
  assert.ok(analysis.lines.every((l) => /^線 \d+/.test(l.name)));
  assert.ok(analysis.planes.every((p) => /^面 \d+/.test(p.name)));
  assert.equal(analysis.solid.title, '知識の核');
});

test('edge pipeline: LLM の出力の型が違っても（配列・数・余分なキー・null の要素）落ちない', async () => {
  const lib = sampleLibrary();
  const llm = stubLlm({
    line: () => ({ name: 123, summary: ['配列'], insight: null, keywords: 'not-array', extra: 'x' }),
    plane: () => [{ name: '配列で返った' }],
    solid: () => ({ title: { t: 1 }, core: 42, relations: [null, 'P1→P2', { from: 'P1', to: 'P1', type: '支える' }, { from: 'P1', to: 'P99' }], principles: 'not-array', questions: [null, { text: '問いか？' }, 7] }),
  });
  const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
  assert.ok(analysis.lines.every((l) => typeof l.name === 'string' && Array.isArray(l.keywords) && l.keywords.length === 0));
  assert.ok(analysis.planes.every((p) => typeof p.name === 'string' && p.name.length > 0));
  assert.deepEqual(analysis.solid.relations, []);
  assert.deepEqual(analysis.solid.principles, []);
  assert.ok(analysis.solid.questions.includes('問いか？'));
  assert.ok(isAnalysisShape(analysis));
});

test('edge pipeline: 同じ名前の線には番号を付け、線の ID は重ならない', async () => {
  const lib = sampleLibrary();
  const llm = stubLlm({ line: () => ({ name: '同じ名前', summary: 's', insight: 'i', keywords: [] }), plane: () => ({ name: '同じ面', summary: 's' }) });
  const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
  const names = analysis.lines.map((l) => l.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(analysis.lines.map((l) => l.id)).size, analysis.lines.length);
  assert.equal(new Set(analysis.planes.map((p) => p.name)).size, analysis.planes.length);
});

test('edge pipeline: 同じ入力の分析は同じ線・面になり（決定的）、ライブラリを書き換えない', async () => {
  const lib = sampleLibrary();
  const snap = JSON.stringify(lib);
  const a = (await analyzeLibrary({ library: lib, llm: stubLlm(), options: { recommend: false } })).analysis;
  const b = (await analyzeLibrary({ library: lib, llm: stubLlm(), options: { recommend: false } })).analysis;
  assert.deepEqual(a.lines.map((l) => [l.id, l.highlightIds]), b.lines.map((l) => [l.id, l.highlightIds]));
  assert.deepEqual(a.planes.map((p) => p.lineIds), b.planes.map((p) => p.lineIds));
  assert.equal(JSON.stringify(lib), snap);
});

test('edge pipeline: 前回の分析を書き換えず、点が消えた線はなくなり、消えた点は結果に残らない', async () => {
  const lib = sampleLibrary();
  const cache = emptyCache();
  const first = (await analyzeLibrary({ library: lib, llm: stubLlm(), cache, options: { recommend: false } })).analysis;
  const snap = JSON.stringify(first);
  const line = first.lines[0];
  for (const id of line.highlightIds) lib.highlights[id].deleted = true;
  const second = (await analyzeLibrary({ library: lib, llm: stubLlm(), cache, previous: first, options: { recommend: false } })).analysis;
  assert.equal(JSON.stringify(first), snap);
  const live = new Set(second.lines.flatMap((l) => l.highlightIds).concat(second.isolated));
  for (const id of line.highlightIds) assert.ok(!live.has(id));
  assert.ok(!second.lines.some((l) => l.id === line.id));
  assert.ok(second.changes.removedLines.some((l) => l.id === line.id));
  assert.ok(second.discoveries.every((d) => d.pointIds.every((id) => !lib.highlights[id]?.deleted)));
});

test('edge pipeline: 形の壊れた前回の結果は無視して最初から作る', async () => {
  const lib = sampleLibrary();
  const { analysis } = await analyzeLibrary({ library: lib, llm: stubLlm(), previous: { lines: 'broken' }, options: { recommend: false } });
  assert.equal(analysis.incremental, false);
  assert.equal(analysis.changes, undefined);
});

test('edge pipeline: 中止済みの signal なら AI を呼ばずに中止のエラー', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const llm = stubLlm();
  await assert.rejects(analyzeLibrary({ library: sampleLibrary(), llm, signal: ctrl.signal }), /中止/);
  assert.equal(llm.calls.length, 0);
});

test('edge pipeline: LLM のエラーは分析のエラーとして伝わる（おすすめのエラーは分析を捨てない）', async () => {
  const boom = stubLlm({
    line: () => {
      throw new LlmError('LLM 落ちた');
    },
  });
  await assert.rejects(analyzeLibrary({ library: sampleLibrary(), llm: boom, options: { recommend: false } }), /LLM 落ちた/);
  const recBoom = stubLlm({
    recommendations: () => {
      throw new LlmError('おすすめ失敗');
    },
  });
  const { analysis } = await analyzeLibrary({ library: sampleLibrary(), llm: recBoom, options: { verify: false } });
  assert.deepEqual(analysis.recommendations, []);
  assert.match(analysis.recommendationNote, /おすすめ失敗/);
});

test('edge pipeline: おすすめの LLM 出力が壊れていても（null の要素・型違い）recommendBooks は落ちない', async () => {
  const { analysis } = await analyzeLibrary({ library: sampleLibrary(), llm: stubLlm(), options: { recommend: false } });
  const llm = stubLlm({ recommendations: () => ({ books: [null, 'str', { title: 7 }, { title: '' }] }) });
  const recs = await recommendBooks({ library: sampleLibrary(), analysis, llm, verify: false });
  assert.deepEqual(recs.map((r) => r.title), ['7']);
  // 書誌 DB を使う版: 検索語・選んだ本に null が混ざっても落ちない
  const vol = (id, title) => ({ id, volumeInfo: { title, authors: ['著者'] } });
  const fetchImpl = async () => Response.json({ items: [vol('a', '候補の本その一'), vol('b', '候補の本その二')] });
  const llm2 = stubLlm({ searches: () => ({ searches: [null, 3, { query: '習慣' }] }), picks: () => ({ picks: [null, 'x', { candidate: 1, reason: '理由' }] }) });
  const recs2 = await recommendBooks({ library: emptyLibrary(), analysis, llm: llm2, fetchImpl });
  assert.equal(recs2.length, 1);
  assert.equal(recs2[0].title, '候補の本その一');
});

test('edge pipeline: unicode・絵文字だけの点でも分析できる', async () => {
  const lib = libraryOf(['😀😀 喜びの記録 😀', '😀 喜びの記録をつける', 'Ünïcödé テキスト ①②③', 'Ünïcödé テキストの扱い', '​ ゼロ幅 ​ 空白の扱い', 'ゼロ幅の文字と空白']);
  const { analysis } = await analyzeLibrary({ library: lib, llm: stubLlm(), options: { recommend: false } });
  assert.ok(isAnalysisShape(analysis));
  assert.equal(analysis.stats.points, 6);
});

test('edge pipeline: lineSample は max より少なければ全部、お気に入りを優先し、順を保つ', () => {
  assert.deepEqual(lineSample([], () => false), []);
  assert.deepEqual(lineSample([3, 1, 2], () => false), [3, 1, 2]);
  assert.deepEqual(lineSample([5, 4, 3, 2, 1], (i) => i === 1, 2), [5, 1]);
  assert.deepEqual(lineSample([5, 4, 3], () => true, 2), [5, 4]);
});

test('edge pipeline: recommendationNote は空・すべて未確認・確認済みありで言い分ける', () => {
  assert.match(recommendationNote([]), /選べませんでした/);
  assert.match(recommendationNote([{ verified: false }]), /見つかりませんでした/);
  assert.equal(recommendationNote([{ verified: false }, { verified: { title: 'x' } }]), '');
  assert.equal(recommendationNote([{}]), '');
});

test('edge pipeline: キャッシュの保存と読み戻しで、ベクトルが変わらない（空・壊れた値でも落ちない）', () => {
  assert.deepEqual(deserializeCache(null), emptyCache());
  assert.deepEqual(deserializeCache({}), emptyCache());
  const cache = emptyCache();
  cache.embeddings.model = 'm';
  cache.embeddings.vectors.h1 = Float32Array.from([0.5, -1, 3.25]);
  cache.embeddings.vectors.h2 = new Float32Array(0);
  cache.llm['line:x'] = { name: 'A' };
  const back = deserializeCache(JSON.parse(JSON.stringify(serializeCache(cache))));
  assert.deepEqual([...back.embeddings.vectors.h1], [0.5, -1, 3.25]);
  assert.deepEqual([...back.embeddings.vectors.h2], []);
  assert.deepEqual(back.llm, { 'line:x': { name: 'A' } });
  const broken = deserializeCache({ embeddings: { model: 'm', vectors: {}, keys: [] }, llm: 'x' });
  assert.deepEqual(broken.embeddings.keys, {});
  assert.deepEqual(broken.llm, {});
});

test('edge pipeline: キャッシュのベクトルの一部が壊れていても（base64 でない・型違い）読み戻しで落ちず、その点だけ捨てる', () => {
  const ok = serializeCache({ embeddings: { model: 'm', vectors: { h1: Float32Array.from([1, 2]) }, keys: {} }, llm: {} });
  const data = { ...ok, embeddings: { ...ok.embeddings, vectors: { ...ok.embeddings.vectors, h2: '%%%not-base64%%%', h3: 42, h4: null, h5: 'AAA=' } } };
  const back = deserializeCache(data);
  assert.deepEqual([...back.embeddings.vectors.h1], [1, 2]);
  assert.ok(!('h2' in back.embeddings.vectors));
  assert.ok(!('h3' in back.embeddings.vectors));
  assert.ok(!('h4' in back.embeddings.vectors));
  assert.ok(!('h5' in back.embeddings.vectors), '4 バイトの倍数でない');
});

test('edge pipeline: 埋め込みモデルありでも分析でき、2 回目は埋め込みを呼ばない', async () => {
  const lib = sampleLibrary();
  const cache = emptyCache();
  let embeds = 0;
  const llm = stubLlm({}, { embedModel: 'e' });
  const raw = llm.embed;
  llm.embed = async (texts, o) => (embeds++, raw(texts, o));
  const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
  const n = embeds;
  await analyzeLibrary({ library: lib, llm, cache, previous: first, options: { recommend: false } });
  assert.ok(n > 0);
  assert.equal(embeds, n);
});

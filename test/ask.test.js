// G8 知識と対話する: 意味で探す（点・メモ・永久ノートを意味の近い順に）・問いかける（関連する点を最大 8 件集め、ローカル LLM が点を根拠に答える）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { addThought, thoughtsOf, updateThought } from '../web/core/thoughts.js';
import { addNote, deleteNote } from '../web/core/notes.js';
import { analysisPoints } from '../web/core/points.js';
import {
  ASK_MAX_POINTS,
  QUESTION_MAX,
  answerMemoText,
  askContext,
  askLibrary,
  askPrompt,
  cleanQuery,
  createSemanticIndex,
  placeText,
  rankByVector,
  readAnswer,
  searchTargets,
  semanticSearch,
} from '../web/core/ask.js';
import { tfidfEmbed } from '../web/core/analysis/vectors.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { hash } from '../web/core/text.js';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { startFakeLlm } from './helpers/fake-llm.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const T = '2026-10-05T09:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}
const byText = (lib, start) => Object.values(lib.highlights).find((h) => h.text.startsWith(start));

// G8-5 のあらかじめ決めた 10 問と、上位 5 件に入ってほしい点（その点の文の書き出し）。
// 点の文をそのまま聞かず、言い換えて聞く（文字 n-gram は言葉の重なりで近さを測るので、言葉は一部だけ重ねる）
const QUESTIONS = [
  ['良い習慣を定着させるコツは', '良い習慣は、始めるのにかかる手間を二分以内に'],
  ['集中する力は鍛えられるのか', '集中は筋肉のように鍛えられる'],
  ['記憶を強くする勉強のしかた', '読んだだけでは覚えていない'],
  ['他人の評価が気になってしまう', '他人の評価は自分の力の外にある'],
  ['信頼される人になるには', '信頼は、小さな約束を守る'],
  ['新しいアイデアはどこから生まれるのか', 'アイデアは無から生まれるのではなく'],
  ['やらないことの決め方', 'すべてをやろうとすると'],
  ['文章がうまく書けないときは', '文章が書けないのは'],
  ['通知に気を取られず仕事をしたい', '通知を切り'],
  ['感謝を伝えるとどうなるか', '感謝を言葉にすると'],
];

test('G8-5: 探す力の確認。サンプルデータと文字 n-gram で、決めた 10 問のうち 8 問以上で期待する点が上位 5 件に入る', () => {
  const lib = sampleLibrary();
  const items = searchTargets(lib);
  const results = QUESTIONS.map(([q, start]) => {
    const want = byText(lib, start);
    assert.ok(want, `期待する点がサンプルにある（${start}）`);
    // 文字 n-gram の TF-IDF は、探す相手と質問を一緒に数える（どの言葉がありふれているかを相手から決める）
    const [qv, ...vs] = tfidfEmbed([q, ...items.map((it) => it.text)]);
    const vectorOf = new Map(items.map((it, i) => [it.id, vs[i]]));
    const top = rankByVector(qv, items, (it) => vectorOf.get(it.id), 5);
    return { q, ok: top.some((r) => r.id === want.id) };
  });
  const ok = results.filter((r) => r.ok).length;
  assert.ok(ok >= 8, `上位 5 件に入ったのは ${ok}/10（外れ: ${results.filter((r) => !r.ok).map((r) => r.q).join(' / ')}）`);
});

test('G8-1: 意味で探す相手は分析の点（技術書・捨てたメモ・消した点を除く）と永久ノート。近い順（同じ近さは ID の順）', () => {
  const lib = sampleLibrary();
  const [tech] = Object.values(lib.books);
  lib.books[tech.id] = { ...tech, technical: true };
  const gone = Object.values(lib.highlights).find((h) => h.bookId !== tech.id);
  updateHighlight(lib, gone.id, { deleted: true });
  addThought(lib, { text: '残すメモ' }, T, 'tkeep1');
  addThought(lib, { text: '捨てるメモ' }, T, 'tdrop1');
  updateThought(lib, 'tdrop1', { status: 'discarded' }, T);
  addNote(lib, { title: 'ノートの題', body: '本文' }, T, 'nkeep1');
  addNote(lib, { title: '消すノート', body: '' }, T, 'ndrop1');
  deleteNote(lib, 'ndrop1', T);
  const items = searchTargets(lib);
  const ids = new Set(items.map((it) => it.id));
  assert.ok(ids.has('tkeep1') && ids.has('nkeep1'));
  assert.ok(!ids.has('tdrop1') && !ids.has('ndrop1') && !ids.has(gone.id));
  assert.ok(items.every((it) => lib.highlights[it.id]?.bookId !== tech.id), '技術書の点は入れない');
  assert.equal(items.find((it) => it.id === 'nkeep1').text, 'ノートの題\n本文');
  assert.equal(items.filter((it) => it.kind === 'point').length, analysisPoints(lib).length);
  // 近い順。同じ近さは ID の順。ベクトルの無い相手は飛ばす
  const v = (x, y) => Float32Array.from([x, y]);
  const vec = { hb: v(1, 0), ha: v(1, 0), hc: v(0.6, 0.8), nd: v(0, 1) };
  const ranked = rankByVector(v(1, 0), ['hc', 'hb', 'nd', 'ha', 'hz'].map((id) => ({ id, kind: id[0] === 'n' ? 'note' : 'point' })), (it) => vec[it.id], 3);
  assert.deepEqual(ranked.map((r) => r.id), ['ha', 'hb', 'hc']);
  assert.equal(ranked[2].score, Math.fround(0.6));
});

test('G8-1: 点のベクトルは分析のキャッシュを使い、無いもの・文が変わったものと永久ノートだけを埋め込む（今の点・ノートに無いものは捨てる）', async () => {
  const lib = sampleLibrary();
  addNote(lib, { title: '自分の考え', body: '' }, T, 'nidx1');
  const items = searchTargets(lib);
  const points = items.filter((it) => it.kind === 'point');
  const asked = [];
  const embed = async (texts) => {
    asked.push(...texts);
    return texts.map((t) => Float32Array.from([t.length, 1]));
  };
  const index = createSemanticIndex({ embed, model: 'm1' });
  // 分析のキャッシュ: 1 件目は文が変わった（ハッシュが違う）、ほかは同じ文
  const cache = { model: 'm1', vectors: {}, keys: {} };
  points.forEach((it, i) => {
    cache.vectors[it.id] = Float32Array.from([0, 1]);
    cache.keys[it.id] = i === 0 ? 'stale' : hash(it.text);
  });
  assert.equal(index.seed(cache, items), points.length - 1);
  assert.equal(index.seed({ ...cache, model: 'other' }, items), 0, '別のモデルで埋め込んだものは使わない');
  const vectorOf = await index.vectorsFor(items);
  assert.deepEqual(asked.sort(), [points[0].text, '自分の考え'].sort(), '文が変わった点とノートだけを埋め込む');
  assert.ok(items.every((it) => vectorOf(it)));
  // 2 回目は埋め込まない
  await index.vectorsFor(items);
  assert.equal(asked.length, 2);
  // 使わなくなったベクトル（消したノート）は、たまってから捨てる（同時に来た問い合わせの分まで消さないように）
  deleteNote(lib, 'nidx1', T);
  await index.vectorsFor(searchTargets(lib));
  assert.equal(index.size, points.length + 1, '1 件ではまだ捨てない');
  for (let i = 0; i < 150; i++) addNote(lib, { title: `一時のノート ${i}` }, T, `ntmp${i}x`);
  await index.vectorsFor(searchTargets(lib));
  for (let i = 0; i < 150; i++) deleteNote(lib, `ntmp${i}x`, T);
  await index.vectorsFor(searchTargets(lib));
  assert.equal(index.size, points.length, 'たまったら、今の点・ノートに無いものを捨てる');
  // 埋め込んでいないものが多すぎれば（分析していない・モデルを変えた直後）、全部を埋め込まずに先に分析するよう断る
  const fresh = createSemanticIndex({ embed, model: 'm2' });
  const embeddedSoFar = asked.length;
  await assert.rejects(fresh.vectorsFor(items, { maxNew: 10 }), (e) => e.code === 'needs-analysis' && /まだ埋め込んでいない点が \d+ 件.*分析してください/.test(e.message));
  assert.equal(asked.length, embeddedSoFar, '断るときは埋め込まない');
});

test('G8-2・G8-3: 問いかけは近い点だけを根拠にする。いちばん近い点でも近さが足りなければ答えない。依頼文には番号・書名・位置、答えは渡した番号だけを根拠にする', () => {
  const r = (id, score, kind = 'point') => ({ id, kind, score });
  // いちばん近い点が足りなければ空（AI を呼ばない）
  assert.deepEqual(askContext([r('h1', 0.57), r('h2', 0.56)]), []);
  assert.deepEqual(askContext([r('n1', 0.9, 'note'), r('h1', 0.5)]), [], 'ノートは根拠にしない');
  // 足りれば、根拠に入れる近さ以上の点を最大 8 件
  const many = Array.from({ length: 12 }, (_, i) => r(`h${i}`, 0.9 - i * 0.03));
  const ctx = askContext(many);
  assert.equal(ctx.length, ASK_MAX_POINTS);
  assert.deepEqual(askContext([r('h1', 0.6), r('h2', 0.49)]).map((x) => x.id), ['h1'], '近さの足りない点は根拠に入れない');
  assert.deepEqual(askContext([r('h1', 0.2)], { minSimilarity: 0.1, contextSimilarity: 0.1 }).map((x) => x.id), ['h1']);
  // 依頼文
  const p = askPrompt('習慣を続けるには', [
    { text: '習慣は 小さく\n始める', note: '朝に試す', book: '小さな習慣の力', place: '位置 12' },
    { text: 'メモの文', note: '', book: '思いつき', place: '' },
  ]);
  assert.equal(p.name, 'answer');
  assert.match(p.user, /^質問: 習慣を続けるには/);
  assert.match(p.user, /\[1\] 習慣は 小さく 始める（読者のメモ: 朝に試す）（小さな習慣の力・位置 12）/);
  assert.match(p.user, /\[2\] メモの文（思いつき）/);
  assert.match(p.system, /渡された点.*だけを根拠/);
  assert.deepEqual(p.schema.required, ['answerable', 'answer', 'used']);
  // 答えの読み取り: 渡した番号だけ（文中の [n] も拾う）・空の答えや answerable:false は答えない
  assert.deepEqual(readAnswer({ answerable: true, answer: '続けるには小さく始める [2]。[9] は無い', used: [1, 1, 7, 'x'] }, 3), { answerable: true, answer: '続けるには小さく始める [2]。[9] は無い', used: [1, 2] });
  assert.equal(readAnswer({ answerable: false, answer: 'それらしい答え', used: [1] }, 3).answerable, false);
  assert.equal(readAnswer({ answerable: true, answer: '  ', used: [1] }, 3).answerable, false);
  assert.equal(readAnswer(null, 3).answerable, false);
  assert.equal(readAnswer({ answer: 'あ'.repeat(5000) }, 1).answer.length, 1200);
  // 質問は 1 行・長さを切る。位置
  assert.equal(cleanQuery('  習慣を\n続けるには  '), '習慣を 続けるには');
  assert.equal(cleanQuery('あ'.repeat(QUESTION_MAX + 50)).length, QUESTION_MAX);
  assert.equal(cleanQuery(42), '');
  assert.deepEqual([placeText({ location: 120 }), placeText({ page: 37 }), placeText({})], ['位置 120', 'p.37', '']);
});

test('G8-1〜G8-4: 偽の LLM で、意味で探す（点と永久ノート）→ 問いかける（根拠の点つきの答え）→ 関係ない質問は AI を呼ばずに答えない → 答えをメモにすると次の分析で点になる', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    addNote(lib, { title: '習慣は仕組みで続ける', body: '意志に頼らず、環境と手間を変える。' }, T, 'nhabit1');
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const index = createSemanticIndex({ embed: llm.embed, model: llm.embedModel });
    // 意味で探す: 点と永久ノートが近い順に出る
    const found = await semanticSearch({ library: lib, query: '習慣を仕組みで続けるには', index });
    assert.ok(found.length > 10);
    assert.equal(found[0].id, 'nhabit1', '題の言葉がいちばん重なるノート');
    assert.ok(found.some((r) => r.kind === 'point'));
    assert.ok(found.every((r, i) => i === 0 || found[i - 1].score >= r.score));
    assert.deepEqual(await semanticSearch({ library: lib, query: '   ', index }), []);
    // 問いかける（偽の埋め込みは近さの尺度が違うので、しきい値を合わせる）
    const loose = { minSimilarity: 0.2, contextSimilarity: 0.2 };
    const chatBefore = fake.calls.chat;
    const habit = byText(lib, '良い習慣は、始めるのに');
    const a = await askLibrary({ library: lib, question: '良い習慣は始めるのにかかる手間を減らすと定着するのか', index, chatJson: llm.chatJson, ...loose });
    assert.equal(fake.calls.chat, chatBefore + 1);
    assert.equal(a.answerable, true);
    assert.equal(a.answer, '小さく始めると続きます [1]。');
    assert.deepEqual(a.citations.map((c) => c.n), [1]);
    assert.equal(a.citations[0].id, habit.id, '1 番はいちばん近い点');
    assert.equal(a.cited, true);
    const sent = fake.calls.bodies.at(-1).messages[1].content;
    assert.match(sent, /^質問: 良い習慣は始めるのにかかる手間を減らすと定着するのか/);
    assert.match(sent, /\[1\] 良い習慣は、始めるのにかかる手間を二分以内にすることで定着しやすくなる。（小さな習慣の力/);
    assert.ok((sent.match(/^\[\d+\] /gm) || []).length <= ASK_MAX_POINTS, '点は最大 8 件');
    // 関係ない質問: AI を呼ばずに答えない
    const none = await askLibrary({ library: lib, question: '量子コンピュータの誤り訂正', index, chatJson: llm.chatJson, ...loose });
    assert.deepEqual(none, { question: '量子コンピュータの誤り訂正', answerable: false, answer: '', citations: [] });
    assert.equal(fake.calls.chat, chatBefore + 1, 'AI に答えを作らせない');
    // 答えをメモにする（G1 のメモ。根拠の書名と位置を添える）→ 次の分析で点になる
    const text = answerMemoText(lib, a);
    assert.match(text, /^小さく始めると続きます \[1\]。\n\n根拠: \[1\] 小さな習慣の力・位置 \d+$/);
    const memo = addThought(lib, { text, answerTo: { kind: 'ask', question: a.question } }, T, 'task1');
    assert.deepEqual(thoughtsOf(lib).task1.answerTo, { kind: 'ask', question: a.question });
    assert.ok(analysisPoints(lib).some((p) => p.id === memo.id));
    const { analysis } = await analyzeLibrary({ library: lib, llm, cache: emptyCache(), options: { recommend: false } });
    assert.ok([...analysis.lines.flatMap((l) => l.highlightIds), ...analysis.isolated].includes('task1'), '次の分析で点になる');
    // 保存した答えは探せる（点）が、次の問いかけの根拠にはしない（AI が書いた文を自分の考えとして根拠に出さない）
    assert.ok((await semanticSearch({ library: lib, query: text, index })).some((r) => r.id === 'task1'));
    await askLibrary({ library: lib, question: text, index, chatJson: llm.chatJson, ...loose });
    const pointsSent = fake.calls.bodies.at(-1).messages[1].content.split('\n\n点:\n')[1];
    assert.ok(pointsSent && !pointsSent.includes('小さく始めると続きます'), '同じ文で聞いても、保存した答えは根拠の点に入らない');
  } finally {
    await fake.close();
  }
});

test('G8-2: AI が根拠の番号を示さなかったときは、渡した点をすべて並べ、根拠ではないと分かるよう印を付ける', async () => {
  const fake = await startFakeLlm({ ask: () => ({ answerable: true, answer: '番号の無い答え', used: [] }) });
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const index = createSemanticIndex({ embed: llm.embed, model: llm.embedModel });
    const r = await askLibrary({ library: lib, question: byText(lib, '良い習慣は、始めるのに').text, index, chatJson: llm.chatJson });
    assert.deepEqual([r.answerable, r.cited], [true, false]);
    assert.ok(r.citations.length >= 1 && r.citations.every((c, i) => c.n === i + 1));
  } finally {
    await fake.close();
  }
});

/** PC のサーバ（bh serve）を一時フォルダのデータと偽の LLM で立てる */
async function withServer(fn, { llm = {}, library = sampleLibrary(), fakeOptions = {} } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-ask-'));
  const fake = await startFakeLlm(fakeOptions);
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed', ...llm } });
  await store.saveLibrary(library);
  // 書誌 DB には実際に接続しない
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response(JSON.stringify({ items: [] })) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, fake, library });
  } finally {
    server.close();
    await fake.close();
  }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('G8-1: PC の「意味で探す」（POST /api/search）は点と永久ノートの ID と近さだけを返し、分析のキャッシュのベクトルを使う（埋め込むのは探す言葉とノートだけ）', async () => {
  const library = sampleLibrary();
  addNote(library, { title: '習慣は仕組みで続ける', body: '' }, T, 'nsrv1');
  await withServer(
    async ({ base, store, fake }) => {
      // 先に分析して、点のベクトルをキャッシュに残す（bh analyze と同じ）
      const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
      const cache = emptyCache();
      await analyzeLibrary({ library, llm, cache, options: { recommend: false } });
      await store.saveCache(cache);
      const before = fake.calls.embedInputs.length;
      const res = await post(base, '/api/search', { q: '習慣を仕組みで続けるには' });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.model, 'fake-embed');
      assert.equal(body.results[0].id, 'nsrv1');
      assert.ok(body.results.some((r) => r.kind === 'point'));
      assert.ok(body.results.every((r) => Object.keys(r).sort().join() === 'id,kind,score'), '本文は返さない');
      assert.deepEqual(fake.calls.embedInputs.slice(before).sort(), ['習慣は仕組みで続ける', '習慣を仕組みで続けるには'].sort(), '点は埋め込み直さない');
      // 2 回目はノートも埋め込まない（探す言葉だけ）
      await post(base, '/api/search', { q: '集中' });
      assert.deepEqual(fake.calls.embedInputs.slice(before + 2), ['集中']);
      // 空の言葉・壊れた本文
      assert.equal((await post(base, '/api/search', { q: '  ' })).status, 400);
      assert.equal((await post(base, '/api/search', '{')).status, 400);
    },
    { library },
  );
});

test('G8-1: PC に埋め込みモデルが無いときは、意味で探す・問いかけるは理由つきで断る（画面は言葉の一致の検索に戻る）。LLM につながらないときも理由を返す', async () => {
  await withServer(
    async ({ base, fake }) => {
      for (const [p, body] of [
        ['/api/search', { q: '習慣' }],
        ['/api/ask', { question: '習慣を続けるには' }],
      ]) {
        const res = await post(base, p, body);
        assert.equal(res.status, 409);
        const j = await res.json();
        assert.equal(j.code, 'no-embed-model');
        assert.match(j.error, /埋め込みモデル.*bh config embed bge-m3/);
      }
      assert.equal(fake.calls.embed + fake.calls.chat, 0);
    },
    { llm: { embedModel: '' } },
  );
  await withServer(
    async ({ base }) => {
      const res = await post(base, '/api/search', { q: '習慣' });
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /意味で探せませんでした（LLM サーバに接続できません/);
    },
    { llm: { baseUrl: 'http://127.0.0.1:9' } },
  );
  // まだ分析していない（点のベクトルがキャッシュに無い）点が多いときは、全部を埋め込まずに先に分析するよう断る
  const many = sampleLibrary();
  for (let i = 0; i < 160; i++) addThought(many, { text: `思いつき ${i} 番目の考え` }, T, `tmany${i}x`);
  await withServer(
    async ({ base, fake }) => {
      for (const [p, body] of [
        ['/api/search', { q: '習慣' }],
        ['/api/ask', { question: '習慣を続けるには' }],
      ]) {
        const res = await post(base, p, body);
        assert.equal(res.status, 409);
        const j = await res.json();
        assert.equal(j.code, 'needs-analysis');
        assert.match(j.error, /先に知識の画面で分析してください/);
      }
      assert.equal(fake.calls.embed, 0);
    },
    { library: many },
  );
});

test('G8-2・G8-3: PC の「問いかける」（POST /api/ask）は根拠の点つきで答え、関係する点が無ければ AI を呼ばずに答えない。AI が答えられないと言ったときも答えない', async () => {
  await withServer(async ({ base, fake, library }) => {
    // 点の文そのままの質問はいちばん近い点に当たる（偽の埋め込みでも近さが既定のしきい値を超える）
    const habit = byText(library, '良い習慣は、始めるのに');
    const res = await post(base, '/api/ask', { question: habit.text });
    assert.equal(res.status, 200);
    const a = await res.json();
    assert.equal(a.answerable, true);
    assert.equal(a.answer, '小さく始めると続きます [1]。');
    assert.deepEqual(a.citations, [{ n: 1, id: habit.id }]);
    assert.equal(fake.calls.chat, 1);
    // 関係ない質問
    const no = await (await post(base, '/api/ask', { question: '量子コンピュータの誤り訂正の仕組みは' })).json();
    assert.deepEqual(no, { question: '量子コンピュータの誤り訂正の仕組みは', answerable: false, answer: '', citations: [] });
    assert.equal(fake.calls.chat, 1, 'AI に答えを作らせない');
    assert.equal((await post(base, '/api/ask', { question: '' })).status, 400);
  });
  await withServer(
    async ({ base, fake, library }) => {
      const r = await (await post(base, '/api/ask', { question: byText(library, '良い習慣は、始めるのに').text })).json();
      assert.equal(fake.calls.chat, 1);
      assert.deepEqual([r.answerable, r.answer, r.citations], [false, '', []]);
    },
    { fakeOptions: { ask: () => ({ answerable: false, answer: '点には書かれていません', used: [] }) } },
  );
});

/** 画面の確かめ用の状態（PC から配信された画面。埋め込みモデルあり） */
const uiState = (library, extra = {}) => ({
  library,
  analysis: null,
  loaded: true,
  servedByCompanion: true,
  pcInfo: { llm: { chatModel: 'qwen2.5:7b', embedModel: 'bge-m3' } },
  settings: { ai: { mode: 'companion', companionUrl: '' } },
  ...extra,
});

test('G8-1: 意味で探す・問いかけるが使えるかの判定と、使えないときの説明（言葉の一致の検索に戻る）。結果は近い順に点と永久ノートを出す（消えたものは飛ばす）', async () => {
  const { semanticAvailability, unavailableNotice, meaningResults } = await import('../web/js/views/ask.js');
  const lib = sampleLibrary();
  assert.equal(semanticAvailability(uiState(lib)), 'ok');
  assert.equal(semanticAvailability(uiState(lib, { settings: { ai: { mode: 'direct', companionUrl: '' } } })), 'no-pc');
  assert.equal(semanticAvailability(uiState(lib, { servedByCompanion: false })), 'no-pc', 'PC の場所が分からない');
  assert.equal(semanticAvailability(uiState(lib, { servedByCompanion: false, settings: { ai: { mode: 'companion', companionUrl: 'https://pc.example.ts.net' } } })), 'ok');
  // 埋め込みモデルがあるかは PC が答える（画面が持つ PC の状態は古いことがあるので、それで押せなくしない）
  assert.equal(semanticAvailability(uiState(lib, { pcInfo: { llm: { chatModel: 'x', embedModel: '' } } })), 'ok');
  assert.equal(semanticAvailability(uiState(lib, { pcInfo: null })), 'ok');
  assert.match(String(unavailableNotice('no-embed')), /埋め込みモデルが設定されていない.*言葉の一致で探した結果を出します/);
  assert.match(String(unavailableNotice('no-pc')), /PC（bh serve）とつながっているとき/);
  assert.match(String(unavailableNotice('', 'PC に接続できません')), /意味で探せませんでした（PC に接続できません）。言葉の一致で/);
  // 結果: 近い順のまま、点はカード・永久ノートは行で。消えた点・無いノートは飛ばす
  addNote(lib, { title: '仕組みで続ける', body: '' }, T, 'nres1');
  const [h1, h2] = Object.values(lib.highlights);
  updateHighlight(lib, h2.id, { deleted: true });
  const out = String(meaningResults(uiState(lib), [
    { id: 'nres1', kind: 'note', score: 0.9 },
    { id: h2.id, kind: 'point', score: 0.8 },
    { id: h1.id, kind: 'point', score: 0.7 },
    { id: 'nnothing', kind: 'note', score: 0.6 },
  ]));
  assert.match(out, /意味の近い順に 2 件（PC の AI で探しました）/);
  assert.ok(out.indexOf('href="#/note/nres1"') < out.indexOf(`data-hl="${h1.id}"`), '近い順');
  assert.doesNotMatch(out, new RegExp(`data-hl="${h2.id}"`));
  assert.match(String(meaningResults(uiState(lib), [])), /見つかりませんでした/);
  // 技術書があれば、意味で探すには入らないことを添える
  const [b] = Object.values(lib.books);
  lib.books[b.id] = { ...b, technical: true };
  assert.match(String(meaningResults(uiState(lib), [])), /技術書の線は入りません。言葉で探すでは出ます/);
});

test('G8-1・G8-2: 検索の画面に「言葉で探す / 意味で探す」と「問いかける」、知識の画面に「問いかける」がある', async () => {
  const { search } = await import('../web/js/views/library.js');
  const { knowledge } = await import('../web/js/views/knowledge.js');
  const lib = sampleLibrary();
  const words = String(search.render({ state: uiState(lib), query: new URLSearchParams('q=習慣') }));
  assert.match(words, /<a class="chip on" data-mode="" href="#\/search\?q=%E7%BF%92%E6%85%A3" aria-current="true">言葉で探す<\/a><a class="chip " data-mode="meaning" href="#\/search\?q=%E7%BF%92%E6%85%A3&amp;mode=meaning" >意味で探す<\/a>/);
  assert.match(words, /<a class="btn small" id="search-ask" href="#\/ask\?q=%E7%BF%92%E6%85%A3">問いかける<\/a>/);
  const meaning = String(search.render({ state: uiState(lib), query: new URLSearchParams('q=習慣&mode=meaning') }));
  assert.match(meaning, /<a class="chip on" data-mode="meaning" href="#\/search\?q=%E7%BF%92%E6%85%A3&amp;mode=meaning" aria-current="true">意味で探す<\/a>/);
  assert.match(meaning, /placeholder="探したいこと/);
  assert.match(String(knowledge.render({ state: { ...uiState(lib), job: null } })), /<a class="btn small" href="#\/ask">問いかける<\/a>/);
});

test('G8-2・G8-3: 問いかける画面: 質問 → 待つ → 答え（根拠の点に番号・書名と位置。押すとその点へ）／答えられないとき／失敗したとき。使えないときはボタンを押せない。文はエスケープ', async () => {
  const { askView } = await import('../web/js/views/ask.js');
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  const view = (state, q = '') => String(askView.render({ state, query: new URLSearchParams(q ? { q } : {}) }));
  const empty = view(uiState(lib), '習慣を続けるには');
  assert.match(empty, /<form class="stack" data-form="ask">/);
  assert.match(empty, /<textarea name="question" rows="3" maxlength="300"[^>]*>習慣を続けるには<\/textarea>/, '検索の画面から質問を引き継ぐ');
  assert.match(empty, /<button class="btn primary" id="ask-submit" >問いかける<\/button>/);
  assert.match(empty, /<div id="ask-result"><\/div>/, '答えは答えの欄だけを差し替える');
  const noPc = view(uiState(lib, { settings: { ai: { mode: 'direct', companionUrl: '' } } }));
  assert.match(noPc, /PC（bh serve）とつながっているときに使えます/);
  assert.match(noPc, /<button class="btn primary" id="ask-submit" disabled>問いかける<\/button>/);
  assert.match(view(uiState(lib, { ask: { question: 'q', status: 'pending' } })), /PC の AI が、関係する点を集めて考えています/);
  assert.match(view(uiState(lib, { ask: { question: 'q', status: 'pending' } })), /<button class="btn primary" id="ask-submit" disabled>/, '待っている間は押せない');
  assert.match(view(uiState(lib, { ask: { question: '前の質問', status: 'pending' } })), />前の質問<\/textarea>/, 'URL に言葉が無ければ、前に聞いた質問');
  assert.match(view(uiState(lib, { ask: { question: 'q', status: 'error', error: '問いかけに答えられませんでした（LLM サーバに接続できません）' } })), /<p class="notice err" role="alert">問いかけに答えられませんでした/);
  const none = view(uiState(lib, { ask: { question: '量子', status: 'done', result: { question: '量子', answerable: false, answer: '', citations: [] } } }));
  assert.match(none, /手元の点からは答えられない質問でした/);
  assert.doesNotMatch(none, /data-action="ask-save"/);
  // 答え: 根拠の点（番号・点の文・書名と位置）。押すとその点へ。消えた点は「消えた」
  const done = { question: '<b>習慣</b>', status: 'done', result: { question: '<b>習慣</b>', answerable: true, answer: '小さく始める [1]。<img src=x onerror=alert(1)>', citations: [{ n: 1, id: habit.id }, { n: 2, id: 'hgone1' }] } };
  const page = view(uiState(lib, { ask: done }));
  assert.match(page, /<p class="answer-text">小さく始める \[1\]。&lt;img src=x onerror=alert\(1\)&gt;<\/p>/);
  assert.doesNotMatch(page, /<img|<b>/);
  assert.match(page, new RegExp(`<a class="link-target" href="#/point/${habit.id}"><span class="link-title">\\[1\\] 良い習慣は、始めるのに`));
  assert.match(page, new RegExp(`<span class="link-sub">小さな習慣の力・位置 ${habit.location}</span>`));
  assert.match(page, /\[2\] （この端末にまだ無い点。PC と同期すると出ます）/, 'PC で取り込んだ直後で、この端末に届いていない点');
  assert.match(page, /<h2>根拠の点<\/h2>/);
  assert.match(page, /問い: &lt;b&gt;習慣&lt;\/b&gt;/, '答えの上に問いを出す');
  assert.match(page, /<button type="button" class="btn small" data-action="ask-save">メモとして保存<\/button>/);
  assert.match(view(uiState(lib, { ask: { ...done, savedId: 'tsaved1' } })), /受け箱のメモに保存しました/);
  // 消した点は「消えた点」。AI が根拠の番号を示さなかったときは「AI に渡した点」と出す（根拠と取り違えない）
  updateHighlight(lib, habit.id, { deleted: true });
  const uncited = view(uiState(lib, { ask: { ...done, result: { ...done.result, cited: false } } }));
  assert.match(uncited, /\[1\] （消えた点）/);
  assert.match(uncited, /<h2>AI に渡した点（答えに根拠の番号がありませんでした）<\/h2>/);
  // 答えられなかったときは、その問いと「答えられない」を出す
  assert.match(view(uiState(lib, { ask: { question: '量子', status: 'done', result: { question: '量子', answerable: false, answer: '', citations: [] } } })), /「量子」: 手元の点からは答えられない/);
});

test('G8-2・G8-4: 問いかけの操作: 質問を送って答えを出す（空の質問・待っている間の連打・古い答えは使わない）。答えはメモとして 1 回だけ保存し、PC と同期する', async () => {
  const { askActions } = await import('../web/js/ask-actions.js');
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  const state = uiState(lib);
  const log = { asked: [], persisted: 0, synced: 0, rendered: 0, toasts: [] };
  let reply = { question: '習慣を続けるには', answerable: true, answer: '小さく始める [1]。', citations: [{ n: 1, id: habit.id }] };
  let release;
  const ops = askActions({
    state,
    ask: (q) => {
      log.asked.push(q);
      return new Promise((resolve, reject) => (release = () => (reply instanceof Error ? reject(reply) : resolve(reply))));
    },
    persist: async () => {
      log.persisted++;
    },
    sync: () => log.synced++,
    render: () => log.rendered++,
    toast: (m) => log.toasts.push(m),
  });
  await ops.submit('   ');
  assert.deepEqual([log.asked.length, log.toasts[0]], [0, '質問を入れてください']);
  const sent = ops.submit('  習慣を\n続けるには ');
  assert.equal(state.ask.status, 'pending');
  await ops.submit('別の質問');
  assert.deepEqual(log.asked, ['習慣を 続けるには'], '待っている間は送らない');
  release();
  await sent;
  assert.equal(state.ask.status, 'done');
  assert.equal(state.ask.result.answer, '小さく始める [1]。');
  assert.match(state.ask.memoId, /^t[0-9a-z]+$/);
  // 保存: 受け箱のメモ（G1）。答えと根拠を書き、どの問いへの答えかを残す。押し直しても 1 件
  await ops.save();
  await ops.save();
  const memo = thoughtsOf(lib)[state.ask.memoId];
  assert.equal(memo.status, 'inbox');
  assert.match(memo.text, /^小さく始める \[1\]。\n\n根拠: \[1\] 小さな習慣の力・位置/);
  assert.deepEqual(memo.answerTo, { kind: 'ask', question: '習慣を続けるには' });
  assert.equal(Object.values(thoughtsOf(lib)).filter((t) => t.answerTo?.kind === 'ask').length, 1);
  assert.deepEqual([log.persisted, log.synced, state.ask.savedId], [1, 1, state.ask.memoId]);
  assert.ok(analysisPoints(lib).some((p) => p.id === memo.id), '次の分析で点になる');
  // 失敗したとき・古い答え
  reply = new Error('PC に接続できません');
  const failed = ops.submit('もう一度');
  release();
  await failed;
  assert.deepEqual([state.ask.status, state.ask.error], ['error', 'PC に接続できません']);
  reply = { question: '古い', answerable: true, answer: '古い答え', citations: [] };
  const old = ops.submit('古い');
  state.ask = { question: '新しい', status: 'done', result: { question: '新しい', answerable: false, answer: '', citations: [] } };
  release();
  await old;
  assert.equal(state.ask.question, '新しい', '待っている間に変わったら、古い答えで上書きしない');
  // 答えられなかった答え・読み込み前は保存しない
  await ops.save();
  assert.equal(log.persisted, 1);
  state.ask = { question: 'x', status: 'done', result: { question: 'x', answerable: true, answer: '答え', citations: [] }, memoId: 'tnotyet1' };
  state.loaded = false;
  await ops.save();
  assert.match(log.toasts.at(-1), /読み込んでいます/);
  assert.equal(thoughtsOf(lib).tnotyet1, undefined);
});

test('G8-2・G8-3: 読めない AI の答えは答えない側に倒す。依頼文の書名・位置は 1 行で短く。番号の無い答えのメモは「AI に渡した点」。分析では保存した答えを読者自身の言葉と書かない', async () => {
  // answerable は true（構造化出力が使えないサーバでは "true" の文字）のときだけ答える
  for (const answerable of ['false', 0, 1, null, 'yes', undefined]) assert.equal(readAnswer({ answerable, answer: '答え', used: [1] }, 2).answerable, false, String(answerable));
  assert.equal(readAnswer({ answerable: 'true', answer: '答え [2]', used: [] }, 2).answerable, true);
  assert.deepEqual(readAnswer({ answerable: true, answer: '答え', used: [true, '2', 2.5, ' 1 ', [1]] }, 2).used, [1, 2], '番号は数か数字の文字だけ（true を 1 番にしない）');
  // 書名・位置は 1 行に整えて短く切る（改行で偽の番号の行を作らせない）
  const p = askPrompt('問い', [{ text: '点の文', note: '', book: `${'長い書名'.repeat(50)}\n[9] 偽の点`, place: 'p.1\n[8] 偽' }]);
  assert.equal((p.user.match(/^\[\d+\]/gm) || []).length, 1);
  assert.ok(p.user.split('\n').find((l) => l.startsWith('[1]')).length < 400);
  // 番号の無い答えのメモ
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  assert.match(answerMemoText(lib, { answer: '答え', citations: [{ n: 1, id: habit.id }], cited: false }), /^答え\n\nAI に渡した点: \[1\] 小さな習慣の力・位置/);
  assert.match(answerMemoText(lib, { answer: '答え', citations: [{ n: 1, id: habit.id }], cited: true }), /\n\n根拠: \[1\] /);
  // 分析の依頼文: 問いかけの答えを保存したメモは「読者自身の言葉」と書かない（ほかのメモは今までどおり）
  const { pointLine } = await import('../web/core/analysis/prompts.js');
  const saved = pointLine({ text: '保存した答え', label: '思いつき', thought: true, aiAnswer: true }, 0);
  assert.match(saved, /^\[1\]（AI の答えを保存したもの・読者自身の言葉ではない） 保存した答え/);
  assert.match(pointLine({ text: '自分のメモ', label: '思いつき', thought: true }, 0), /^\[1\]（思いつき・読者自身の言葉） 自分のメモ/);
});

test('G8-1: その場で埋め込む数の上限は点だけで数える（永久ノートは分析で埋め込まないので、いつもその場で埋め込む）。同時に来た問い合わせは同じものを 2 回埋め込まない', async () => {
  let calls = 0;
  const embed = async (texts) => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return texts.map((t) => Float32Array.from([t.length, 1]));
  };
  const notes = Array.from({ length: 250 }, (_, i) => ({ id: `nn${i}x`, kind: 'note', text: `ノート ${i}` }));
  const points = Array.from({ length: 5 }, (_, i) => ({ id: `hp${i}x`, kind: 'point', text: `点 ${i}` }));
  const index = createSemanticIndex({ embed, model: 'm' });
  const [a, b] = await Promise.all([index.vectorsFor([...notes, ...points], { maxNew: 10 }), index.vectorsFor([...notes, ...points], { maxNew: 10 })]);
  assert.equal(calls, 1, '先の問い合わせが埋め込んだものを、あとの問い合わせが使う');
  assert.ok(a(notes[0]) && b(points[4]));
  const many = Array.from({ length: 11 }, (_, i) => ({ id: `hq${i}x`, kind: 'point', text: `点 ${i}` }));
  await assert.rejects(createSemanticIndex({ embed, model: 'm' }).vectorsFor(many, { maxNew: 10 }), (e) => e.code === 'needs-analysis');
});

test('G8: PC は意味で探す・問いかけるを同時に 2 件まで受け（超えたら 429）、本文の大きさも絞る。問いかけでも、LLM につながらない・チャットモデルが無いときは理由を返す', async () => {
  await withServer(
    async ({ base }) => {
      const res = await Promise.all([1, 2, 3].map(() => post(base, '/api/search', { q: '習慣' })));
      assert.deepEqual(res.map((r) => r.status).sort(), [200, 200, 429]);
      const busy = await res.find((r) => r.status === 429).json();
      assert.equal(busy.code, 'busy');
      assert.match(busy.error, /ほかの問い合わせに答えています/);
      assert.equal((await post(base, '/api/search', { q: 'あ'.repeat(70000) })).status, 413);
    },
    { fakeOptions: { embedDelayMs: 300 } },
  );
  await withServer(
    async ({ base }) => {
      const r = await post(base, '/api/ask', { question: '習慣' });
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /問いかけに答えられませんでした（LLM サーバに接続できません/);
    },
    { llm: { baseUrl: 'http://127.0.0.1:9' } },
  );
  await withServer(
    async ({ base, fake }) => {
      const r = await post(base, '/api/ask', { question: '習慣' });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, 'no-chat-model');
      assert.equal(fake.calls.embed, 0);
    },
    { llm: { chatModel: '' } },
  );
});

/** 検索の画面の mount に渡す偽の画面（欄ごとの中身を残す） */
function fakeSearchRoot(q) {
  const boxes = {};
  const box = (sel) =>
    (boxes[sel] ||= {
      innerHTML: '',
      isConnected: true,
      insertAdjacentHTML(_where, s) {
        this.innerHTML = s + this.innerHTML;
      },
      setAttribute() {},
    });
  const root = {
    querySelector: (sel) => (sel === 'input[name="q"]' ? { value: q, addEventListener() {}, isConnected: true } : box(sel)),
    querySelectorAll: () => [],
  };
  return { root, boxes };
}

test('G8-1: 検索の画面の「意味で探す」: PC とつながっていない・PC が断った・失敗したときは理由を出して言葉の一致に戻る。結果は近い順。古い結果・離れた画面には書かない。描き直しでは直前の結果を使う', async () => {
  const { search } = await import('../web/js/views/library.js');
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  // PC への問い合わせは偽物で受ける（本物の PC には送らない）
  const realFetch = globalThis.fetch;
  const asked = [];
  let reply = () => new Response('{}', { status: 500 });
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), body: init?.body });
    return reply();
  };
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const run = async (q, state) => {
    const { root, boxes } = fakeSearchRoot(q);
    search.mount(root, { state, query: new URLSearchParams({ q, mode: 'meaning' }) });
    await flush();
    return boxes;
  };
  // PC への問い合わせだけを数える（言葉の一致の検索は、欲しい本の一覧も読みに行く）
  const toPc = () => asked.filter((a) => /\/api\/search$/.test(a.url));
  try {
    // PC とつながっていない → PC に聞かずに、理由と言葉の一致の結果
    const noPc = await run('集中', uiState(lib, { servedByCompanion: false }));
    assert.equal(toPc().length, 0);
    assert.match(noPc['#search-results'].innerHTML, /PC（bh serve）とつながっているときに使えます[^<]*言葉の一致で探した結果を出します[\s\S]*<mark>集中<\/mark>/);
    // PC に埋め込みモデルが無い（409）→ 理由と言葉の一致
    reply = () => new Response(JSON.stringify({ error: '埋め込みモデルが無い', code: 'no-embed-model' }), { status: 409 });
    const noEmbed = await run('習慣', uiState(lib));
    assert.equal(toPc().length, 1);
    assert.deepEqual(JSON.parse(toPc().at(-1).body), { q: '習慣' });
    assert.match(noEmbed['#search-results'].innerHTML, /埋め込みモデルが設定されていない[\s\S]*<mark>習慣<\/mark>/);
    // ほかの失敗（PC が落ちているなど）→ その理由と言葉の一致
    reply = () => {
      throw new TypeError('fetch failed');
    };
    const down = await run('仕組み', uiState(lib));
    assert.match(down['#search-results'].innerHTML, /意味で探せませんでした（PC（[^）]*）に接続できません/);
    // 成功 → 近い順。絞り込みは言葉で探すときだけ
    reply = () => new Response(JSON.stringify({ model: 'bge-m3', results: [{ id: habit.id, kind: 'point', score: 0.9 }] }), { status: 200 });
    const ok = await run('定着のコツ', uiState(lib));
    assert.match(ok['#search-results'].innerHTML, new RegExp(`意味の近い順に 1 件[\\s\\S]*data-hl="${habit.id}"`));
    assert.equal(ok['#search-filters'].innerHTML, '');
    // 同じ言葉の描き直し（メモの保存・同期のあと）は PC に聞き直さず、直前の結果を出す
    const before = toPc().length;
    const again = await run('定着のコツ', uiState(lib));
    assert.equal(toPc().length, before);
    assert.match(again['#search-results'].innerHTML, new RegExp(`data-hl="${habit.id}"`));
    // 待っている間に描き直した（別の言葉で探し始めた）ら、古い結果は書かない
    let release;
    reply = () => new Promise((resolve) => (release = () => resolve(new Response(JSON.stringify({ results: [{ id: habit.id, kind: 'point', score: 0.9 }] }), { status: 200 }))));
    const stale = fakeSearchRoot('古い言葉');
    search.mount(stale.root, { state: uiState(lib), query: new URLSearchParams({ q: '古い言葉', mode: 'meaning' }) });
    await flush();
    await run('', uiState(lib));
    release();
    await flush();
    assert.match(stale.boxes['#search-results'].innerHTML, /探しています/, '古い結果で上書きしない');
    // 画面を移った（欄が外れた）あとに届いた結果も書かない
    const gone = fakeSearchRoot('移った言葉');
    search.mount(gone.root, { state: uiState(lib), query: new URLSearchParams({ q: '移った言葉', mode: 'meaning' }) });
    await flush();
    gone.boxes['#search-results'].isConnected = false;
    release();
    await flush();
    assert.match(gone.boxes['#search-results'].innerHTML, /探しています/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

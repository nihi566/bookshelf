// G2 自分の言葉を AI に渡す（自分のメモ・タグ・お気に入り）と、G1-4 思いつきを分析の点にする
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed, updateHighlight } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { embedText } from '../web/core/points.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, deserializeCache, emptyCache, lineSample, serializeCache } from '../web/core/analysis/pipeline.js';
import { l2normalize } from '../web/core/analysis/vectors.js';
import { startFakeLlm } from './helpers/fake-llm.js';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

const linePrompts = (fake, from = 0) => fake.calls.bodies.slice(from).filter((b) => b.response_format?.json_schema?.name === 'line').map((b) => b.messages[1].content);

test('G2-1 / G2-3: 自分のメモ・タグが埋め込みと線の AI への入力に入り（読者自身の言葉）、書き換えた点だけ埋め込み直す', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    const first = (await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } })).analysis;
    // 取り込んだメモ（note）が付いた点のうち、線に入ったものを選ぶ
    const inLine = new Set(first.lines.flatMap((l) => l.highlightIds));
    const target = Object.values(lib.highlights).find((h) => h.note && inLine.has(h.id));
    assert.ok(target, '取り込んだメモ付きの点が線に入っている');
    updateHighlight(lib, target.id, { userNote: '自分の言葉で書いた受け取り方', tags: ['実験', '仕事'] });

    const embedFrom = fake.calls.embedInputs.length;
    const chatFrom = fake.calls.bodies.length;
    const restored = deserializeCache(JSON.parse(JSON.stringify(serializeCache(cache))));
    await analyzeLibrary({ library: lib, llm, cache: restored, options: { recommend: false } });

    // 埋め込み直したのは書き換えた点だけ（線の説明文の埋め込みは除く）
    const reembedded = fake.calls.embedInputs.slice(embedFrom).filter((t) => !t.startsWith('概念'));
    assert.deepEqual(reembedded, [embedText(lib.highlights[target.id])]);
    assert.match(reembedded[0], /自分の言葉で書いた受け取り方/);
    assert.match(reembedded[0], /#実験 #仕事/);

    // その点を含む線は AI に作り直させ、入力では取り込んだメモと分けて「読者自身の言葉」と示す
    const prompt = linePrompts(fake, chatFrom).find((p) => p.includes(target.text.slice(0, 20)));
    assert.ok(prompt, 'その点を含む線を作り直した');
    assert.match(prompt, /（取り込んだメモ: [^）]+）（読者自身の言葉: メモ: 自分の言葉で書いた受け取り方 ／ タグ: #実験 #仕事）/);
  } finally {
    await fake.close();
  }
});

test('G2-3: 前の版のキャッシュ（文のハッシュが無い）でも、書き換えていない点は埋め込み直さない', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const cache = emptyCache();
    await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
    const legacy = serializeCache(cache);
    delete legacy.embeddings.keys;
    const from = fake.calls.embedInputs.length;
    await analyzeLibrary({ library: lib, llm, cache: deserializeCache(legacy), options: { recommend: false } });
    assert.deepEqual(fake.calls.embedInputs.slice(from).filter((t) => !t.startsWith('概念')), []);
  } finally {
    await fake.close();
  }
});

test('G2-2: 線を作る AI への入力（中心に近い最大 12 件）には、その線のお気に入りの点が優先して入る', async () => {
  // 並び（中心に近い順）のうち、お気に入り（15・18）を必ず入れ、残りを近い順に足して 12 件
  const picked = lineSample([...Array(20).keys()], (i) => i === 15 || i === 18);
  assert.equal(picked.length, 12);
  assert.ok(picked.includes(15) && picked.includes(18));
  assert.deepEqual(picked, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 18], '並びは中心に近い順のまま');
  assert.deepEqual(lineSample([0, 1, 2], () => false), [0, 1, 2]);

  // 分析全体でも: 1 本の線に 20 点が一列に並ぶ（中心は真ん中）。中心から遠い「その18」は、★を付けたときだけ入力に入る
  const texts = Array.from({ length: 20 }, (_, i) => `似た考え その${i + 1}`);
  const order = new Map(texts.map((t, i) => [t, i]));
  const vecFor = (t) => {
    const i = order.get(t.split('\n')[0]);
    if (i === undefined) return l2normalize(Float32Array.from([0, 0, 1, 0]));
    return l2normalize(Float32Array.from([1, i * 0.01, 0, 0]));
  };
  const linePromptOf = async (favorite) => {
    const lib = emptyLibrary();
    mergeParsed(lib, [{ title: '一冊', source: 'kindle', highlights: texts.map((text, i) => ({ text, location: i * 10 })) }]);
    if (favorite) updateHighlight(lib, Object.values(lib.highlights).find((h) => h.text === favorite).id, { favorite: true });
    const prompts = [];
    const llm = {
      chatModel: 'stub',
      embedModel: 'stub-embed',
      embed: async (xs) => xs.map(vecFor),
      chatJson: async (p) => {
        prompts.push(p);
        return p.name === 'line' ? { name: '線', summary: '要約', insight: '問い', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '要約' } : { title: '核', core: '核', relations: [], principles: [], questions: [] };
      },
    };
    await analyzeLibrary({ library: lib, llm, options: { recommend: false, granularity: 20 } });
    return prompts.find((p) => p.name === 'line').user;
  };
  const plain = await linePromptOf(null);
  assert.equal((plain.match(/^\[\d+\]/gm) || []).length, 12);
  assert.doesNotMatch(plain, /似た考え その18\n/, '★が無ければ中心から遠い点は入らない');
  const withFav = await linePromptOf('似た考え その18');
  assert.equal((withFav.match(/^\[\d+\]/gm) || []).length, 12);
  assert.match(withFav, /似た考え その18\n/, 'お気に入りの点が優先して入る');
});

test('G2-2: 前の分析のあとで★を付けると、同じキャッシュでも次の分析でその線を作り直し、★の点を見せる', async () => {
  const texts = Array.from({ length: 20 }, (_, i) => `似た考え その${i + 1}`);
  const order = new Map(texts.map((t, i) => [t, i]));
  const vecFor = (t) => (order.has(t.split('\n')[0]) ? l2normalize(Float32Array.from([1, order.get(t.split('\n')[0]) * 0.01, 0, 0])) : l2normalize(Float32Array.from([0, 0, 1, 0])));
  const lib = emptyLibrary();
  mergeParsed(lib, [{ title: '一冊', source: 'kindle', highlights: texts.map((text, i) => ({ text, location: i * 10 })) }]);
  const prompts = [];
  const llm = {
    chatModel: 'stub',
    embedModel: 'stub-embed',
    embed: async (xs) => xs.map(vecFor),
    chatJson: async (p) => {
      prompts.push(p);
      return p.name === 'line' ? { name: '線', summary: '要約', insight: '問い', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '要約' } : { title: '核', core: '核', relations: [], principles: [], questions: [] };
    },
  };
  const cache = emptyCache();
  await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false, granularity: 20 } });
  updateHighlight(lib, Object.values(lib.highlights).find((h) => h.text === '似た考え その18').id, { favorite: true });
  const from = prompts.length;
  await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false, granularity: 20 } });
  const line = prompts.slice(from).find((p) => p.name === 'line');
  assert.ok(line, '★を付けた線を作り直した');
  assert.match(line.user, /似た考え その18\n/);
});

test('G1-4: 思いつきも点として線に入り、AI への入力では書名の代わりに「思いつき」と示す（本の点と同じ線に入りうる）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    const t = addThought(lib, { text: '注意は最も希少な資源だ。何に注意を向けるかで人生が決まると散歩中に思った。' });
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
    assert.equal(analysis.stats.points, 49);
    assert.equal(analysis.stats.thoughts, 1);
    const line = analysis.lines.find((l) => l.highlightIds.includes(t.id));
    assert.ok(line, '思いつきが線に入る');
    assert.ok(line.highlightIds.some((id) => id.startsWith('h')), '本の点と同じ線に入る');
    assert.ok(line.bookIds.length > 0 && line.bookIds.every(Boolean), '本の ID に空が混ざらない');
    const prompt = linePrompts(fake).find((p) => p.includes('散歩中に思った'));
    assert.match(prompt, /\[\d+\]（思いつき・読者自身の言葉） 注意は最も希少な資源だ/);
    assert.doesNotMatch(prompt, /『思いつき』/, '書名のように見せない');
  } finally {
    await fake.close();
  }
});

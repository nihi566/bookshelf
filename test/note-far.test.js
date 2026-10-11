// NIH-229 永久ノートも、遠いつながり・意味の近い点の候補に入れる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { addNote, addNotePoint } from '../web/core/notes.js';
import { addLink } from '../web/core/links.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { FAR_MAX_PAIRS, FAR_NOTE_SLOTS, farCandidates, farId, isFarConnection, mergeFarConnections } from '../web/core/analysis/far.js';
import { NEIGHBORS_MAX } from '../web/core/analysis/neighbors.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { l2normalize, tfidfEmbed, tfidfEmbedAgainst } from '../web/core/analysis/vectors.js';
import { farLinksFor, normalizeFarReaction, reactFar } from '../web/core/far-reactions.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const T = '2026-10-04T12:00:00.000Z';
const T2 = '2026-10-05T12:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

/** 自分の言葉で書いた永久ノートを 2 冊（1 冊目は点を 2 つ根拠にする） */
function withNotes(lib) {
  const hs = Object.values(lib.highlights);
  addNote(lib, { title: '仕組みが意志に勝つ', body: '続けたいことは、気合いではなく環境と手順で支える。', pointIds: [hs[0].id, hs[1].id] }, T, 'nsys1');
  addNote(lib, { title: '問いを持って読む', body: '答えを探すより、問いを育てる読み方が残る。' }, T, 'nask1');
  return lib;
}

const llmOf = (fake, embedModel = 'fake-embed') => createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel });

test('isFarConnection・反応の形の確かめは、片方・両方が永久ノートの組を通す（形の違う ID は通さない）', () => {
  const pairOf = (x, y) => {
    const [a, b] = [x, y].sort();
    return { id: farId(a, b), a, b, idea: '共通', explanation: '説明', foundAt: T };
  };
  assert.ok(isFarConnection(pairOf('nabc', 'h123')));
  assert.ok(isFarConnection(pairOf('nabc', 'ndef')));
  assert.ok(!isFarConnection(pairOf('xabc', 'h123')));
  assert.ok(normalizeFarReaction({ ...pairOf('nabc', 't123'), status: 'interesting', updatedAt: T }, T));
  assert.equal(normalizeFarReaction({ ...pairOf('n_bad', 't123'), status: 'interesting', updatedAt: T }, T), null);
  // ノートが消えた組は持ち越さない
  const kept = mergeFarConnections([pairOf('nabc', 'h123')], [pairOf('ngone', 'h456')], (id) => id !== 'ngone');
  assert.deepEqual(kept.map((f) => f.a), ['h123']);
});

test('候補: 永久ノートを含む組に先の 3 枠を割り当てる。ノートが無ければ今までと同じ候補', () => {
  let s = 7;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const vec = () => l2normalize(Float32Array.from({ length: 16 }, () => rand() - 0.5));
  const points = Array.from({ length: 30 }, (_, i) => ({ id: `h${i.toString(36).padStart(2, '0')}`, vector: vec(), plane: `P${i % 5}`, source: `b${i % 7}`, isolated: i >= 24 }));
  const notes = Array.from({ length: 4 }, (_, i) => ({ id: `nn${i}`, vector: vec(), plane: `P${i}`, source: `nn${i}`, isolated: false, note: true }));
  const base = farCandidates({ reps: points });
  const withN = farCandidates({ reps: [...points, ...notes] });
  assert.equal(withN.length, FAR_MAX_PAIRS);
  const hasNote = (p) => p.a.startsWith('n') || p.b.startsWith('n');
  assert.ok(withN.slice(0, FAR_NOTE_SLOTS).every(hasNote), '先頭の 3 組はノートを含む');
  assert.ok(withN.some((p) => !hasNote(p)), '点どうしの組も試す');
  assert.ok(base.every((p) => !hasNote(p)));
  // ノートの組は、ノートの面と同じ面の点とは組まない
  const planeOf = new Map([...points, ...notes].map((r) => [r.id, r.plane]));
  for (const p of withN) assert.ok(planeOf.get(p.a) !== planeOf.get(p.b), '別の面');
  // ノートが無い入力の候補は、変わらない（同じ関数・同じ入力）
  assert.deepEqual(farCandidates({ reps: points }), base);
});

test('分析: 永久ノートを含む遠いつながりが結果に入る。ノートとその根拠の点の組は選ばず、AI には永久ノートとして見せる', async () => {
  const fake = await startFakeLlm({ far: () => ({ shared: true, idea: '共通する考え', explanation: '同じ原理の別の現れ。' }) });
  try {
    const lib = withNotes(sampleLibrary());
    const { analysis } = await analyzeLibrary({ library: lib, llm: llmOf(fake), options: { recommend: false } });
    const prompts = fake.calls.bodies.filter((b) => b.response_format?.json_schema?.name === 'far').map((b) => b.messages[1].content);
    assert.ok(prompts.length <= FAR_MAX_PAIRS);
    assert.ok(prompts.some((p) => /（永久ノート・読者自身の言葉）/.test(p)), 'AI にノートを見せる');
    const withNote = analysis.farConnections.filter((f) => f.a.startsWith('n') || f.b.startsWith('n'));
    assert.ok(withNote.length >= 1, `ノートを含む遠いつながり ${withNote.length}`);
    const cited = new Set(lib.notes.nsys1.pointIds);
    for (const f of withNote) {
      assert.ok(isFarConnection(f));
      if ([f.a, f.b].includes('nsys1')) assert.ok(!cited.has(f.a) && !cited.has(f.b), 'ノートの根拠の点とは組まない');
    }
    // ノートを含む組は発見にしない（発見の画面は点どうしの組）。分析の形として受け入れる
    assert.ok((analysis.discoveries || []).every((d) => d.pointIds.every((id) => !id.startsWith('n'))));
    assert.equal(analysisShapeError(analysis), '');
  } finally {
    await fake.close();
  }
});

test('分析: 永久ノートの意味の近い点は、根拠にしていない点だけ。ノートがあっても点の線・意味の近い点は変わらない（文字 n-gram でも）', async () => {
  const fake = await startFakeLlm();
  try {
    for (const embedModel of ['fake-embed', '']) {
      const plain = sampleLibrary();
      const noted = withNotes(sampleLibrary());
      const { analysis: a0 } = await analyzeLibrary({ library: plain, llm: llmOf(fake, embedModel), options: { recommend: false } });
      const { analysis: a1 } = await analyzeLibrary({ library: noted, llm: llmOf(fake, embedModel), options: { recommend: false } });
      const near = a1.neighbors.nsys1;
      assert.ok(Array.isArray(near) && near.length >= NEIGHBORS_MAX, `ノートの意味の近い点（${embedModel || 'tfidf'}）`);
      assert.ok(near.every((id) => !noted.notes.nsys1.pointIds.includes(id)), '根拠にしている点は出さない');
      assert.ok(Array.isArray(a1.neighbors.nask1));
      assert.deepEqual(a1.lines.map((l) => l.highlightIds), a0.lines.map((l) => l.highlightIds), '線は変わらない');
      const pointNeighbors = (a) => Object.fromEntries(Object.entries(a.neighbors).filter(([k]) => !k.startsWith('n')));
      assert.deepEqual(pointNeighbors(a1), pointNeighbors(a0), '点の意味の近い点は変わらない');
      assert.ok(Object.keys(a0.neighbors).every((k) => !k.startsWith('n')), 'ノートが無ければノートの欄は無い');
    }
  } finally {
    await fake.close();
  }
});

test('文字 n-gram: ノートは点の文で数えた語の珍しさで埋め込む（点の文を同じ方法で埋め込むと、点のベクトルと同じになる）', () => {
  const corpus = ['習慣は仕組みで続ける', '集中は環境で守る', '問いを持って読む', '小さく始めて続ける'];
  const base = tfidfEmbed(corpus);
  const [again] = tfidfEmbedAgainst(corpus, [corpus[2]]);
  assert.deepEqual(Array.from(again), Array.from(base[2]));
});

test('分析: 根拠の点が重なる永久ノートどうしの組は、遠い組の候補に選ばない（もう結んである）', async () => {
  const fake = await startFakeLlm({ far: () => ({ shared: true, idea: '共通する考え', explanation: '同じ原理の別の現れ。' }) });
  try {
    const lib = withNotes(sampleLibrary());
    addNotePoint(lib, 'nask1', lib.notes.nsys1.pointIds[0], T);
    const { analysis } = await analyzeLibrary({ library: lib, llm: llmOf(fake), options: { recommend: false } });
    assert.ok(!analysis.farConnections.some((f) => f.id === farId('nask1', 'nsys1')));
  } finally {
    await fake.close();
  }
});

test('分析: 永久ノートが 0 件なら、遠い組の候補も埋め込みの回数も今までと同じ（ノートを埋め込まない）', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    // 線から作って直していない下書きは、分析に渡さない（AI の文なので）
    addNote(lib, { title: '線の下書き', body: 'AI の文', pointIds: [], from: { kind: 'line', id: 'l1', name: '線' } }, T, 'ndraft1');
    const { analysis } = await analyzeLibrary({ library: lib, llm: llmOf(fake), options: { recommend: false } });
    assert.ok(!fake.calls.embedInputs.includes('線の下書き\nAI の文'));
    assert.ok(analysis.farConnections.every((f) => !f.a.startsWith('n') && !f.b.startsWith('n')));
    assert.ok(!('ndraft1' in analysis.neighbors));
  } finally {
    await fake.close();
  }
});

test('分析: 書き換えた永久ノートだけ埋め込み直し、消したノートの埋め込みはキャッシュから外す', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = withNotes(sampleLibrary());
    const cache = emptyCache();
    const llm = llmOf(fake);
    await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
    assert.ok(cache.embeddings.vectors.nsys1 && cache.embeddings.vectors.nask1);
    const before = fake.calls.embedInputs.length;
    lib.notes.nask1 = { ...lib.notes.nask1, body: '問いを育てる読み方は、次の本を選ぶ道しるべになる。', updatedAt: T2 };
    lib.notes.nsys1 = { id: 'nsys1', deleted: true, createdAt: T, updatedAt: T2 };
    await analyzeLibrary({ library: lib, llm, cache, options: { recommend: false } });
    const again = fake.calls.embedInputs.slice(before);
    assert.ok(again.includes('問いを持って読む\n問いを育てる読み方は、次の本を選ぶ道しるべになる。'), '書き換えたノートを埋め込み直す');
    assert.ok(!again.some((t) => t.startsWith('仕組みが意志に勝つ')));
    assert.ok(!('nsys1' in cache.embeddings.vectors), '消したノートの埋め込みは外す');
  } finally {
    await fake.close();
  }
});

/** 画面の状態（分析に、ノートの意味の近い点と、ノートを含む遠いつながりを入れたもの） */
function noteState() {
  const library = withNotes(sampleLibrary());
  const hs = Object.values(library.highlights);
  const [a, b] = ['nsys1', hs[5].id].sort();
  const far = { id: farId(a, b), a, b, idea: '環境が行動を決める', explanation: '同じ原理。', foundAt: T };
  const analysis = {
    createdAt: T,
    stats: { points: hs.length, calls: { chat: 0, embed: 0 }, far: { candidates: 1, calls: 1, found: 1 } },
    model: { chat: 'fake', embed: 'fake-embed' },
    lines: [],
    planes: [],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: hs.map((h) => h.id),
    recommendations: [],
    farConnections: [far],
    discoveries: [],
    neighbors: { nsys1: [hs[2].id, hs[3].id, hs[4].id] },
  };
  return { state: { library, analysis, loaded: true, settings: { ai: { mode: 'direct', companionUrl: '' }, autoSync: false }, servedByCompanion: false, pcInfo: null, job: null }, hs, far };
}

test('ノートの画面: 「意味の近い点（根拠にしていないもの）」が、根拠にする・リンクするボタンとともに出る。分析のあとで根拠にした点は出さない', async () => {
  const { noteView } = await import('../web/js/views/notes.js');
  const { state, hs } = noteState();
  const out = String(noteView.render({ state, params: { id: 'nsys1' } }));
  assert.match(out, /<h2>意味の近い点（根拠にしていないもの）<\/h2><span class="small muted">3<\/span>/);
  assert.match(out, new RegExp(`data-action="cite-quick" data-note="nsys1" data-point="${hs[2].id}"`));
  assert.match(out, new RegExp(`data-action="link-quick" data-from="nsys1" data-to="${hs[2].id}"`));
  addNotePoint(state.library, 'nsys1', hs[2].id, T2);
  addLink(state.library, 'nsys1', hs[3].id, '', T2);
  const after = String(noteView.render({ state, params: { id: 'nsys1' } }));
  assert.match(after, /<h2>意味の近い点（根拠にしていないもの）<\/h2><span class="small muted">2<\/span>/);
  assert.doesNotMatch(after, new RegExp(`data-action="cite-quick" data-note="nsys1" data-point="${hs[2].id}"`));
  assert.match(after, /リンク済み/);
  // 分析にまだ入っていないノートは、理由を出す
  assert.match(String(noteView.render({ state, params: { id: 'nask1' } })), /次の分析で出ます/);
});

test('ノートの画面: 「根拠にする」を押すと 1 回でそのノートの根拠になる（保存してから同期する）', async () => {
  const { noteActions } = await import('../web/js/note-actions.js');
  const { state, hs } = noteState();
  const log = [];
  const actions = noteActions({ state, openSheet: () => log.push('sheet'), toast: () => log.push('toast'), persist: async () => log.push('persist'), sync: () => log.push('sync'), render: () => log.push('render'), go: () => {}, confirm: () => true });
  await actions['cite-quick']({ dataset: { note: 'nsys1', point: hs[4].id } });
  assert.ok(state.library.notes.nsys1.pointIds.includes(hs[4].id));
  assert.deepEqual(log, ['persist', 'toast', 'render', 'sync']);
});

test('「面白い」とした、ノートを含む遠いつながりは、ノートの画面と点の画面のリンクに出る。遠いつながりの画面ではノートの側を題で出す', async () => {
  const { noteView } = await import('../web/js/views/notes.js');
  const { pointView } = await import('../web/js/views/point.js');
  const { farView } = await import('../web/js/views/far.js');
  const { state, hs, far } = noteState();
  const list = String(farView.render({ state }));
  assert.match(list, /永久ノート「仕組みが意志に勝つ」/);
  assert.match(list, /href="#\/note\/nsys1"/);
  assert.doesNotMatch(String(noteView.render({ state, params: { id: 'nsys1' } })), /遠いつながり（面白い）/);
  reactFar(state.library, far, 'interesting', T2);
  assert.deepEqual(farLinksFor(state.analysis, state.library, 'nsys1').map((x) => x.other), [hs[5].id]);
  assert.match(String(noteView.render({ state, params: { id: 'nsys1' } })), /遠いつながり（面白い）・環境が行動を決める/);
  const point = String(pointView.render({ state, params: { id: hs[5].id } }));
  assert.match(point, /遠いつながり（面白い）・環境が行動を決める/);
  assert.match(point, /href="#\/note\/nsys1"/);
  // ノートを消したら、遠いつながりの画面にもリンクにも出さない
  state.library.notes.nsys1 = { id: 'nsys1', deleted: true, createdAt: T, updatedAt: T2 };
  assert.doesNotMatch(String(farView.render({ state })), /far-card/);
  assert.doesNotMatch(String(pointView.render({ state, params: { id: hs[5].id } })), /遠いつながり（面白い）/);
});

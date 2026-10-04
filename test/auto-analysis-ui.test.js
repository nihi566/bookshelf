// G5 の画面: 自動の分析の状態（失敗の理由・最後に成功した時刻）・前回からの変化・履歴・問いに答える
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeParsed } from '../web/core/model.js';
import { addThought } from '../web/core/thoughts.js';
import { analysisPoints } from '../web/core/points.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { analyzeLibrary } from '../web/core/analysis/pipeline.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}
const ids = (lib) => Object.keys(lib.highlights);

function analysisOf(lib, extra = {}) {
  const [a, b, c, d] = ids(lib);
  return {
    version: 2,
    createdAt: '2026-10-04T10:00:00.000Z',
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48, lines: 2, planes: 1, isolated: 0, calls: { chat: 1, embed: 2 } },
    lines: [
      { id: 'l1', name: '仕組みの線', summary: '要約', insight: '<b>どう続けるか</b>？', keywords: [], highlightIds: [a, b], bookIds: [] },
      { id: 'l2', name: '注意の線', summary: '要約', insight: '', keywords: [], highlightIds: [c, d], bookIds: [] },
    ],
    planes: [{ id: 'p1', name: '面', summary: '要約', lineIds: ['l1', 'l2'] }],
    solid: { title: '核', core: '核の文', relations: [], principles: ['原則'], questions: ['どうすれば続くのか？'] },
    isolated: [],
    recommendations: [],
    ...extra,
  };
}

const st = (library, analysis, { mode = 'companion', pcInfo = null } = {}) => ({ library, analysis, settings: { ai: { mode, companionUrl: '' } }, servedByCompanion: true, job: null, pcInfo });

test('G5-3: 知識の画面に、自動の分析の失敗の理由と最後に成功した時刻が出る（前回の結果は残っていると伝える）', async () => {
  const { autoStatusBlock } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const pcInfo = { autoAnalysis: { enabled: true, minPoints: 10, maxHours: 24, pending: 12, lastSuccessAt: '2026-10-04T01:02:00.000Z', lastError: 'LLM サーバに接続できません <script>', lastErrorAt: '2026-10-04T03:04:00.000Z', lastTrigger: 'auto' } };
  const out = String(autoStatusBlock(st(lib, null, { pcInfo })));
  assert.match(out, /自動の分析: <b>オン<\/b> — 前回の分析のあとに点が 10 件増えるか、24 時間たって 1 件以上増えると、PC が分析し直します/);
  assert.match(out, /最後に成功: 10\/4 /);
  assert.match(out, /の分析に失敗しました: LLM サーバに接続できません &lt;script&gt;。前回の結果はそのまま残っています。次の機会に PC がもう一度試します。/);
  const off = String(autoStatusBlock(st(lib, null, { pcInfo: { autoAnalysis: { ...pcInfo.autoAnalysis, enabled: false, lastError: '' } } })));
  assert.match(off, /<b>オフ<\/b>/);
  assert.match(String(autoStatusBlock(st(lib, null, { mode: 'direct' }))), /PC のコンパニオン（bh serve）を使うときに動きます/);
  // PC の情報を取り直したら、この欄だけ差し替える
  assert.match(readFileSync(join(WEB, 'js/app.js'), 'utf8'), /'\/knowledge': \['#auto-status', autoStatusBlock\]/);
});

test('G5-4: 知識の画面で「前回から増えた線・大きくなった線・消えた線・新しくつながった点」が見られ、過去の分析を開ける', async () => {
  const { knowledge, historyView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const [, , , , e] = ids(lib);
  const a = analysisOf(lib, { incremental: true, changes: { previousAt: '2026-10-03T00:00:00.000Z', addedLines: [{ id: 'l2', name: '注意の線', size: 2 }], grownLines: [{ id: 'l1', name: '仕組みの線', added: 1 }], removedLines: [{ id: 'lx', name: '消えた<線>', size: 3 }], connectedPoints: [{ pointId: e, lineId: 'l1' }] } });
  const out = String(knowledge.render({ state: st(lib, a) }));
  assert.match(out, /<h2>前回からの変化<\/h2>/);
  assert.match(out, /新しい線 1<\/h3><div class="hl-lines"><a class="line-chip" href="#\/knowledge\/line\/l2">注意の線<\/a>/);
  assert.match(out, /大きくなった線 1[\s\S]*?仕組みの線 (<span class="nowrap">)?＋1/);
  assert.match(out, /消えた線 1<\/h3><p class="small muted">消えた&lt;線&gt;<\/p>/);
  assert.match(out, /新しくつながった点 1[\s\S]*?href="#\/knowledge\/line\/l1">仕組みの線に (<span class="nowrap">)?1 点/);
  assert.match(out, /<h2>分析の履歴<\/h2>[\s\S]*?id="analysis-history"/);
  assert.match(out, /前回の分析のあとに増えた点: <b>44<\/b> 件/);
  const rebuilt = String(knowledge.render({ state: st(lib, analysisOf(lib, { changes: { previousAt: 'x', rebuilt: true, addedLines: [], grownLines: [], removedLines: [], connectedPoints: [] } })) }));
  assert.match(rebuilt, /今回は最初から作り直しました/);
  // 過去の分析を開く画面（PC から 1 回分を取りに行く）
  assert.match(String(historyView.render({ params: { id: '20261004T100000000Z' } })), /<h1>過去の分析<\/h1>/);
  assert.match(readFileSync(join(WEB, 'js/app.js'), 'utf8'), /\[\/\^\\\/knowledge\\\/history\\\/\(\?<id>\[0-9TZ\]\+\)\$\/, historyView, 'knowledge'\]/);
});

test('G5-5: 立体の問いと線の問いから、その場で答えを書ける。答えはどの問いへの答えかを持ち、次の分析で点になる', async () => {
  const { knowledge, lineView } = await import('../web/js/views/knowledge.js');
  const lib = sample();
  const a = analysisOf(lib);
  const out = String(knowledge.render({ state: st(lib, a) }));
  assert.match(out, /<li>どうすれば続くのか？<div class="answers">\s*<button type="button" class="btn small" data-action="answer" data-kind="solid" data-ref="" data-question="どうすれば続くのか？">答えを書く<\/button>/);
  const line = String(lineView.render({ state: st(lib, a), params: { id: 'l1' } }));
  assert.match(line, /data-action="answer" data-kind="line" data-ref="l1" data-question="&lt;b&gt;どう続けるか&lt;\/b&gt;？">答えを書く/);
  // 書いた答えは問いの下に出る
  const t = addThought(lib, { text: '毎朝 5 分だけやると決めた', answerTo: { kind: 'solid', question: 'どうすれば続くのか？' } });
  assert.match(String(knowledge.render({ state: st(lib, a) })), /<ul class="plain answer-list"><li>毎朝 5 分だけやると決めた<\/li><\/ul>/);
  // 答えも思いつきとして点になる（次の分析の材料）
  assert.ok(analysisPoints(lib).some((p) => p.id === t.id));
  const llm = { chatModel: 'stub', embed: null, chatJson: async (p) => (p.name === 'line' ? { name: '線', summary: '', insight: '', keywords: [] } : p.name === 'plane' ? { name: '面', summary: '' } : { title: '核', core: '', relations: [], principles: [], questions: [] }) };
  const { analysis } = await analyzeLibrary({ library: lib, llm, options: { recommend: false } });
  assert.ok([...analysis.lines.flatMap((l) => l.highlightIds), ...analysis.isolated].includes(t.id), '分析の点に入った');
  // 「答えを書く」は思いつきのシートを開き、answerTo 付きで書く
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  const action = app.match(/\n  answer\(el\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(action, /openSheet\(newThoughtSheet\(\{ question \}\)/);
  assert.match(action, /addThought\(state\.library, \{ text: data\.get\('text'\), answerTo \}/);
});

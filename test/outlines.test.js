// G9 アウトプットへの出口: 面・線・永久ノートから、人に読ませる文章の骨組み（見出し・各節の要点・使う引用）を作り、直して持ち出す
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyLibrary, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { addThought } from '../web/core/thoughts.js';
import { addNote, deleteNote, updateNote } from '../web/core/notes.js';
import { addOutline, deleteOutline, liveOutlines, normalizeOutline, outlinesOf, updateOutline } from '../web/core/outlines.js';
import { OUTLINE_POINTS_MAX, cleanPicks, outlineMarkdown, outlineMaterials, outlinePrompt, quoteOf, readOutline, unavailableQuotes } from '../web/core/outline-draft.js';
import { applyImport, makeBackup } from '../web/core/importing.js';
import { createStore } from '../cli/store.js';
import { createCompanionServer } from '../cli/server.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const T = '2026-10-05T09:00:00.000Z';
const T2 = '2026-10-05T10:00:00.000Z';
const T3 = '2026-10-05T11:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}
const byText = (lib, start) => Object.values(lib.highlights).find((h) => h.text.startsWith(start));

/** 面 1 つ（線 2 本）の小さな分析。線の点は中心に近い順 */
function tinyAnalysis(lib) {
  const hs = Object.values(lib.highlights).sort((a, b) => a.id.localeCompare(b.id));
  const [a, b, c, d, e] = hs;
  return {
    version: 2,
    createdAt: T,
    model: { chat: 'fake-chat', embed: 'fake-embed' },
    stats: { points: 5, thoughts: 0, lines: 2, planes: 1, isolated: 0 },
    lines: [
      { id: 'l1', name: '線A', summary: '線A の説明', keywords: [], highlightIds: [a.id, b.id, c.id] },
      { id: 'l2', name: '線B', summary: '線B の説明', keywords: [], highlightIds: [d.id, e.id] },
    ],
    planes: [{ id: 'p1', name: '面A', summary: '面A の説明', lineIds: ['l1', 'l2'] }],
    solid: { title: '', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
    points: { a, b, c, d, e },
  };
}

test('G9-1: 材料を集める。材料 1 つにつき説明 1 つ（面は線の名前を添える）。点は面の中では線ごとに、材料どうしも交互に取り、重ねず最大 20 件。問いかけの答えのメモは入れない。見つからない材料は分ける', () => {
  const lib = sampleLibrary();
  const an = tinyAnalysis(lib);
  const { a, b, c, d, e } = an.points;
  const f = Object.values(lib.highlights).find((h) => ![a, b, c, d, e].some((x) => x.id === h.id));
  const answer = addThought(lib, { text: '保存した AI の答え', answerTo: { kind: 'ask', question: '問い' } }, T, 'tans1');
  addNote(lib, { title: '自分の考え', body: 'ノートの本文', pointIds: [answer.id, f.id, a.id] }, T, 'nmat1');
  const m = outlineMaterials(lib, an, [
    { kind: 'plane', id: 'p1' },
    { kind: 'line', id: 'l1' },
    { kind: 'note', id: 'nmat1' },
    { kind: 'line', id: 'lgone' },
    { kind: 'plane', id: 'p1' },
  ]);
  assert.deepEqual(m.sources, [
    { kind: 'plane', id: 'p1', name: '面A' },
    { kind: 'line', id: 'l1', name: '線A' },
    { kind: 'note', id: 'nmat1', name: '自分の考え' },
  ]);
  assert.deepEqual(m.missing, [{ kind: 'line', id: 'lgone' }]);
  assert.deepEqual(m.contexts.map((x) => `${x.kind}:${x.name}:${x.author}`), ['面:面A:ai', '線:線A:ai', '永久ノート:自分の考え:reader'], '材料 1 つにつき説明 1 つ（面・線は AI、ノートは読者の言葉）');
  assert.deepEqual(m.contexts[0].lineNames, ['線A', '線B']);
  // 面（線 A・線 B を交互に）・線 A・ノートを交互に取る。重ねない。問いかけの答えのメモは入れない
  // 1 巡目: 面の 1 番 a・線の 1 番 a（重ね）・ノートの 1 番（答えのメモなので入れない）→ 2 巡目: d・b・f → 3 巡目: c → 4 巡目: e
  assert.deepEqual(m.points.map((p) => p.id), [a.id, d.id, b.id, f.id, c.id, e.id]);
  assert.ok(!m.points.some((p) => p.id === answer.id));
  // 線が多い面とノートを選んでも、ノートの点が先の方に入る
  const others = Object.keys(lib.highlights).filter((id) => id !== f.id);
  const big = { ...an, lines: Array.from({ length: 19 }, (_, i) => ({ ...an.lines[0], id: `lb${i}`, highlightIds: others.slice(i, i + 5) })), planes: [{ ...an.planes[0], lineIds: Array.from({ length: 19 }, (_, i) => `lb${i}`) }] };
  addNote(lib, { title: '別の考え', body: '', pointIds: [f.id] }, T, 'nmat2');
  const mixed = outlineMaterials(lib, big, [{ kind: 'plane', id: 'p1' }, { kind: 'note', id: 'nmat2' }]);
  assert.equal(mixed.points[1].id, f.id, '材料どうしを交互に取る');
  assert.equal(mixed.points.length, OUTLINE_POINTS_MAX);
  assert.equal(OUTLINE_POINTS_MAX, 20);
  // 消したノート・分析の無い面は見つからない
  deleteNote(lib, 'nmat1', T2);
  assert.deepEqual(outlineMaterials(lib, null, [{ kind: 'note', id: 'nmat1' }, { kind: 'plane', id: 'p1' }]).missing.length, 2);
  // 選んだ材料の形を整える（最大 8 件）
  assert.deepEqual(cleanPicks([{ kind: 'plane', id: 'p1' }, { kind: 'book', id: 'b1' }, { kind: 'line', id: '../x' }, null, 'x', { kind: 'note', id: 'n1', extra: 1 }]), [
    { kind: 'plane', id: 'p1' },
    { kind: 'note', id: 'n1' },
  ]);
  assert.equal(cleanPicks(Array.from({ length: 50 }, (_, i) => ({ kind: 'line', id: `l${i}` }))).length, 8);
  assert.deepEqual(cleanPicks('x'), []);
});

test('G9-1・G9-2: 依頼文は材料と番号つきの点（書名つき。位置は入れない）。AI には見出し・要点・引用の番号だけを出させ、番号を点の ID に直す（文は持たない・範囲外は捨てる）。節が無ければ作れない', () => {
  const lib = sampleLibrary();
  const an = tinyAnalysis(lib);
  const m = outlineMaterials(lib, an, [{ kind: 'plane', id: 'p1' }]);
  const p = outlinePrompt(lib, m);
  assert.equal(p.name, 'outline');
  assert.match(p.user, new RegExp(`^\\[1\\] .+（${lib.books[m.points[0].bookId].title}）$`, 'm'), '点には書名を添える');
  // 線から作って一度も直していないノートは、中身が AI の線のまま（読者の言葉と書かない）。直したら読者の言葉
  addNote(lib, { title: '線A', body: '線A の説明', pointIds: [], from: { kind: 'line', id: 'l1', name: '線A' } }, T, 'ndraft1');
  assert.equal(outlineMaterials(lib, an, [{ kind: 'note', id: 'ndraft1' }]).contexts[0].author, 'ai');
  updateNote(lib, 'ndraft1', { body: '自分の言葉に直した' }, T2);
  assert.equal(outlineMaterials(lib, an, [{ kind: 'note', id: 'ndraft1' }]).contexts[0].author, 'reader');
  assert.match(p.system, /引用は点の番号で選ぶだけにし、引用の文そのものは書きません/);
  assert.match(p.user, /- 面「面A」（AI がまとめたもの）: 面A の説明（線: 線A・線B）/);
  assert.match(p.user, new RegExp(`\\[1\\] ${m.points[0].text.slice(0, 10)}`));
  assert.equal((p.user.match(/^\[\d+\] /gm) || []).length, m.points.length);
  assert.doesNotMatch(p.user, /位置 \d+/, '位置は依頼文に入れない（AI は使わない）');
  assert.match(p.user, /節は 2〜3 つ/, '点が少ないときは節を少なく頼む');
  assert.deepEqual(p.schema.properties.sections.items.properties.quotes, { type: 'array', items: { type: 'integer' } });
  // 上限の材料（8 件・点 20 件・長い文）でも依頼文は 6,000 字まで
  const lib2 = sampleLibrary();
  const long = 'あ'.repeat(3000);
  const ids = Object.keys(lib2.highlights);
  for (const id of ids) lib2.highlights[id] = { ...lib2.highlights[id], text: `${lib2.highlights[id].text}${long}` };
  for (let i = 0; i < 8; i++) addNote(lib2, { title: 'い'.repeat(100), body: long, pointIds: ids.slice(i * 3, i * 3 + 3) }, T, `nlong${i}`);
  const maxed = outlineMaterials(lib2, null, Array.from({ length: 8 }, (_, i) => ({ kind: 'note', id: `nlong${i}` })));
  assert.equal(maxed.points.length, OUTLINE_POINTS_MAX);
  const big = outlinePrompt(lib2, maxed);
  assert.ok(big.system.length + big.user.length <= 6000, `${big.system.length + big.user.length} 字`);
  assert.match(big.user, /節は 3〜6 つ/);
  assert.match(big.user, /永久ノート「い+…」（読者の言葉）/, '長い題は短く切る');
  // 答えを読む
  const draft = readOutline(
    {
      title: '  題\nです  ',
      sections: [
        { heading: '一つ目', points: ['要点 A', '  ', 7], quotes: [1, '2', 2, 99, 0, true, '書き換えた文'] },
        { heading: '', points: [], quotes: [1] },
        null,
        { heading: '二つ目', points: ['要点 B'], quotes: [] },
      ],
    },
    m,
  );
  assert.equal(draft.title, '題 です');
  assert.deepEqual(draft.sources, m.sources);
  assert.deepEqual(draft.sections, [
    { heading: '一つ目', points: ['要点 A'], quotes: [m.points[0].id, m.points[1].id] },
    { heading: '二つ目', points: ['要点 B'], quotes: [] },
  ]);
  assert.ok(!JSON.stringify(draft).includes('書き換えた文'), '引用の文を AI から受け取らない');
  // 題が無ければ材料の名前
  assert.equal(readOutline({ sections: [{ heading: 'x', points: [], quotes: [] }] }, m).title, '面A');
  // 見出し・要点の中の [n] は引用に移して、文から消す（番号は依頼文の中だけのもの）
  const cited = readOutline({ title: '題 [1]', sections: [{ heading: '見出し [3]', points: ['言うこと [2] です', '[99] 範囲外', '仕組みを整える [1]。'], quotes: [] }] }, m);
  assert.deepEqual(cited.sections, [{ heading: '見出し', points: ['言うこと です', '範囲外', '仕組みを整える。'], quotes: [m.points[2].id, m.points[1].id, m.points[0].id] }], '番号の前の空白も消す（句点の前に空白を残さない）');
  assert.equal(cited.title, '題', '題の番号は引用にせず消す');
  assert.throws(() => readOutline({ title: '題', sections: [] }, m), (e) => e.code === 'empty-outline' && /骨組みを作れませんでした/.test(e.message));
  assert.throws(() => readOutline(null, m), (e) => e.code === 'empty-outline');
});

test('G9-2: 引用は点の文と一字一句同じ（改行も）で、書名と位置が付く。Kindle で伸ばしたハイライトは今の文、消えた点は「消えた点」。Markdown も同じ', () => {
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  const k = Object.values(lib.highlights).find((h) => h.source === 'kindle' && h.location != null && h.id !== habit.id);
  const gone = Object.values(lib.highlights).find((h) => ![habit.id, k.id].includes(h.id));
  addThought(lib, { text: '一行目\n二行目' }, T, 'tquote1');
  const o = addOutline(lib, { title: '題', sources: [], sections: [{ heading: '見出し', points: ['要点'], quotes: [habit.id, k.id, gone.id, 'tquote1'] }] }, T, 'oquote1');
  assert.deepEqual(quoteOf(lib, habit.id), { id: habit.id, text: habit.text, source: `『小さな習慣の力』位置 ${habit.location}`, gone: false, notYet: false });
  // 伸ばしたハイライト（置き換わった先の今の文）・消えた点
  mergeParsed(lib, [{ title: lib.books[k.bookId].title, author: lib.books[k.bookId].author, source: 'kindle', highlights: [{ text: `${k.text}続きの文。`, location: k.location }] }], { now: T2 });
  updateHighlight(lib, gone.id, { deleted: true });
  assert.equal(quoteOf(lib, k.id).text, `${k.text}続きの文。`);
  assert.deepEqual([quoteOf(lib, gone.id).gone, quoteOf(lib, gone.id).notYet], [true, false], '消えた点');
  assert.deepEqual([quoteOf(lib, 'hnotyet1').gone, quoteOf(lib, 'hnotyet1').notYet], [true, true], 'この端末にまだ無い点（PC で取り込んだ直後）');
  // Markdown には出せない引用（消えた点）を書かず、その数を数えられる
  assert.equal(unavailableQuotes(lib, o), 1);
  const md = outlineMarkdown(lib, o);
  assert.equal(
    md,
    [
      '# 題',
      '',
      '## 見出し',
      '',
      '- 要点',
      '',
      `> ${habit.text}`,
      `> — 『小さな習慣の力』位置 ${habit.location}`,
      '',
      `> ${k.text}続きの文。`,
      `> — 『${lib.books[k.bookId].title}』位置 ${k.location}`,
      '',
      '> 一行目',
      '> 二行目',
      '> — 思いつき（メモ）',
      '',
    ].join('\n'),
  );
});

test('G9-2: Markdown では、題・見出し・要点・書名の Markdown の記号を打ち消す（AI の文や同期で届いた書名を、画像・リンク・見出し・偽の引用として働かせない）。引用の文はそのまま', () => {
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  const o = addOutline(lib, { title: '![t](https://evil.example/x)', sections: [{ heading: '## 偽の見出し', points: ['> 偽の引用 — 『書名』位置 12', '- 入れ子', '1. 番号', '<img src=x>'], quotes: [habit.id] }] }, T, 'oevil1');
  lib.books[habit.bookId] = { ...lib.books[habit.bookId], title: `本${String.fromCharCode(0x2028)}# 見出し ![x](https://e)` };
  const lines = outlineMarkdown(lib, o).split('\n');
  assert.deepEqual(lines, [
    '# \\!\\[t\\]\\(https://evil.example/x\\)',
    '',
    '## \\#\\# 偽の見出し',
    '',
    '- \\> 偽の引用 — 『書名』位置 12',
    '- \\- 入れ子',
    '- 1\\. 番号',
    '- \\<img src=x\\>',
    '',
    `> ${habit.text}`,
    `> — 『本 \\# 見出し \\!\\[x\\]\\(https://e\\)』位置 ${habit.location}`,
    '',
  ]);
  // 引用の文は打ち消さない（一字一句そのまま）。Unicode の行区切りも引用の中の改行として扱う（引用の外に行を作らない）
  addThought(lib, { text: `*強調*は[そのまま]` }, T, 'tmd1');
  lib.thoughts.tmd1 = { ...lib.thoughts.tmd1, text: `一行目${String.fromCharCode(0x2028)}# 二行目` };
  const q = addOutline(lib, { title: '題', sections: [{ heading: '見出し', points: [], quotes: ['tmd1'] }] }, T, 'omd1');
  assert.match(outlineMarkdown(lib, q), /\n> 一行目\n> # 二行目\n> — 思いつき（メモ）\n$/);
  // 要点の [n] の前に長い空白が続いても、時間をかけずに読む（番号は引用に移る。1 つの文は先頭 2,000 字だけ読む）
  const m = outlineMaterials(lib, tinyAnalysis(lib), [{ kind: 'plane', id: 'p1' }]);
  const spaced = readOutline({ title: '題', sections: [{ heading: '見出し', points: [`${' '.repeat(1900)}[1]`, `要点${' '.repeat(1900)}[2]`], quotes: [] }] }, m);
  assert.deepEqual(spaced.sections[0], { heading: '見出し', points: ['要点'], quotes: [m.points[0].id, m.points[1].id] });
});

test('G9-3: 骨組みを保存する・直す・消す。保存は押し直しても 1 件。何も変わらなければ時刻を進めない。消したら墓標だけ', () => {
  const lib = sampleLibrary();
  const [h1, h2] = Object.values(lib.highlights);
  const draft = { title: '題', sources: [{ kind: 'plane', id: 'p1', name: '面A' }], sections: [{ heading: '一つ目', points: ['要点'], quotes: [h1.id, h1.id, 'bad id'] }] };
  const o = addOutline(lib, draft, T, 'oedit1');
  assert.deepEqual(o, { id: 'oedit1', title: '題', sources: draft.sources, sections: [{ heading: '一つ目', points: ['要点'], quotes: [h1.id] }], createdAt: T, updatedAt: T });
  assert.equal(addOutline(lib, draft, T2, 'oedit1'), outlinesOf(lib).oedit1, '同じ ID で押し直しても 1 件');
  assert.throws(() => addOutline(lib, { title: ' ', sections: [] }, T, 'oempty1'), /題も節も/);
  assert.throws(() => addOutline(lib, draft, T, 'bad'), /ID/);
  // 直す
  assert.equal(updateOutline(lib, 'oedit1', { title: '題', sections: o.sections }, T2).updatedAt, T, '何も変わらなければ時刻を進めない');
  // 上限を超えた直しは、黙って切らずに理由を返す（骨組みは変わらない）
  const sec = (extra) => [{ heading: '一つ目', points: ['要点'], quotes: [], ...extra }];
  assert.throws(() => updateOutline(lib, 'oedit1', { sections: sec({ points: Array.from({ length: 9 }, (_, i) => `要点 ${i}`) }) }, T2), /要点は 8 つまで/);
  assert.throws(() => updateOutline(lib, 'oedit1', { sections: sec({ points: ['あ'.repeat(201)] }) }, T2), /1 つ 200 字まで/);
  assert.throws(() => updateOutline(lib, 'oedit1', { sections: sec({ heading: 'あ'.repeat(81) }) }, T2), /見出しは 80 字まで/);
  assert.throws(() => updateOutline(lib, 'oedit1', { sections: Array.from({ length: 13 }, (_, i) => ({ heading: `節${i}`, points: [], quotes: [] })) }, T2), /節は 12 まで/);
  assert.throws(() => updateOutline(lib, 'oedit1', { title: 'あ'.repeat(101) }, T2), /題は 100 字まで/);
  assert.equal(outlinesOf(lib).oedit1.updatedAt, T);
  // 長さは 1 文字ずつ数える（絵文字 1 つも 1 字。整えるときと同じ数え方）
  const emoji = String.fromCodePoint(0x1f600).repeat(150);
  assert.deepEqual(updateOutline(lib, 'oedit1', { sections: sec({ points: [emoji] }) }, T2).sections[0].points, [emoji]);
  const u = updateOutline(lib, 'oedit1', { title: '新しい題', sections: [{ heading: '一つ目', points: ['直した要点'], quotes: [h2.id] }] }, T3);
  assert.deepEqual([u.title, u.sections[0].points, u.sections[0].quotes, u.updatedAt], ['新しい題', ['直した要点'], [h2.id], T3]);
  assert.throws(() => updateOutline(lib, 'oedit1', { title: '', sections: [] }, T3), /題か節/);
  // 消す
  deleteOutline(lib, 'oedit1', T3);
  assert.deepEqual(outlinesOf(lib).oedit1, { id: 'oedit1', deleted: true, createdAt: T, updatedAt: T3 });
  assert.deepEqual(liveOutlines(lib), []);
  assert.throws(() => updateOutline(lib, 'oedit1', { title: 'x' }), /見つかりません/);
  assert.equal(deleteOutline(lib, 'oedit1', T3), null);
});

test('G9-3: 骨組みは同期・バックアップで失われず、統合の向きに依らず、消したものは戻らない。壊れた値・古い形でも壊れない', () => {
  const phone = sampleLibrary();
  const pc = sampleLibrary();
  const [h1] = Object.values(phone.highlights);
  const draft = (title) => ({ title, sources: [], sections: [{ heading: '見出し', points: ['要点'], quotes: [h1.id] }] });
  addOutline(phone, draft('スマホで作った'), T, 'ophone1');
  addOutline(pc, draft('PC で作った'), T, 'opc1');
  addOutline(phone, draft('両方'), T, 'oboth1');
  addOutline(pc, draft('両方'), T, 'oboth1');
  updateOutline(pc, 'oboth1', { title: 'PC で直した' }, T2);
  addOutline(phone, draft('消す'), T, 'odel1');
  addOutline(pc, draft('消す'), T, 'odel1');
  deleteOutline(phone, 'odel1', T2);
  updateOutline(pc, 'odel1', { title: 'PC で直したが消えたまま' }, T3);
  const ab = mergeLibraries(phone, pc);
  assert.deepEqual(ab.outlines, mergeLibraries(pc, phone).outlines, '統合の向きに依らない');
  assert.deepEqual(liveOutlines(ab).map((o) => o.title).sort(), ['PC で作った', 'PC で直した', 'スマホで作った'].sort());
  assert.equal(ab.outlines.odel1.deleted, true, '消したものは、あとで直されても戻らない');
  // バックアップ
  const file = JSON.parse(JSON.stringify(makeBackup(ab, null)));
  assert.deepEqual(applyImport({ library: emptyLibrary() }, { backups: [file] }).library.outlines, ab.outlines);
  // 壊れた値は捨て、長すぎる値は切る
  const raw = JSON.parse(
    JSON.stringify({
      obad1: { id: 'obad1', title: '', sections: [] },
      'x-1': { id: 'x-1', title: '形の違う ID', sections: [] },
      onull1: null,
      olong1: {
        id: 'olong1',
        title: 'あ'.repeat(500),
        sources: [{ kind: 'plane', id: 'p1', name: '面' }, { kind: 'book', id: 'b1' }],
        sections: Array.from({ length: 30 }, (_, i) => ({ heading: `節${i}`, points: Array.from({ length: 20 }, () => 'い'.repeat(500)), quotes: [h1.id, 'bad id', 3, ...Array.from({ length: 20 }, (_, j) => `h${j}x`)] })),
        createdAt: 'いつか',
        updatedAt: T,
      },
    }),
  );
  const proto = JSON.parse(`{"__proto__":{"id":"oproto1","title":"x","sections":[]}}`);
  const merged = mergeLibraries(emptyLibrary(), { ...emptyLibrary(), outlines: { ...raw } }).outlines;
  assert.deepEqual(Object.keys(merged), ['olong1']);
  const long = merged.olong1;
  assert.equal(long.title.length, 100);
  assert.equal(long.sections.length, 12);
  assert.equal(long.sections[0].points.length, 8);
  assert.equal(long.sections[0].points[0].length, 200);
  assert.equal(long.sections[0].quotes.length, 8);
  assert.ok(long.sections[0].quotes.every((id) => /^[ht][0-9a-z]+$/.test(id)));
  assert.deepEqual(long.sources, [{ kind: 'plane', id: 'p1', name: '面' }]);
  assert.equal(long.createdAt, '');
  assert.deepEqual(Object.keys(mergeLibraries(emptyLibrary(), { ...emptyLibrary(), outlines: proto }).outlines), []);
  assert.equal(normalizeOutline({ id: 'odel2', deleted: true, title: '消したものの中身', createdAt: T, updatedAt: T }).title, undefined, '墓標は中身を持たない');
  // 古い形（outlines が無い）
  const old = sampleLibrary();
  delete old.outlines;
  assert.deepEqual(liveOutlines(old), []);
  assert.deepEqual(mergeLibraries(ab, old).outlines, ab.outlines);
  for (const broken of [[], 'x', 3, null]) assert.deepEqual(mergeLibraries(ab, { ...emptyLibrary(), outlines: broken }).outlines, ab.outlines);
});

/** PC のサーバ（bh serve）を一時フォルダのデータと偽の LLM で立てる */
async function withServer(fn, { llm = {}, library = sampleLibrary(), analysis = undefined, fakeOptions = {} } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bh-outline-'));
  const fake = await startFakeLlm(fakeOptions);
  const store = createStore(dataDir);
  await store.saveConfig({ llm: { baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed', ...llm } });
  await store.saveLibrary(library);
  const an = analysis === undefined ? tinyAnalysis(library) : analysis;
  if (an) {
    const { points, ...shape } = an;
    await store.saveAnalysis(shape);
  }
  const server = createCompanionServer({ store, log: () => {}, catalogFetch: async () => new Response(JSON.stringify({ items: [] })) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, fake, library, analysis: an });
  } finally {
    server.close();
    await fake.close();
  }
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('G9-1: PC の「骨組みを作る」（POST /api/outline）は、材料から依頼文を作ってローカル LLM に頼み、保存前の下書き（引用は点の ID）を返す。材料が無い・チャットモデルが無い・AI が失敗したときは理由を返す', async () => {
  await withServer(async ({ base, fake, analysis }) => {
    const res = await post(base, '/api/outline', { sources: [{ kind: 'plane', id: 'p1' }] });
    assert.equal(res.status, 200);
    const draft = await res.json();
    const { a, d, b } = analysis.points;
    assert.equal(draft.title, '小さな仕組みで続ける');
    assert.deepEqual(draft.sources, [{ kind: 'plane', id: 'p1', name: '面A' }]);
    assert.deepEqual(draft.sections.map((s) => s.quotes), [[a.id], [d.id, b.id], []], '1・2・3 番の点（線 A・線 B から順に）');
    assert.equal(fake.calls.chat, 1);
    const sent = fake.calls.bodies.at(-1);
    assert.equal(sent.response_format.json_schema.name, 'outline');
    assert.match(sent.messages[1].content, /\[1\] /);
    // 材料が無い・見つからない
    assert.equal((await post(base, '/api/outline', { sources: [] })).status, 400);
    // 1 つでも PC に見つからなければ作らない（抜けたまま作らない。AI も呼ばない）
    const none = await post(base, '/api/outline', { sources: [{ kind: 'plane', id: 'p1' }, { kind: 'note', id: 'nnotonpc1' }] });
    assert.equal(none.status, 409);
    const why = await none.json();
    assert.equal(why.code, 'missing-sources');
    assert.match(why.error, /1 件が PC に見つかりません。PC と同期してから/);
    assert.equal(fake.calls.chat, 1);
  });
  await withServer(
    async ({ base }) => {
      const r = await post(base, '/api/outline', { sources: [{ kind: 'plane', id: 'p1' }] });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, 'no-chat-model');
    },
    { llm: { chatModel: '' } },
  );
  await withServer(
    async ({ base }) => {
      const r = await post(base, '/api/outline', { sources: [{ kind: 'plane', id: 'p1' }] });
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /骨組みを作れませんでした（LLM サーバに接続できません/);
    },
    { llm: { baseUrl: 'http://127.0.0.1:9' } },
  );
  await withServer(
    async ({ base }) => {
      const r = await post(base, '/api/outline', { sources: [{ kind: 'plane', id: 'p1' }] });
      assert.equal(r.status, 502);
      assert.equal((await r.json()).error, '骨組みを作れませんでした（AI の答えに節がありませんでした）。もう一度押してください');
    },
    { fakeOptions: { outline: () => ({ title: '題だけ', sections: [] }) } },
  );
});

/** 骨組みの操作（outline-actions.js）に渡す偽のブラウザの部品。where は今の画面の場所。failPersist で端末への保存を失敗させる */
async function fakeOutlineActions(state, { generate, where = () => '/outline/new', failPersist = false } = {}) {
  const { outlineActions } = await import('../web/js/outline-actions.js');
  const log = { generated: [], sheets: [], toasts: [], persisted: 0, synced: 0, rendered: 0, pages: 0, went: [], copied: [], asked: [] };
  const actions = outlineActions({
    state,
    generate: generate || (async (picks) => (log.generated.push(picks), { title: '作った題', sources: [{ kind: 'plane', id: 'p1', name: '面A' }], sections: [{ heading: '見出し', points: ['要点'], quotes: [] }] })),
    openSheet: (content, onSubmit) => log.sheets.push({ html: String(content), submit: onSubmit }),
    toast: (m) => log.toasts.push(m),
    persist: async () => {
      if (failPersist) throw new Error('容量が足りません');
      log.persisted++;
    },
    sync: () => log.synced++,
    render: () => log.rendered++,
    renderPage: () => log.pages++,
    go: (h) => log.went.push(h),
    here: where,
    confirm: (m) => (log.asked.push(m), true),
    copy: async (text) => {
      log.copied.push(text);
    },
  });
  return { actions, log };
}
/** シートの送信の中身（FormData の代わり） */
const form = (fields) => ({ get: (k) => (Object.hasOwn(fields, k) ? [].concat(fields[k])[0] : null), getAll: (k) => [].concat(fields[k] ?? []) });

test('G9-1・G9-3: 骨組みの操作: 選んだ材料で作って保存し、開く（作っている間の連打は 1 回・失敗は理由）。直すシート（見出し・要点・引用を外す・節を消す・足す）・Markdown をコピー・消す', async () => {
  const lib = sampleLibrary();
  const [h1, h2] = Object.values(lib.highlights);
  const state = { library: lib, analysis: null, loaded: true };
  const { actions, log } = await fakeOutlineActions(state);
  await actions.create([]);
  assert.match(log.toasts.at(-1), /1 つ以上選んで/);
  await actions.create(Array.from({ length: 9 }, (_, i) => ({ kind: 'line', id: `l${i}` })));
  assert.match(log.toasts.at(-1), /材料は 8 つまで選べます（いま 9 つ）/, '黙って先頭だけで作らない');
  assert.equal(log.generated.length, 0);
  const first = actions.create([{ kind: 'plane', id: 'p1' }, { kind: 'book', id: 'x' }]);
  assert.equal(state.outlineDraft.status, 'pending');
  await actions.create([{ kind: 'plane', id: 'p1' }]);
  await first;
  assert.deepEqual(log.generated, [[{ kind: 'plane', id: 'p1' }]], '作っている間に押し直しても 1 回だけ頼む');
  const [o] = liveOutlines(lib);
  assert.equal(o.title, '作った題');
  assert.deepEqual([log.persisted, log.synced, log.went], [1, 1, [`#/outline/${o.id}`]], '端末に保存して PC と同期し、作った骨組みを開く');
  assert.equal(state.outlineDraft, null);
  // 失敗（理由を出して、もう一度押せる）。PC の bh serve が古い（窓口が無い 404）・届いた下書きが空でも止まらない
  const failing = await fakeOutlineActions(state, { generate: async () => Promise.reject(new Error('PC から返事がありませんでした')) });
  await failing.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.deepEqual(state.outlineDraft, { status: 'error', error: 'PC から返事がありませんでした' });
  const old = await fakeOutlineActions(state, { generate: async () => Promise.reject(Object.assign(new Error('不明な API: POST /api/outline'), { status: 404 })) });
  await old.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.match(state.outlineDraft.error, /PC の bh serve が古いため/);
  const empty = await fakeOutlineActions(state, { generate: async () => ({ title: '', sections: [] }) });
  await empty.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.match(state.outlineDraft.error, /題も節もありません/);
  assert.equal(liveOutlines(lib).length, 1);
  // 作っている間に別の画面へ移っていたら、画面は移さずに知らせるだけ（書きかけを消さない）
  state.outlineDraft = null;
  const away = await fakeOutlineActions(state, { where: () => '/book/b1' });
  await away.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.deepEqual(away.log.went, []);
  assert.match(away.log.toasts.at(-1), /知識の画面の「文章の骨組み」から開けます/);
  assert.equal(liveOutlines(lib).length, 2);
  deleteOutline(lib, liveOutlines(lib).find((x) => x.id !== o.id).id, T);
  state.outlineDraft = null;
  // 直す: 見出し・要点（1 行 1 つ）・引用を外す・節を消す・節を足す
  updateOutline(lib, o.id, { sections: [{ heading: '一つ目', points: ['要点 A'], quotes: [h1.id, h2.id] }, { heading: '二つ目', points: ['要点 B'], quotes: [] }] }, T2);
  actions['outline-edit']({ dataset: { id: o.id } });
  const sheet = log.sheets.at(-1);
  assert.match(sheet.html, /name="heading-0" maxlength="80" value="一つ目"/);
  assert.match(sheet.html, /<textarea name="points-0" rows="4">要点 A<\/textarea>/);
  assert.match(sheet.html, new RegExp(`name="quote-0" value="${h1.id}" checked`));
  // 空の行がたくさんあっても、後ろの要点を落とさない（空の行は先に除く）
  await sheet.submit(form({ title: '直した題', 'heading-0': '一つ目（直した）', 'points-0': `要点 A${'\n'.repeat(40)}要点 C\n`, 'quote-0': [h2.id], 'heading-1': '二つ目', 'points-1': '要点 B', 'drop-1': '1', 'heading-new': '三つ目' }), 'save');
  const edited = outlinesOf(lib)[o.id];
  assert.equal(edited.title, '直した題');
  assert.deepEqual(edited.sections, [
    { heading: '一つ目（直した）', points: ['要点 A', '要点 C'], quotes: [h2.id] },
    { heading: '三つ目', points: [], quotes: [] },
  ]);
  assert.deepEqual([log.persisted, log.pages], [2, 1]);
  // Markdown をコピー（クリップボードに書く中身は Markdown と同じ）
  await actions['outline-copy']({ dataset: { id: o.id } });
  assert.deepEqual(log.copied, [outlineMarkdown(lib, edited)]);
  assert.match(log.copied[0], /^# 直した題\n\n## 一つ目（直した）\n\n- 要点 A\n- 要点 C\n\n> /);
  assert.match(log.toasts.at(-1), /Markdown をコピーしました/);
  // 消す（確かめてから）
  await actions['outline-delete']({ dataset: { id: o.id } });
  assert.match(log.asked[0], /材料の面・線・ノート・点は消えません/);
  assert.equal(outlinesOf(lib)[o.id].deleted, true);
  assert.deepEqual(log.went.at(-1), '#/outlines');
  // 消したものには何もしない・読み込み前は作らない
  actions['outline-edit']({ dataset: { id: o.id } });
  await actions['outline-copy']({ dataset: { id: o.id } });
  assert.equal(log.copied.length, 1);
  const loading = await fakeOutlineActions({ ...state, loaded: false });
  await loading.actions.create([{ kind: 'plane', id: 'p1' }]);
  assert.equal(loading.log.generated.length, 0);
});

test('G9-3: 直すシートは変えた欄だけを保存する（開いている間に同期で届いた別の端末の直しを負かさない）。何も変えなければ保存しない。作る画面を離れて失敗したら知らせる', async () => {
  const lib = sampleLibrary();
  const state = { library: lib, analysis: null, loaded: true };
  const o = addOutline(lib, { title: '題', sources: [], sections: [{ heading: '一つ目', points: ['要点 A'], quotes: [] }] }, T, 'oboth2');
  const { actions, log } = await fakeOutlineActions(state);
  actions['outline-edit']({ dataset: { id: o.id } });
  const sheet = log.sheets.at(-1);
  // 開いている間に、別の端末で題が直されて同期で届いた
  updateOutline(lib, o.id, { title: 'PC で直した題' }, T2);
  // 節だけ直して保存 → PC の題は残る
  await sheet.submit(form({ title: '題', 'heading-0': '一つ目', 'points-0': '要点 A\n要点 B' }), 'save');
  assert.deepEqual([outlinesOf(lib)[o.id].title, outlinesOf(lib)[o.id].sections[0].points], ['PC で直した題', ['要点 A', '要点 B']]);
  assert.equal(log.persisted, 1);
  // 何も変えずに保存 → 保存も同期もしない
  actions['outline-edit']({ dataset: { id: o.id } });
  const current = outlinesOf(lib)[o.id];
  await log.sheets.at(-1).submit(form({ title: current.title, 'heading-0': '一つ目', 'points-0': '要点 A\n要点 B' }), 'save');
  assert.deepEqual([log.persisted, log.synced], [1, 1]);
  // 作る画面を離れていて失敗したら、知らせる（PC の文がすでに「骨組みを作れませんでした」で始まるなら重ねない）
  const away = await fakeOutlineActions(state, { where: () => '/books', generate: async () => Promise.reject(new Error('PC が忙しい')) });
  await away.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.match(away.log.toasts.at(-1), /^骨組みを作れませんでした: PC が忙しい$/);
  state.outlineDraft = null;
  const said = await fakeOutlineActions(state, { where: () => '/books', generate: async () => Promise.reject(new Error('骨組みを作れませんでした（AI の答えに節がありませんでした）。もう一度押してください')) });
  await said.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.equal(said.log.toasts.at(-1), '骨組みを作れませんでした（AI の答えに節がありませんでした）。もう一度押してください');
  // 作れたが端末に保存できなかった: 作っている間の表示は消え（押し直して 2 つ作らない）、知らせて、PC と同期する
  state.outlineDraft = null;
  const before = liveOutlines(lib).length;
  const full = await fakeOutlineActions(state, { failPersist: true });
  await full.actions.create([{ kind: 'line', id: 'l1' }]);
  assert.equal(state.outlineDraft, null);
  assert.equal(liveOutlines(lib).length, before + 1);
  assert.match(full.log.toasts.at(-1), /作れましたが、この端末に保存できませんでした（容量が足りません）/);
  assert.equal(full.log.synced, 1);
  assert.equal(full.log.went.length, 1, '作る画面にいれば、作った骨組みを開く');
});

test('G9-1〜G9-3: 画面: 骨組みの画面は見出し・要点・引用（点の文そのまま・書名と位置・点へのリンク）と、直す・コピー・削除。作る画面は面・線・ノートをチェックで選べ、渡された材料は選んだ状態。入口は面・線・ノートの画面と知識の画面。文はエスケープ', async () => {
  const { outlineView, outlineNewView, outlinesView, outlinesSummaryBlock } = await import('../web/js/views/outlines.js');
  const { planeView, lineView, knowledge } = await import('../web/js/views/knowledge.js');
  const { noteView } = await import('../web/js/views/notes.js');
  const lib = sampleLibrary();
  const habit = byText(lib, '良い習慣は、始めるのに');
  const an = tinyAnalysis(lib);
  const { points, ...analysis } = an;
  addNote(lib, { title: '自分の考え<b>', body: '本文' }, T, 'nui1');
  const o = addOutline(lib, { title: '題<script>', sources: [{ kind: 'plane', id: 'p1', name: '面A' }, { kind: 'note', id: 'nui1', name: '自分の考え<b>' }], sections: [{ heading: '見出し<img>', points: ['要点<i>'], quotes: [habit.id, 'hgone1'] }] }, T, 'oui1');
  const state = { library: lib, analysis, loaded: true, servedByCompanion: true, settings: { ai: { mode: 'companion', companionUrl: '' } } };
  const page = String(outlineView.render({ state, params: { id: o.id } }));
  assert.doesNotMatch(page, /<script>|<img>|<b>|<i>/);
  assert.match(page, /<h1 class="note-h1">題&lt;script&gt;<\/h1>/);
  assert.match(page, /材料: <a href="#\/knowledge\/plane\/p1">面「面A」<\/a>・<a href="#\/note\/nui1">永久ノート「自分の考え&lt;b&gt;」<\/a>/);
  assert.match(page, /<h2>見出し&lt;img&gt;<\/h2>/);
  assert.match(page, /<li>要点&lt;i&gt;<\/li>/);
  assert.match(page, new RegExp(`<blockquote class="outline-quote"><p>${habit.text}</p><footer>— 『小さな習慣の力』位置 ${habit.location} <a href="#/point/${habit.id}">点へ</a></footer></blockquote>`));
  assert.match(page, /<blockquote class="outline-quote gone"><p>（この端末にまだ無い点。PC と同期すると出ます）<\/p><\/blockquote>/, 'PC で作った骨組みの点が、まだこの端末に届いていない');
  updateHighlight(lib, habit.id, { deleted: true });
  assert.match(String(outlineView.render({ state, params: { id: o.id } })), /<blockquote class="outline-quote gone"><p>（消えた点）<\/p><\/blockquote>/);
  assert.match(page, /data-action="outline-edit" data-id="oui1">直す/);
  assert.match(page, /data-action="outline-copy" data-id="oui1">Markdown をコピー/);
  assert.match(page, /data-action="outline-delete" data-id="oui1">この骨組みを削除/);
  assert.match(String(outlineView.render({ state, params: { id: 'onothing1' } })), /この骨組みは見つかりません/);
  // 作る画面: 渡された材料は選んだ状態。PC が無ければ押せない
  const pick = String(outlineNewView.render({ state, query: new URLSearchParams('line=l2&note=nui1') }));
  assert.match(pick, /name="plane" value="p1" >/);
  assert.match(pick, /name="line" value="l2" checked>/);
  assert.match(pick, /<details open><summary class="small">線から選ぶ<\/summary>/, '選んだ線のある面は開いておく');
  assert.match(pick, /name="note" value="nui1" checked> <span>自分の考え&lt;b&gt;/);
  assert.match(pick, /<button class="btn primary" id="outline-submit" >骨組みを作る<\/button>/);
  assert.match(pick, /<div id="outline-status"><\/div>/);
  const noPc = String(outlineNewView.render({ state: { ...state, settings: { ai: { mode: 'direct', companionUrl: '' } } }, query: new URLSearchParams() }));
  assert.match(noPc, /PC（bh serve）とつながっているとき/);
  assert.match(noPc, /id="outline-submit" disabled>/);
  assert.match(String(outlineNewView.render({ state: { ...state, analysis: null }, query: new URLSearchParams() })), /面と線は、分析すると選べます/);
  assert.match(String(outlineNewView.render({ state: { ...state, outlineDraft: { status: 'pending' } }, query: new URLSearchParams() })), /PC の AI が骨組みを作っています[\s\S]*id="outline-submit" disabled>|id="outline-submit" disabled>[\s\S]*PC の AI が骨組みを作っています/);
  // 一覧・知識の画面の欄・入口
  assert.match(String(outlinesView.render({ state })), /href="#\/outline\/oui1"[\s\S]*題&lt;script&gt;[\s\S]*節 1 ・ 面「面A」・永久ノート「自分の考え&lt;b&gt;」/);
  assert.match(String(outlinesSummaryBlock(state)), /<h2>文章の骨組み<\/h2><a class="small" href="#\/outlines">すべて見る（1）<\/a>/);
  assert.match(String(knowledge.render({ state: { ...state, job: null } })), /<h2>文章の骨組み<\/h2>/);
  assert.match(String(planeView.render({ state, params: { id: 'p1' } })), /<a class="btn small" href="#\/outline\/new\?plane=p1">文章の骨組みを作る<\/a>/);
  assert.match(String(lineView.render({ state, params: { id: 'l1' } })), /<a class="btn small" href="#\/outline\/new\?line=l1">文章の骨組みを作る<\/a>/);
  assert.match(String(noteView.render({ state, params: { id: 'nui1' } })), /<a class="btn small" href="#\/outline\/new\?note=nui1">文章の骨組みを作る<\/a>/);
});

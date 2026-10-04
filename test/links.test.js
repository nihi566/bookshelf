// G4 リンク（つながりを自分で張る）: 点・メモ・永久ノートどうしのリンク（張る・外す・理由・同期）、意味の近い点、
// 2 番目に近い線にも十分近い点（関わる点）、リンクをたどる・消えた相手、「面白い」とした遠いつながり
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { addThought, updateThought } from '../web/core/thoughts.js';
import { addNote, deleteNote } from '../web/core/notes.js';
import { LINKS_MAX, LINK_REASON_MAX, addLink, linkBetween, linkId, linksFor, linksOf, mergeLinks, normalizeLink, removeLink } from '../web/core/links.js';
import { NEIGHBORS_MAX, RELATED_MAX, lineMedian, nearPoints } from '../web/core/analysis/neighbors.js';
import { farId } from '../web/core/analysis/far.js';
import { reactFar } from '../web/core/far-reactions.js';
import { applyImport, makeBackup } from '../web/core/importing.js';
import { analysisShapeError } from '../web/core/analysis/shape.js';
import { createLlmClient } from '../web/core/analysis/llm.js';
import { analyzeLibrary, emptyCache } from '../web/core/analysis/pipeline.js';
import { centroid, l2normalize } from '../web/core/analysis/vectors.js';
import { startFakeLlm } from './helpers/fake-llm.js';

const T = '2026-10-04T12:00:00.000Z';
const T2 = '2026-10-04T13:00:00.000Z';
const T3 = '2026-10-04T14:00:00.000Z';
const T4 = '2026-10-04T15:00:00.000Z';

function sampleLibrary() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: '2026-10-01T00:00:00.000Z' });
  return lib;
}

/** 別々の本の点を n 件（点の ID の順。同じデータなら同じ点） */
function pointsFromBooks(lib, n) {
  const seen = new Set();
  const out = [];
  for (const h of Object.values(lib.highlights).sort((a, b) => a.id.localeCompare(b.id))) {
    if (seen.has(h.bookId)) continue;
    seen.add(h.bookId);
    out.push(h);
    if (out.length === n) break;
  }
  return out;
}

/** 画面の確かめ用の小さな分析（線と、それを束ねた面 1 つ） */
function tinyAnalysis(lines, extra = {}) {
  return {
    version: 1,
    createdAt: T,
    lines: lines.map((l) => ({ summary: '', keywords: [], ...l })),
    planes: [{ id: 'p1', name: '面', summary: '', lineIds: lines.map((l) => l.id) }],
    solid: { title: '', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
    ...extra,
  };
}

/** リンクの操作（link-actions.js）に渡す偽のブラウザの部品。開いたシートと、保存・同期・移動の回数を残す */
async function fakeLinkActions(state, { answer = true } = {}) {
  const { linkActions } = await import('../web/js/link-actions.js');
  const log = { sheets: [], toasts: [], persisted: 0, synced: 0, rendered: 0, went: [], asked: [] };
  const actions = linkActions({
    state,
    openSheet: (content, onSubmit) => log.sheets.push({ html: String(content), submit: onSubmit }),
    toast: (m) => log.toasts.push(m),
    persist: async () => {
      log.persisted++;
    },
    sync: () => log.synced++,
    render: () => log.rendered++,
    go: (h) => log.went.push(h),
    confirm: (m) => {
      log.asked.push(m);
      return answer;
    },
  });
  return { actions, log };
}
/** シートの送信の中身（FormData の代わり） */
const form = (fields) => ({ get: (k) => (Object.hasOwn(fields, k) ? fields[k] : null) });
const count = (s, re) => (s.match(re) || []).length;

test('G4-1: 点・メモ・永久ノートのどれどうしでもリンクを張る・外す・張り直す。理由は 1 行で添えられる。両側から見える', () => {
  const lib = sampleLibrary();
  const [h1, h2, h3] = pointsFromBooks(lib, 3);
  const t1 = addThought(lib, { text: '散歩の途中で思いついた' }, T, 't1abc');
  addNote(lib, { title: '注意は資源', body: '' }, T, 'n1abc');
  addNote(lib, { title: '仕組みで続ける', body: '' }, T, 'n2abc');
  // 点と点・点とメモ・メモとノート・ノートとノート
  const l1 = addLink(lib, h1.id, h2.id, '  どちらも\n小さく始める  ', T);
  assert.equal(l1.id, linkId(h2.id, h1.id), '向きに依らず同じリンク');
  assert.equal(l1.reason, 'どちらも 小さく始める', '理由は 1 行');
  addLink(lib, h1.id, t1.id, '', T);
  addLink(lib, t1.id, 'n1abc', undefined, T);
  addLink(lib, 'n2abc', 'n1abc', '同じ考えの別の面', T);
  const others = (id) => linksFor(lib, id).map((e) => e.other).sort();
  assert.deepEqual(others(h1.id), [h2.id, t1.id].sort());
  assert.deepEqual(others(h2.id), [h1.id], '張られた側からも見える（逆向き）');
  assert.deepEqual(others(t1.id), [h1.id, 'n1abc'].sort());
  assert.deepEqual(others('n1abc'), ['n2abc', t1.id].sort());
  assert.equal(linkBetween(lib, h2.id, h1.id)?.id, l1.id);
  assert.equal(linkBetween(lib, h2.id, h3.id), null);
  // 理由は 1 行の長さまで。見えない文字・制御文字は落とす
  const zeroWidth = String.fromCharCode(0x200b);
  const bell = String.fromCharCode(7);
  const long = addLink(lib, h3.id, 'n2abc', `${zeroWidth}理由${bell}が${'あ'.repeat(LINK_REASON_MAX * 2)}`, T);
  assert.equal(long.reason.length, LINK_REASON_MAX);
  assert.ok(long.reason.startsWith('理由 があ'), long.reason.slice(0, 10));
  // 同じものどうし・形の違う相手は張れない
  assert.throws(() => addLink(lib, h1.id, h1.id), /同じもの/);
  assert.throws(() => addLink(lib, h1.id, 'x1abc'), /相手/);
  assert.throws(() => addLink(lib, '__proto__', h1.id), /相手/);
  // 同じ理由で張り直しても何も変えない（時刻を進めない: 別の端末の新しい編集を負かさない）
  assert.equal(addLink(lib, h2.id, h1.id, 'どちらも 小さく始める', T2).updatedAt, T);
  const re = addLink(lib, h2.id, h1.id, '習慣の入口', T2);
  assert.deepEqual([re.reason, re.createdAt, re.updatedAt], ['習慣の入口', T, T2], '理由を直す');
  assert.equal(addLink(lib, h1.id, h2.id, undefined, T3).reason, '習慣の入口', '理由を渡さなければ前の理由のまま');
  // 外す: 両側から消える。外したことは残し（同期で戻らないように）、理由の文は消す（消したノート・メモと同じく本文を残さない）
  const removed = removeLink(lib, l1.id, T3);
  assert.deepEqual([removed.deleted, removed.reason, removed.updatedAt], [true, '', T3]);
  assert.deepEqual(others(h2.id), []);
  assert.deepEqual(others(h1.id), [t1.id]);
  assert.equal(removeLink(lib, l1.id, T4), null, '外したリンクはもう外せない');
  assert.equal(removeLink(lib, 'knothing', T4), null);
  // もう一度張れば戻る（最初に張った日は残る。理由は外したときに消えている）
  const back = addLink(lib, h2.id, h1.id, undefined, T4);
  assert.deepEqual([back.deleted, back.reason, back.createdAt, back.updatedAt], [undefined, '', T, T4]);
  assert.deepEqual(others(h2.id), [h1.id]);
  assert.equal(lib.updatedAt, T4, 'ライブラリの更新日時も進む（同期で新しい方として送る）');
});

test('G4-1: リンクは同期・バックアップで失われず、統合の向きに依らない（新しい方を採る。外したリンクも張り直せる）。壊れた値・古い形でも壊れない', () => {
  const phone = sampleLibrary();
  const pc = sampleLibrary();
  const [h1, h2, h3, h4] = pointsFromBooks(phone, 4);
  addLink(phone, h1.id, h2.id, 'スマホで張った', T); // スマホだけ
  addLink(pc, h1.id, h3.id, 'PC で張った', T); // PC だけ
  addLink(phone, h2.id, h3.id, '古い理由', T); // 両方（PC の方が新しい）
  addLink(pc, h3.id, h2.id, '新しい理由', T2);
  addLink(pc, h1.id, h4.id, '', T); // PC で張り、スマホで外した（外した方が新しい）
  addLink(phone, h1.id, h4.id, '', T);
  removeLink(phone, linkId(h1.id, h4.id), T2);
  addLink(phone, h2.id, h4.id, '', T); // スマホで外したあと、PC で張り直した（張り直した方が新しい）
  removeLink(phone, linkId(h2.id, h4.id), T2);
  addLink(pc, h2.id, h4.id, '張り直した', T3);
  const ab = mergeLibraries(phone, pc);
  const ba = mergeLibraries(pc, phone);
  assert.deepEqual(ab.links, ba.links, '統合の向きに依らない');
  const key = (x, y, r) => `${[x, y].sort().join('-')}:${r}`;
  const live = (lib) => Object.values(lib.links).filter((l) => !l.deleted).map((l) => key(l.a, l.b, l.reason)).sort();
  assert.deepEqual(live(ab), [key(h1.id, h2.id, 'スマホで張った'), key(h1.id, h3.id, 'PC で張った'), key(h2.id, h3.id, '新しい理由'), key(h2.id, h4.id, '張り直した')].sort());
  assert.equal(ab.links[linkId(h1.id, h4.id)].deleted, true, '外した方が新しければ外れたまま');
  assert.equal(Object.keys(phone.links).length, 4, '統合しても元のライブラリは変えない');
  // バックアップから戻しても同じ（JSON を通しても失われない）。手元で後から外したリンクは戻らない
  const file = JSON.parse(JSON.stringify(makeBackup(ab, null)));
  assert.deepEqual(applyImport({ library: emptyLibrary() }, { backups: [file] }).library.links, ab.links);
  const later = structuredClone(ab);
  removeLink(later, linkId(h1.id, h2.id), T4);
  assert.equal(applyImport({ library: later }, { backups: [file] }).library.links[linkId(h1.id, h2.id)].deleted, true);
  // 壊れた値は捨てる（ID が端と合わない・同じものどうし・端の形が違う・項目でない・__proto__）
  const goodId = linkId(h1.id, h2.id);
  const raw = JSON.parse(
    JSON.stringify({
      [goodId]: { id: goodId, a: h2.id, b: h1.id, reason: 7, createdAt: 'いつか', updatedAt: T },
      kbad1: { id: 'kbad1', a: h1.id, b: h2.id, updatedAt: T },
      [linkId(h1.id, h1.id)]: { id: linkId(h1.id, h1.id), a: h1.id, b: h1.id, updatedAt: T },
      [linkId(h1.id, 'x9')]: { id: linkId(h1.id, 'x9'), a: h1.id, b: 'x9', updatedAt: T },
      knull: null,
      karr: [1, 2],
    }),
  );
  const proto = JSON.parse(`{"__proto__":{"id":"${goodId}","a":"${h1.id}","b":"${h2.id}","updatedAt":"${T}"}}`);
  const merged = mergeLibraries(emptyLibrary(), { ...emptyLibrary(), links: { ...raw } }).links;
  const [a, b] = [h1.id, h2.id].sort();
  assert.deepEqual(merged, { [goodId]: { id: goodId, a, b, reason: '', createdAt: '', updatedAt: T } });
  const fromProto = mergeLibraries(emptyLibrary(), { ...emptyLibrary(), links: proto }).links;
  assert.deepEqual(Object.keys(fromProto), []);
  assert.equal(Object.getPrototypeOf(fromProto), Object.prototype);
  assert.equal(normalizeLink({ ...merged[goodId], deleted: 'yes' }).deleted, undefined, '外した印は true だけ');
  const tomb = normalizeLink({ ...merged[goodId], reason: '外す前の理由', deleted: true });
  assert.deepEqual([tomb.deleted, tomb.reason], [true, ''], '外したリンクは届いても理由を持たない');
  // 同じ時刻に、片方で外し、もう片方で理由を直しても、統合の向きに依らない
  const left = sampleLibrary();
  const right = sampleLibrary();
  addLink(left, h1.id, h2.id, '左', T);
  removeLink(left, goodId, T2);
  addLink(right, h1.id, h2.id, '右で直した', T2);
  assert.deepEqual(mergeLibraries(left, right).links, mergeLibraries(right, left).links);
  // リンクの無い古い形のライブラリ（リンクを入れる前の端末・バックアップ）とも同期できる
  const old = sampleLibrary();
  delete old.links;
  assert.deepEqual(linksFor(old, h1.id), []);
  assert.deepEqual(mergeLibraries(old, old).links, {});
  assert.deepEqual(mergeLibraries(ab, old).links, ab.links, '古い端末と同期しても失われない');
  for (const broken of [[], 'links', 3, null]) assert.deepEqual(mergeLibraries(ab, { ...emptyLibrary(), links: broken }).links, ab.links);
});

test('G4-1: 同期・バックアップで届くリンクの数には上限がある（張っているリンクを先に、新しい順に残す。向きに依らない）', () => {
  const at = (i) => new Date(Date.parse(T) - i * 1000).toISOString();
  const many = {};
  for (let i = 0; i < LINKS_MAX + 3; i++) {
    const [a, b] = [`h${i.toString(36)}x`, `n${i.toString(36)}y`].sort();
    const id = linkId(a, b);
    // いちばん新しい 2 件は外したリンク（張っているリンクより後に回る）
    many[id] = { id, a, b, reason: '', createdAt: at(i), updatedAt: at(i), ...(i < 2 ? { deleted: true } : {}) };
  }
  const extraId = linkId('hzzzz1', 'nzzzz1');
  const extra = { [extraId]: { id: extraId, a: 'hzzzz1', b: 'nzzzz1', reason: '', createdAt: T, updatedAt: T } };
  const ab = mergeLinks(many, extra, T);
  assert.equal(Object.keys(ab).length, LINKS_MAX);
  assert.deepEqual(Object.keys(ab).sort(), Object.keys(mergeLinks(extra, many, T)).sort(), '統合の向きに依らない');
  assert.ok(Object.hasOwn(ab, extraId), '張っている新しいリンクは残る');
  assert.ok(Object.values(ab).every((l) => !l.deleted), '外したリンクから落とす');
  const oldest = linkId(...[`h${(LINKS_MAX + 2).toString(36)}x`, `n${(LINKS_MAX + 2).toString(36)}y`].sort());
  assert.ok(!Object.hasOwn(ab, oldest), 'いちばん古いリンクから落とす');
});

test('G4-1: リンクは両側の画面に出る。相手を言葉で探して選び、理由を 1 行添えて張れる。理由を直す・外すもその画面から（保存して PC と同期する）', async () => {
  const { pointView } = await import('../web/js/views/point.js');
  const { noteView } = await import('../web/js/views/notes.js');
  const { linkPickerView } = await import('../web/js/views/links.js');
  const lib = sampleLibrary();
  const [h1, h2] = pointsFromBooks(lib, 2);
  addNote(lib, { title: '注意は資源', body: '集中の考え' }, T, 'n1abc');
  const state = { library: lib, analysis: null, loaded: true };
  const { actions, log } = await fakeLinkActions(state);
  const picker = (id, q) => String(linkPickerView.render({ state, params: { id }, query: new URLSearchParams(q ? { q } : {}) }));
  // 点の画面の「リンクを張る」→ 相手を選ぶ画面
  assert.match(String(pointView.render({ state, params: { id: h1.id } })), new RegExp(`<a class="btn small" href="#/link/${h1.id}">リンクを張る</a>`));
  const empty = picker(h1.id, '');
  assert.match(empty, /言葉で探して/);
  assert.doesNotMatch(empty, /data-action="link-to"/);
  assert.match(picker(h1.id, '注意は資源'), new RegExp(`data-action="link-to" data-from="${h1.id}" data-to="n1abc"`));
  assert.match(picker(h1.id, h2.text.slice(0, 8)), new RegExp(`data-to="${h2.id}"`));
  assert.doesNotMatch(picker(h1.id, h1.text.slice(0, 8)), new RegExp(`data-to="${h1.id}"`), '自分は出さない');
  // 選ぶと理由を書くシートが開き、保存すると張って元の画面へ戻る
  actions['link-to']({ dataset: { from: h1.id, to: 'n1abc' } });
  assert.match(log.sheets[0].html, /<h2>リンクの理由<\/h2>/);
  assert.match(log.sheets[0].html, /注意は資源/);
  await log.sheets[0].submit(form({ reason: '集中を守る\n仕組み' }), 'save');
  const link = linkBetween(lib, h1.id, 'n1abc');
  assert.equal(link.reason, '集中を守る 仕組み');
  assert.deepEqual([log.persisted, log.synced, log.went], [1, 1, [`#/point/${h1.id}`]], '保存して PC と同期し、元の点の画面へ戻る');
  // 両側の画面に出る（点の画面とノートの画面）
  const p1 = String(pointView.render({ state, params: { id: h1.id } }));
  assert.match(p1, /<h2>リンク<\/h2><span class="small muted">1<\/span>/);
  assert.match(p1, /href="#\/note\/n1abc"><span class="link-title">注意は資源<\/span><span class="link-sub">永久ノート<\/span><span class="link-reason">理由: 集中を守る 仕組み<\/span>/);
  const n1 = String(noteView.render({ state, params: { id: 'n1abc' } }));
  assert.match(n1, new RegExp(`<a class="link-target" href="#/point/${h1.id}">`), 'ノートの画面にも出る（逆向き）');
  assert.match(n1, /理由: 集中を守る 仕組み/);
  // もうリンクした相手は、相手を選ぶ画面に出さない
  const again = picker(h1.id, '注意は資源');
  assert.doesNotMatch(again, /data-to="n1abc"/);
  assert.match(again, /見つかりませんでした/);
  // 理由を直す
  actions['link-reason']({ dataset: { id: link.id } });
  assert.match(log.sheets[1].html, /value="集中を守る 仕組み"/);
  await log.sheets[1].submit(form({ reason: '注意の守り方' }), 'save');
  assert.equal(linkBetween(lib, 'n1abc', h1.id).reason, '注意の守り方');
  // 外す（確かめてから。やめたら外さない）
  const asking = await fakeLinkActions(state, { answer: false });
  await asking.actions['link-remove']({ dataset: { id: link.id } });
  assert.ok(linkBetween(lib, h1.id, 'n1abc'), 'やめたら外さない');
  assert.equal(asking.log.persisted, 0);
  await actions['link-remove']({ dataset: { id: link.id } });
  assert.equal(linkBetween(lib, h1.id, 'n1abc'), null);
  assert.match(log.asked[0], /リンクした点やノートは消えません/);
  assert.match(String(pointView.render({ state, params: { id: h1.id } })), /まだリンクはありません/);
  assert.deepEqual([log.persisted, log.synced], [3, 3]);
  // 外したリンクの「理由」「外す」は何もしない（古い画面から押されても壊れない）
  actions['link-reason']({ dataset: { id: link.id } });
  await actions['link-remove']({ dataset: { id: link.id } });
  assert.equal(log.sheets.length, 2);
  // 端末のデータを読み込む前は張らない
  const loading = await fakeLinkActions({ ...state, loaded: false });
  await loading.actions['link-quick']({ dataset: { from: h1.id, to: h2.id } });
  loading.actions['link-to']({ dataset: { from: h1.id, to: h2.id } });
  assert.equal(linkBetween(lib, h1.id, h2.id), null);
  assert.equal(loading.log.sheets.length, 0);
  assert.match(loading.log.toasts[0], /読み込んで/);
});

test('G4-2: 意味の近い点は別の出どころ（別の本）の点から近い順に最大 5 件。まだつながらない点も候補。同じデータなら同じ結果（同じ近さは ID の順）', () => {
  // 2 次元の角度でベクトルを作る（近さ = 角度の差の cos）。ID の 2 文字目が出どころ（本）
  const at = (deg) => l2normalize(Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]));
  const ids = ['ha0', 'ha1', 'ha2', 'hb3', 'hb4', 'hb5', 'hc6', 'hc7', 'hc8', 'hc9'];
  const vectors = [0, 2, 4, 10, 20, 30, 40, 50, 60, 70].map(at);
  const sourceOf = (i) => ids[i][1];
  const line = (id, members) => ({ id, members, centroid: centroid(members.map((i) => vectors[i])) });
  const input = { ids, vectors, lines: [line('l1', [0, 1, 2, 3, 4]), line('l2', [5, 6, 7, 8, 9])], isolated: [], sourceOf };
  const { neighbors } = nearPoints(input);
  assert.deepEqual(neighbors.ha0, ['hb3', 'hb4', 'hb5', 'hc6', 'hc7'], '同じ本の ha1・ha2 は入れない');
  assert.equal(NEIGHBORS_MAX, 5);
  assert.deepEqual(neighbors.hb3, ['ha2', 'ha1', 'ha0', 'hc6', 'hc7'], '近い順（線をまたいでも）');
  assert.deepEqual(nearPoints(input), nearPoints(input), '同じデータなら同じ結果');
  // まだつながらない点（どの線にも入っていない点）も候補になり、その点にも意味の近い点が出る
  const withIsolated = { ...input, ids: [...ids, 'hd10'], vectors: [...vectors, at(0.5)], isolated: [10], sourceOf: (i) => (i === 10 ? 'd' : ids[i][1]) };
  const near = nearPoints(withIsolated).neighbors;
  assert.equal(near.ha0[0], 'hd10');
  assert.deepEqual(near.hd10.slice(0, 3), ['ha0', 'ha1', 'ha2']);
  // 同じ近さなら ID の順
  const tie = nearPoints({ ids: ['hz0', 'hy1', 'hx2'], vectors: [at(0), at(10), at(-10)], lines: [], isolated: [0, 1, 2], sourceOf: (i) => String(i) });
  assert.deepEqual(tie.neighbors.hz0, ['hx2', 'hy1']);
  // 点の ID の形でないもの（__proto__ など）は鍵にしない（入れ物の継承元を書き換えない）
  const odd = nearPoints({ ids: ['__proto__', 'hb1'], vectors: [at(0), at(1)], lines: [], isolated: [0, 1], sourceOf: (i) => String(i) });
  assert.equal(Object.getPrototypeOf(odd.neighbors), Object.prototype);
  assert.deepEqual(Object.keys(odd.neighbors), ['hb1']);
});

test('G4-2・G4-3: 分析すると、どの点にも別の本の意味の近い点が最大 5 件付く。2 つの線の考えをまとめたメモは、入った線のほかに、もう 1 つの線の「関わる点」になる。同じデータなら同じ結果', async () => {
  const fake = await startFakeLlm();
  try {
    const lib = sampleLibrary();
    addThought(lib, { text: '習慣は小さく始めると続く' }, T, 't1abc');
    const llm = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: 'fake-embed' });
    const first = (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), options: { recommend: false } })).analysis;
    assert.equal(analysisShapeError(first), '');
    const sourceOf = (id) => (id.startsWith('t') ? id : lib.highlights[id].bookId);
    const all = [...first.lines.flatMap((l) => l.highlightIds), ...first.isolated];
    assert.ok(all.length > 40 && all.includes('t1abc'));
    for (const id of all) {
      const near = first.neighbors[id] || [];
      assert.ok(near.length >= 1 && near.length <= NEIGHBORS_MAX, `${id}: ${near.length} 件`);
      assert.equal(new Set(near).size, near.length);
      assert.ok(near.every((x) => x !== id && sourceOf(x) !== sourceOf(id) && all.includes(x)), '別の本の点（思いつきは 1 つずつ別の出どころ）');
    }
    // いちばん小さい線の点すべてと、いちばん大きい線の中心に近い点 2 つをまとめたメモを書いて、分析し直す（前回を引き継ぐ）
    const bySize = [...first.lines].sort((a, b) => a.highlightIds.length - b.highlightIds.length);
    const text = [...bySize[0].highlightIds, ...bySize.at(-1).highlightIds.slice(0, 2)].map((id) => lib.highlights[id].text).join('');
    addThought(lib, { text }, T2, 'tmixabc');
    const run = async () => (await analyzeLibrary({ library: lib, llm, cache: emptyCache(), previous: first, options: { recommend: false } })).analysis;
    const second = await run();
    assert.equal(second.incremental, true);
    assert.equal(analysisShapeError(second), '');
    const own = second.lines.filter((l) => l.highlightIds.includes('tmixabc'));
    const relatedTo = second.lines.filter((l) => l.relatedIds?.includes('tmixabc'));
    assert.equal(own.length, 1, 'メモは 1 本の線に入る');
    assert.equal(relatedTo.length, 1, 'もう 1 本の線の関わる点になる（1 つの点が 2 本の線とつながる）');
    assert.notEqual(relatedTo[0].id, own[0].id);
    // 関わる点はほかの線に入っている点だけ・1 本に最大 12 件
    const lineOf = new Map(second.lines.flatMap((l) => l.highlightIds.map((id) => [id, l.id])));
    for (const l of second.lines.filter((x) => x.relatedIds)) {
      assert.ok(l.relatedIds.length >= 1 && l.relatedIds.length <= RELATED_MAX);
      assert.ok(l.relatedIds.every((id) => lineOf.has(id) && lineOf.get(id) !== l.id));
    }
    // 点の画面に両方の線が出る
    const { pointView } = await import('../web/js/views/point.js');
    const page = String(pointView.render({ state: { library: lib, analysis: second, loaded: true }, params: { id: 'tmixabc' } }));
    assert.match(page, new RegExp(`<a class="line-chip" href="#/knowledge/line/${own[0].id}">`));
    assert.match(page, new RegExp(`<h2>関わる線</h2>[\\s\\S]*<a class="line-chip" href="#/knowledge/line/${relatedTo[0].id}">`));
    // 同じデータなら同じ結果
    const again = await run();
    assert.deepEqual(again.neighbors, second.neighbors);
    assert.deepEqual(again.lines.map((l) => l.relatedIds), second.lines.map((l) => l.relatedIds));
    // 埋め込みモデルが無いときも、文字 n-gram のベクトルで意味の近い点を作る（黙って空にしない）
    const plain = createLlmClient({ baseUrl: fake.url, chatModel: 'fake-chat', embedModel: '' });
    const tf = (await analyzeLibrary({ library: sampleLibrary(), llm: plain, cache: emptyCache(), options: { recommend: false } })).analysis;
    assert.equal(tf.model.embed, 'tfidf');
    const tfAll = [...tf.lines.flatMap((l) => l.highlightIds), ...tf.isolated];
    assert.ok(tfAll.length > 40 && tfAll.every((id) => (tf.neighbors[id] || []).length >= 1));
  } finally {
    await fake.close();
  }
});

test('G4-2: 点の画面に「意味の近い点（別の本から）」が最大 5 件出て、1 回押すとリンクになる（両側に出る。押したものは「リンク済み」）', async () => {
  const { pointView } = await import('../web/js/views/point.js');
  const lib = sampleLibrary();
  const ps = Object.values(lib.highlights).sort((a, b) => a.id.localeCompare(b.id));
  const id = ps[0].id;
  const near = ps.filter((h) => h.bookId !== ps[0].bookId).slice(0, 8).map((h) => h.id);
  // 届いた分析が 8 件持っていても、画面は 5 件まで（消えた点は飛ばして、近い順に）
  updateHighlight(lib, near[1], { deleted: true });
  const state = { library: lib, analysis: tinyAnalysis([{ id: 'l1', name: '線A', highlightIds: ps.map((h) => h.id) }], { neighbors: { [id]: near } }), loaded: true };
  const page = String(pointView.render({ state, params: { id } }));
  assert.match(page, /<h2>意味の近い点（別の本から）<\/h2><span class="small muted">5<\/span>/);
  assert.equal(count(page, /data-action="link-quick"/g), NEIGHBORS_MAX);
  assert.deepEqual([...page.matchAll(/data-action="link-quick" data-from="[^"]+" data-to="([^"]+)"/g)].map((m) => m[1]), [near[0], near[2], near[3], near[4], near[5]]);
  const { actions, log } = await fakeLinkActions(state);
  await actions['link-quick']({ dataset: { from: id, to: near[0] } });
  assert.ok(linkBetween(lib, id, near[0]), '1 回押すとリンクになる');
  assert.deepEqual([log.persisted, log.synced, log.rendered], [1, 1, 1], '保存して描き直し、PC と同期する');
  const after = String(pointView.render({ state, params: { id } }));
  assert.equal(count(after, /data-action="link-quick"/g), 4);
  assert.match(after, /<span class="small muted">リンク済み<\/span>/);
  assert.match(after, /<h2>リンク<\/h2><span class="small muted">1<\/span>/);
  const other = String(pointView.render({ state, params: { id: near[0] } }));
  assert.match(other, /<h2>リンク<\/h2><span class="small muted">1<\/span>/);
  assert.match(other, new RegExp(`<a class="link-target" href="#/point/${id}">`), '相手の点の画面にも出る');
  // 分析が無いときは出さない。前の版の分析（意味の近い点が無い）は分析し直すよう案内し、
  // 分析にあってもその点の分が無い（別の本の点が無い・分析のあとに増えた点）ときは、そう伝える
  assert.doesNotMatch(String(pointView.render({ state: { ...state, analysis: null }, params: { id } })), /意味の近い点/);
  assert.match(String(pointView.render({ state: { ...state, analysis: tinyAnalysis([{ id: 'l1', name: '線A', highlightIds: [id] }]) }, params: { id } })), /分析し直すと、意味の近い点（別の本から）が出ます/);
  const without = String(pointView.render({ state, params: { id: near[0] } }));
  assert.match(without, /この点には、まだ意味の近い点がありません/);
  assert.doesNotMatch(without, /分析し直すと/);
});

test('G4-3: 「十分近い」の基準: 自分の線を除いていちばん近い線に、その線の点の中心への近さの中央値以上に近い点は、その線の「関わる点」（最大 12 件・近い順）', () => {
  // 4 次元。線 1・2・3 の中心はそれぞれ 1・2・3 番目の軸。線 2・3 は点が散らばっていて、中心への近さの中央値はちょうど 0.5
  const v = (...xs) => Float32Array.from(xs);
  const r = Math.sqrt(0.75);
  const rest = (...xs) => Math.sqrt(1 - xs.reduce((s, x) => s + x * x, 0));
  const ids = ['h1both', 'h1edge', 'h1below', 'h1core', 'h1three', 'h2a', 'h2b', 'h2c', 'h3a', 'h3b', 'h3c'];
  const vectors = [
    v(rest(0.6, 0.55), 0.6, 0.55, 0), // 線 1。線 2（0.6）・線 3（0.55）のどちらの中央値も超えるが、近い方の線 2 だけ
    v(r, 0.5, 0, 0), // 線 1。線 2 の中心への近さがちょうど中央値 → 入る
    v(rest(0.49), 0.49, 0, 0), // 線 1。中央値を下回る → 入らない
    v(1, 0, 0, 0), // 線 1。どの線にも近くない
    v(rest(0.55, 0.6), 0.55, 0.6, 0), // 線 1。線 3 の方が近い → 線 3 だけ
    v(0, 1, 0, 0),
    v(0, 0.5, 0, r),
    v(0, 0.5, 0, -r),
    v(0, 0, 1, 0),
    v(0, 0, 0.5, r),
    v(0, 0, 0.5, -r),
  ];
  const axis = (k) => v(...[0, 1, 2, 3].map((i) => (i === k ? 1 : 0)));
  const lines = [
    { id: 'l1', members: [0, 1, 2, 3, 4], centroid: axis(0) },
    { id: 'l2', members: [5, 6, 7], centroid: axis(1) },
    { id: 'l3', members: [8, 9, 10], centroid: axis(2) },
  ];
  assert.equal(lineMedian(vectors, lines[1].members, lines[1].centroid), 0.5, '線 2 の基準は中央値 0.5');
  const { related } = nearPoints({ ids, vectors, lines, isolated: [], sourceOf: (i) => ids[i] });
  assert.deepEqual(related.get('l2'), ['h1both', 'h1edge'], '近い順。中央値ちょうどは入り、下回れば入らない');
  assert.deepEqual(related.get('l3'), ['h1three'], '2 番目に近い線にだけ入る');
  assert.deepEqual(related.get('l1'), [], '線 1 の中央値（0.87）に届くほかの線の点は無い');
  // 点の数が偶数なら、真ん中の 2 つの低い方。点の無い線には誰も入らない
  const four = [0.2, 0.4, 0.6, 0.8].map((y) => v(rest(y), y));
  assert.equal(lineMedian(four, [3, 0, 2, 1], v(0, 1)), Math.fround(0.4));
  assert.equal(lineMedian(four, [], v(0, 1)), Infinity);
  // 1 本の線に最大 12 件（近い順）
  const many = Array.from({ length: 15 }, (_, k) => v(rest(0.55 + k * 0.01), 0.55 + k * 0.01, 0, 0));
  const manyIds = many.map((_, k) => `hm${String(k).padStart(2, '0')}`);
  const big = nearPoints({
    ids: [...manyIds, 'h2a', 'h2b', 'h2c'],
    vectors: [...many, vectors[5], vectors[6], vectors[7]],
    lines: [
      { id: 'l1', members: many.map((_, k) => k), centroid: axis(0) },
      { id: 'l2', members: [15, 16, 17], centroid: axis(1) },
    ],
    isolated: [],
    sourceOf: (i) => String(i),
  });
  assert.equal(RELATED_MAX, 12);
  assert.deepEqual(big.related.get('l2'), Array.from({ length: 12 }, (_, j) => `hm${String(14 - j).padStart(2, '0')}`));
});

test('G4-3: 関わる点は、その線の画面に「関わる点（ほかの線から）」として出て、点の画面には入っている線と関わる線の両方が出る', async () => {
  const { lineView } = await import('../web/js/views/knowledge.js');
  const { pointView } = await import('../web/js/views/point.js');
  const lib = sampleLibrary();
  const [h1, h2, h3, h4] = pointsFromBooks(lib, 4);
  const analysis = tinyAnalysis([
    { id: 'l1', name: '線A', highlightIds: [h1.id, h2.id] },
    { id: 'l2', name: '線B', highlightIds: [h3.id, h4.id], relatedIds: [h1.id, 'hgone1'] },
  ]);
  assert.equal(analysisShapeError(analysis), '');
  const state = { library: lib, analysis, loaded: true };
  const line = String(lineView.render({ state, params: { id: 'l2' } }));
  assert.match(line, /<h2>関わる点（ほかの線から）<\/h2><span class="small muted">1<\/span>/, '消えた点は出さない');
  assert.match(line, new RegExp(`data-hl="${h1.id}"`));
  assert.match(line, /href="#\/knowledge\/line\/l1">線A<\/a>/, '関わる点がどの線に入っているかも出る');
  assert.doesNotMatch(String(lineView.render({ state, params: { id: 'l1' } })), /関わる点（ほかの線から）/);
  const point = String(pointView.render({ state, params: { id: h1.id } }));
  assert.match(point, /<a class="line-chip" href="#\/knowledge\/line\/l1">線A<\/a>/, '入っている線');
  assert.match(point, /<h2>関わる線<\/h2>[\s\S]*<a class="line-chip" href="#\/knowledge\/line\/l2">線B<\/a>/, '関わる線');
  assert.doesNotMatch(String(pointView.render({ state, params: { id: h3.id } })), /関わる線/);
});

test('G4-4: リンク先からさらにリンクをたどれる。消えた点・ノートへのリンクは「消えた」と出て、画面は壊れない（外すこともできる）', async () => {
  const { pointView } = await import('../web/js/views/point.js');
  const { noteView } = await import('../web/js/views/notes.js');
  const { linkPickerView } = await import('../web/js/views/links.js');
  const lib = sampleLibrary();
  const [h1, h2, h3] = pointsFromBooks(lib, 3);
  const t1 = addThought(lib, { text: '線と線のあいだの考え' }, T, 't1abc');
  addNote(lib, { title: 'つなぐノート', body: '' }, T, 'n1abc');
  addLink(lib, h1.id, 'n1abc', '', T);
  addLink(lib, 'n1abc', t1.id, '', T);
  addLink(lib, t1.id, h2.id, '', T);
  addLink(lib, h3.id, t1.id, '', T);
  const state = { library: lib, analysis: null, loaded: true };
  const view = (id) => String((id.startsWith('n') ? noteView : pointView).render({ state, params: { id } }));
  const to = (id) => new RegExp(`<a class="link-target" href="#/${id.startsWith('n') ? 'note' : 'point'}/${id}">`);
  // 点 → ノート → メモ → 点 とたどれる（どの画面にも次の相手と、来た道へのリンクがある）
  assert.match(view(h1.id), to('n1abc'));
  assert.match(view('n1abc'), to(t1.id));
  assert.match(view('n1abc'), to(h1.id));
  assert.match(view(t1.id), to(h2.id));
  assert.match(view(t1.id), to('n1abc'));
  // 消えたノート・消えた点
  deleteNote(lib, 'n1abc', T2);
  updateHighlight(lib, h2.id, { deleted: true });
  const p1 = view(h1.id);
  assert.match(p1, /<li class="link-row gone"><span class="link-target"><span class="link-title">（消えたノート）<\/span><\/span>/);
  assert.match(p1, /data-action="link-remove"/, '消えた相手へのリンクも外せる');
  assert.match(view(t1.id), /（消えた点）/);
  assert.match(view('n1abc'), /このノートは見つかりません/);
  assert.match(view(h2.id), /この点は見つかりません/);
  assert.match(String(linkPickerView.render({ state, params: { id: 'n1abc' }, query: new URLSearchParams('q=x') })), /リンクを張る元が見つかりません/);
  // 捨てたメモは消えていない（受け箱から戻せる）ので、そのまま出す
  updateThought(lib, t1.id, { status: 'discarded' }, T3);
  assert.match(view(h3.id), /<span class="link-sub">メモ（思いつき・捨てた）<\/span>/);
  assert.match(view(h3.id), to(t1.id));
  // まだ届いていない（知らない）点へのリンクも壊れない
  addLink(lib, h3.id, 'hunknown1', '', T3);
  assert.match(view(h3.id), /（消えた点）/);
  // Kindle で伸ばしたハイライトは、置き換わった先の点としてたどる（消えたことにしない）
  const k = Object.values(lib.highlights).find((h) => h.source === 'kindle' && h.location != null && ![h1.id, h2.id, h3.id].includes(h.id));
  addLink(lib, h1.id, k.id, '伸ばす前に張った', T3);
  mergeParsed(lib, [{ title: lib.books[k.bookId].title, author: lib.books[k.bookId].author, source: 'kindle', highlights: [{ text: `${k.text}さらに続く文。`, location: k.location }] }], { now: T4 });
  const longer = Object.values(lib.highlights).find((h) => h.text === `${k.text}さらに続く文。`);
  assert.equal(lib.highlights[k.id].supersededBy, longer.id, '伸ばしたハイライトに置き換わった（試験の前提）');
  assert.match(view(h1.id), to(longer.id));
  assert.match(view(longer.id), to(h1.id), '伸ばした点の画面からも、伸ばす前に張ったリンクが見える');
  assert.throws(() => addLink(lib, k.id, longer.id), /同じもの/, '伸ばす前と後の点どうしはリンクできない');
  // 別の端末で伸ばしたあとの点にも張った（同じ相手へのリンクが 2 本）: 画面は 1 つにまとめ、「外す」で両方外れる
  addLink(lib, h1.id, longer.id, '', T4);
  assert.equal(linksFor(lib, h1.id).filter((e) => e.other === longer.id).length, 1, '同じ相手は 1 つにまとめる');
  const { actions } = await fakeLinkActions(state);
  await actions['link-remove']({ dataset: { id: linkBetween(lib, h1.id, longer.id).id } });
  assert.equal(linkBetween(lib, h1.id, longer.id), null, '1 回の「外す」で、伸ばす前に張ったリンクも外れる');
  assert.ok(linksOf(lib)[linkId(h1.id, k.id)].deleted && linksOf(lib)[linkId(h1.id, longer.id)].deleted);
});

test('G4-5: 「面白い」とした遠いつながりは、両方の点の画面にリンクとして出る（共通する考えを理由に。分析の結果から消えても出る。「ちがう」や反応の無いものは出ない）', async () => {
  const { pointView } = await import('../web/js/views/point.js');
  const lib = sampleLibrary();
  const [h1, h2, h3, h4] = pointsFromBooks(lib, 4);
  const far = (x, y, idea) => {
    const [a, b] = [x, y].sort();
    return { id: farId(a, b), a, b, idea, explanation: '説明', foundAt: T };
  };
  const fun = far(h1.id, h2.id, '小さく始める');
  const plain = far(h1.id, h3.id, '反応なし');
  const wrong = far(h1.id, h4.id, 'こじつけ');
  const analysis = tinyAnalysis([{ id: 'l1', name: '線A', highlightIds: [h1.id, h2.id, h3.id, h4.id] }], { farConnections: [fun, plain, wrong] });
  assert.equal(analysisShapeError(analysis), '');
  reactFar(lib, fun, 'interesting', T);
  reactFar(lib, wrong, 'wrong', T);
  const state = { library: lib, analysis, loaded: true };
  const page = (id) => String(pointView.render({ state, params: { id } }));
  const farRow = (other) => new RegExp(`<a class="link-target" href="#/point/${other}">[^\\n]*?<span class="link-reason">理由: 遠いつながり（面白い）・小さく始める</span>`);
  assert.match(page(h1.id), farRow(h2.id));
  assert.match(page(h2.id), farRow(h1.id), '相手の点の画面にも出る');
  assert.doesNotMatch(page(h1.id), /反応なし|こじつけ/);
  assert.match(page(h1.id), /<h2>リンク<\/h2><span class="small muted">1<\/span>/);
  // 分析し直して結果から消えても、「面白い」とした組は出る
  state.analysis = { ...analysis, farConnections: [] };
  assert.match(page(h1.id), farRow(h2.id));
  // 同じ 2 点に自分でもリンクを張ったら、1 つにまとめて出す（自分で張ったリンクを出す）
  addLink(lib, h1.id, h2.id, '自分の理由', T2);
  const both = page(h1.id);
  assert.match(both, /<h2>リンク<\/h2><span class="small muted">1<\/span>/);
  assert.match(both, /理由: 自分の理由/);
  assert.doesNotMatch(both, /遠いつながり（面白い）/);
  // 「面白い」を取り消し、リンクも外すと出ない
  removeLink(lib, linkId(h1.id, h2.id), T3);
  reactFar(lib, fun, 'interesting', T3);
  assert.match(page(h1.id), /まだリンクはありません/);
  // 「面白い」の組でも、相手の点を消したら出さない（遠いつながりの画面と同じ。外せない「消えた点」の行を残さない）
  reactFar(lib, fun, 'interesting', T4);
  assert.match(page(h1.id), farRow(h2.id));
  updateHighlight(lib, h2.id, { deleted: true });
  const gone = page(h1.id);
  assert.match(gone, /まだリンクはありません/);
  assert.doesNotMatch(gone, /消えた点/);
});

test('G4: リンクが多いときは、1 つの画面に新しい順に 50 件まで出し、残りの数を出す。届いた分析の関わる点は重ねず 12 件まで', async () => {
  const { pointView } = await import('../web/js/views/point.js');
  const { lineView } = await import('../web/js/views/knowledge.js');
  const lib = sampleLibrary();
  const [h1] = pointsFromBooks(lib, 1);
  for (let i = 0; i < 55; i++) {
    addNote(lib, { title: `ノート${i}` }, T, `nmany${i}`);
    addLink(lib, h1.id, `nmany${i}`, '', new Date(Date.parse(T) + i * 1000).toISOString());
  }
  const state = { library: lib, analysis: null, loaded: true };
  const page = String(pointView.render({ state, params: { id: h1.id } }));
  assert.match(page, /<h2>リンク<\/h2><span class="small muted">55<\/span>/);
  assert.equal(count(page, /<li class="link-row/g), 50);
  assert.match(page, /ほか 5 件/);
  assert.match(page, /ノート54/, '新しい順');
  assert.doesNotMatch(page, /ノート4</, '古い 5 件は出さない');
  // 関わる点: 重ねず、12 件まで
  const others = Object.values(lib.highlights).filter((h) => h.id !== h1.id).slice(0, 15).map((h) => h.id);
  const analysis = tinyAnalysis([
    { id: 'l1', name: '線A', highlightIds: [h1.id] },
    { id: 'l2', name: '線B', highlightIds: others, relatedIds: [...others, ...others] },
  ]);
  const line = String(lineView.render({ state: { ...state, analysis }, params: { id: 'l2' } }));
  assert.match(line, /<h2>関わる点（ほかの線から）<\/h2><span class="small muted">12<\/span>/);
});

test('G4: 利用者の文（ノートの題・理由）はリンクの画面でそのまま文字として出る（HTML として動かない）。壊れた意味の近い点・関わる点の分析は受け入れない', async () => {
  const { linksBlock, linkPickerView, linkReasonSheet } = await import('../web/js/views/links.js');
  const lib = sampleLibrary();
  const [h1, h2] = pointsFromBooks(lib, 2);
  const evil = '<img src=x onerror=alert(1)>"\'';
  addNote(lib, { title: evil, body: '' }, T, 'n1abc');
  addLink(lib, h1.id, 'n1abc', evil, T);
  const state = { library: lib, analysis: null, loaded: true };
  const outs = [
    String(linksBlock(state, h1.id)),
    String(linksBlock(state, 'n1abc')),
    String(linkPickerView.render({ state, params: { id: 'n1abc' }, query: new URLSearchParams({ q: h2.text.slice(0, 8) }) })),
    String(linkReasonSheet(lib, h1.id, 'n1abc', evil)),
  ];
  for (const out of outs) assert.doesNotMatch(out, /<img/);
  assert.match(outs[0], /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(outs[0], /aria-label="「&lt;img src=x onerror=alert\(1\)&gt;&quot;/, '属性の中でも引用符を閉じさせない');
  assert.match(outs[2], new RegExp(`data-to="${h2.id}"`));
  assert.match(outs[3], /value="&lt;img/);
  // 分析の形の確かめ
  const base = tinyAnalysis([{ id: 'l1', name: '線', highlightIds: [h1.id] }]);
  assert.equal(analysisShapeError({ ...base, neighbors: { [h1.id]: [h2.id] } }), '');
  assert.match(analysisShapeError({ ...base, neighbors: [] }), /neighbors/);
  assert.match(analysisShapeError({ ...base, neighbors: { [h1.id]: h2.id } }), /neighbors/);
  assert.match(analysisShapeError({ ...base, neighbors: { [h1.id]: [7] } }), /neighbors/);
  assert.match(analysisShapeError({ ...base, lines: [{ ...base.lines[0], relatedIds: h2.id }] }), /relatedIds/);
  assert.match(analysisShapeError({ ...base, lines: [{ ...base.lines[0], relatedIds: [{}] }] }), /relatedIds/);
  // 同期で届いた点の ID が入れ物の名前（constructor など）でも、意味の近い点の欄は壊れない（継承した値を読まない）
  const { pointView } = await import('../web/js/views/point.js');
  lib.highlights.constructor = { ...h1, id: 'constructor' };
  const odd = String(pointView.render({ state: { library: lib, analysis: { ...base, neighbors: {} }, loaded: true }, params: { id: 'constructor' } }));
  assert.match(odd, /この点には、まだ意味の近い点がありません/);
});

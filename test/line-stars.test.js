// #73 線(グループ)にも★をつけ外しでき、★の点と線(グループ)を見返す専用ページがある
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLibrary, mergeLibraries, mergeParsed, updateHighlight } from '../web/core/model.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { isLineStarred, starredLines, toggleLineStar } from '../web/core/line-stars.js';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

function sample() {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS);
  return lib;
}

function analysisOf(lib, lines = [{ id: 'l1', name: '仕組みの線' }, { id: 'l2', name: '注意の線' }]) {
  const [a, b, c, d] = Object.keys(lib.highlights);
  return {
    version: 2,
    createdAt: T1,
    model: { chat: 'fake', embed: 'fake-embed' },
    stats: { points: 48 },
    lines: lines.map((l, i) => ({ ...l, summary: `${l.name}の要約`, insight: '', keywords: [], highlightIds: i ? [c, d] : [a, b], bookIds: [] })),
    planes: [{ id: 'p1', name: '面', summary: '要約', lineIds: lines.map((l) => l.id) }],
    solid: { title: '核', core: '', relations: [], principles: [], questions: [] },
    isolated: [],
    recommendations: [],
  };
}

const st = (library, analysis) => ({ library, analysis, loaded: true, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null, job: null });

test('#73: 線(グループ)に★をつけ外しできる', () => {
  const lib = emptyLibrary();
  const on = toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T1);
  assert.equal(on, true);
  assert.equal(isLineStarred(lib, 'l1'), true);
  assert.ok(lib.updatedAt >= T1, '同期で届くよう、ライブラリの更新時刻を進める');
  assert.equal(toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T2), false);
  assert.equal(isLineStarred(lib, 'l1'), false);
  assert.throws(() => toggleLineStar(lib, { id: '../x', name: 'x' }, T2), /線\(グループ\)/);
});

test('#73: ★は同期・バックアップで残る（新しい方。向きに依らない。壊れた値は捨てる）', () => {
  const pc = emptyLibrary();
  const phone = emptyLibrary();
  toggleLineStar(phone, { id: 'l1', name: '仕組みの線' }, T2);
  const merged = mergeLibraries(pc, phone);
  assert.equal(isLineStarred(merged, 'l1'), true);
  toggleLineStar(merged, { id: 'l1', name: '仕組みの線' }, T3);
  assert.equal(isLineStarred(mergeLibraries(merged, phone), 'l1'), false, '外した方が新しい');
  assert.equal(isLineStarred(mergeLibraries(phone, merged), 'l1'), false);
  const broken = JSON.parse('{"lineStars":{"__proto__":{"id":"l1","starred":true},"l1":{"starred":"yes","updatedAt":"2026-10-09T00:00:00.000Z"},"../x":{"id":"../x","starred":true}}}');
  const m2 = mergeLibraries(phone, { ...emptyLibrary(), ...broken });
  assert.equal(isLineStarred(m2, 'l1'), true, '手元の★が残る');
  assert.deepEqual(Object.keys(m2.lineStars), ['l1']);
});

test('#73: 分析をやり直して線(グループ)が作り直されたら、★は引き継がず「無くなった」として分かる', () => {
  const lib = sample();
  toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T1);
  const now = starredLines(lib, analysisOf(lib));
  assert.deepEqual(now.present.map((l) => l.id), ['l1']);
  assert.deepEqual(now.missing, []);
  // 増分の分析（線の ID は変わらない）: 名前が変わっても★は残る
  const renamed = starredLines(lib, analysisOf(lib, [{ id: 'l1', name: '仕組みの線（育った）' }]));
  assert.deepEqual(renamed.present.map((l) => l.name), ['仕組みの線（育った）']);
  // 最初から作り直した（ID が変わった）
  const rebuilt = starredLines(lib, analysisOf(lib, [{ id: 'l9', name: '新しい線' }]));
  assert.deepEqual(rebuilt.present, []);
  assert.deepEqual(rebuilt.missing.map((m) => m.name), ['仕組みの線']);
});

test('#73: 分析に無い線(グループ)の★を外しても（名前を渡さなくても）、★をつけたときの名前は消えない。外したら「無くなった」一覧からも消える', () => {
  const lib = sample();
  toggleLineStar(lib, { id: 'lgone', name: '消えた線' }, T1);
  const a = analysisOf(lib);
  assert.deepEqual(starredLines(lib, a).missing.map((m) => m.name), ['消えた線']);
  // ★のページの「★を外す」は、分析に無い線を { id, name: '' } で渡す（app.js の line-star）
  assert.equal(toggleLineStar(lib, { id: 'lgone', name: '' }, T2), false);
  assert.equal(lib.lineStars.lgone.name, '消えた線');
  assert.deepEqual(starredLines(lib, a).missing, []);
});

test('#73: 分析がまだ届いていない端末で★のページを開くと、線(グループ)の★があることを伝える（「まだ★はありません」と言わない）', async () => {
  const { starsView } = await import('../web/js/views/stars.js');
  const lib = emptyLibrary();
  toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T1);
  const out = String(starsView.render({ state: st(lib, null) }));
  assert.doesNotMatch(out, /まだ★はありません/);
  assert.match(out, /★をつけた線\(グループ\)が 1 あります。この端末に分析の結果が届くと出ます/);
});

test('#73: 線(グループ)の画面に★のつけ外しボタン。線(グループ)の一覧に★の印', async () => {
  const { lineView } = await import('../web/js/views/knowledge.js');
  const { linesView } = await import('../web/js/views/layers.js');
  const lib = sample();
  const a = analysisOf(lib);
  assert.match(String(lineView.render({ state: st(lib, a), params: { id: 'l1' } })), /data-action="line-star" data-id="l1" aria-pressed="false"[^>]*>☆ ★をつける<\/button>/);
  toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T1);
  assert.match(String(lineView.render({ state: st(lib, a), params: { id: 'l1' } })), /data-action="line-star" data-id="l1" aria-pressed="true"[^>]*>★ ★を外す<\/button>/);
  assert.match(String(linesView.render({ state: st(lib, a) })), /<b>★ 仕組みの線<\/b>/);
});

test('#73: ★のページに★の線(グループ)と★の点が分かれて並ぶ。無くなった線(グループ)も出て外せる', async () => {
  const { starsView } = await import('../web/js/views/stars.js');
  const lib = sample();
  const [h] = Object.values(lib.highlights);
  updateHighlight(lib, h.id, { favorite: true });
  toggleLineStar(lib, { id: 'l1', name: '仕組みの線' }, T1);
  toggleLineStar(lib, { id: 'lgone', name: '<消えた線>' }, T1);
  const out = String(starsView.render({ state: st(lib, analysisOf(lib)) }));
  assert.match(out, /<h1>★<\/h1>/);
  assert.match(out, /<h2>★の線\(グループ\)<\/h2><span class="small muted">1<\/span>/);
  assert.match(out, /href="#\/knowledge\/line\/l1"/);
  assert.match(out, /<h2>★の点<\/h2><span class="small muted">1<\/span>/);
  assert.ok(out.includes(`data-hl="${h.id}"`));
  assert.match(out, /分析し直して無くなった線\(グループ\)/);
  assert.match(out, /&lt;消えた線&gt;/);
  assert.match(out, /data-action="line-star" data-id="lgone"/);
});

test('#73: ★が 0 件のとき、★のページに付け方の説明が出る', async () => {
  const { starsView } = await import('../web/js/views/stars.js');
  const out = String(starsView.render({ state: st(sample(), null) }));
  assert.match(out, /まだ★はありません/);
  assert.match(out, /点のカードの ☆/);
  assert.match(out, /線\(グループ\)の画面の「☆ ★をつける」/);
});

test('#73: ★のページへホームから移れる。ルートと操作がある', async () => {
  const { home } = await import('../web/js/views/library.js');
  const lib = sample();
  assert.match(String(home.render({ state: st(lib, analysisOf(lib)), shuffle: 0 })), /<a href="#\/stars">★ \d+<\/a>/);
  const app = readFileSync(join(WEB, 'js/app.js'), 'utf8');
  assert.ok(app.includes("[/^\\/stars$/, starsView, '"));
  const action = app.match(/async 'line-star'\(el\) \{([\s\S]*?)\n  \},/)[1];
  assert.match(action, /toggleLineStar\(state\.library,[\s\S]*?await persistLibrary\(\);[\s\S]*?autoSyncAfterChange\(\);/);
});

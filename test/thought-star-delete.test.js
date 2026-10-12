// NIH-285 受け箱のメモ（思いつき）にも、点のカードと同じく ★ と × を付ける
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, libraryStats, mergeLibraries, mergeParsed } from '../web/core/model.js';
import { addThought, normalizeThought, updateThought } from '../web/core/thoughts.js';
import { searchPoints } from '../web/core/points.js';
import { analyzeLibrary } from '../web/core/analysis/pipeline.js';
import { l2normalize } from '../web/core/analysis/vectors.js';
import { SAMPLE_BOOKS } from '../web/core/sample.js';
import { button, fakeApp } from './helpers/app-actions.js';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';

function state(library = emptyLibrary(), analysis = null) {
  return { library, analysis, loaded: true, settings: { ai: { mode: 'direct', companionUrl: '' } }, servedByCompanion: false, pcInfo: null };
}

test('メモに★を付け・外せる。何も変わらなければ時刻を進めない', () => {
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '思いつき' }, T1);
  assert.equal(t.favorite, undefined, '書いたばかりのメモは★なし（古い形のデータと同じ）');
  const on = updateThought(lib, t.id, { favorite: true }, T2);
  assert.equal(on.favorite, true);
  assert.equal(on.favoriteAt, T2);
  assert.equal(on.updatedAt, T2);
  assert.equal(updateThought(lib, t.id, { favorite: true }, T3).updatedAt, T2, '同じ★を押し直しても時刻は進めない');
  const off = updateThought(lib, t.id, { favorite: false }, T3);
  assert.equal(off.favorite, false);
  assert.equal(off.favoriteAt, T3);
});

test('C3: ★と本文の書き直しが別の端末で重なっても、両方が残る（どちら向きに統合しても同じ）', () => {
  const pc = emptyLibrary();
  addThought(pc, { text: '元の文' }, T1, 'tf');
  const phone = structuredClone(pc);
  updateThought(phone, 'tf', { favorite: true }, T2); // スマホで★
  updateThought(pc, 'tf', { text: 'PC で直した文' }, T3); // あとから PC で本文だけ直す
  for (const m of [mergeLibraries(pc, phone), mergeLibraries(phone, pc)]) {
    assert.equal(m.thoughts.tf.text, 'PC で直した文');
    assert.equal(m.thoughts.tf.favorite, true);
  }
  assert.deepEqual(mergeLibraries(pc, phone), mergeLibraries(phone, pc));
  // 外した★も、あとから付けた側に負けない限り外れたまま届く
  const a = mergeLibraries(pc, phone);
  const b = structuredClone(a);
  updateThought(b, 'tf', { favorite: false }, '2026-10-04T00:00:00.000Z');
  assert.equal(mergeLibraries(a, b).thoughts.tf.favorite, false);
});

test('C2: ★の無い古い形のメモはそのまま読め、外から来た★は true だけを信じる', () => {
  const old = normalizeThought({ id: 'told', text: '古いメモ', status: 'inbox', createdAt: T1, updatedAt: T1 });
  assert.equal('favorite' in old, false);
  assert.equal('favoriteAt' in old, false);
  assert.equal(normalizeThought({ id: 'tx', text: 'x', favorite: 'yes', favoriteAt: T2, createdAt: T1, updatedAt: T2 }).favorite, false);
  const ok = normalizeThought({ id: 'ty', text: 'y', favorite: true, favoriteAt: T2, createdAt: T1, updatedAt: T2 });
  assert.equal(ok.favorite, true);
  assert.equal(ok.favoriteAt, T2);
});

test('★のメモは★の画面・★の絞り込み・ホームの★の件数に出る（捨てたメモは出さない）', async () => {
  const lib = emptyLibrary();
  mergeParsed(lib, SAMPLE_BOOKS, { now: T1 });
  const fav = addThought(lib, { text: '★を付けた思いつき' }, T1);
  const plain = addThought(lib, { text: '★の無い思いつき' }, T1);
  const gone = addThought(lib, { text: '★を付けて捨てた思いつき' }, T1);
  updateThought(lib, fav.id, { favorite: true }, T2);
  updateThought(lib, gone.id, { favorite: true, status: 'discarded' }, T2);
  const ids = searchPoints(lib, '', { favorite: true }).map((p) => p.id);
  assert.ok(ids.includes(fav.id));
  assert.ok(!ids.includes(plain.id));
  assert.ok(!ids.includes(gone.id));
  assert.equal(libraryStats(lib).favorites, 1);
  const { starsView } = await import('../web/js/views/stars.js');
  const out = String(starsView.render({ state: state(lib) }));
  assert.match(out, /★を付けた思いつき/);
  assert.doesNotMatch(out, /★の無い思いつき/);
});

test('メモのカードに ☆/★ と × がある（受け箱・メモの一覧）', async () => {
  const { thoughtCard } = await import('../web/js/ui.js');
  const lib = emptyLibrary();
  const t = addThought(lib, { text: '思いつき' }, T1);
  const card = String(thoughtCard(t, { moves: true }));
  assert.match(card, new RegExp(`<button class="icon-btn " data-action="thought-fav" data-id="${t.id}" aria-pressed="false" aria-label="お気に入り">☆</button>`));
  assert.match(card, new RegExp(`<button class="icon-btn" data-action="thought-delete" data-id="${t.id}" aria-label="メモを削除" title="メモを削除">×</button>`));
  const starred = String(thoughtCard(updateThought(lib, t.id, { favorite: true }, T2)));
  assert.match(starred, /class="icon-btn on" data-action="thought-fav"[^>]*aria-pressed="true"[^>]*>★</);
});

test('★のボタン: 押すと★が付き、端末に保存してから同期する。もう一度押すと外れる', async () => {
  const st = state();
  const t = addThought(st.library, { text: '思いつき' }, T1);
  const app = fakeApp(st);
  const el = button({ id: t.id });
  await app.actions['thought-fav'](el);
  assert.equal(st.library.thoughts[t.id].favorite, true);
  assert.equal(el.textContent, '★');
  assert.deepEqual(app.log, ['persist', 'sync']);
  await app.actions['thought-fav'](el);
  assert.equal(st.library.thoughts[t.id].favorite, false);
  assert.equal(el.textContent, '☆');
});

test('× のボタン: 確かめてから消す（墓標は同期で生き返らず「元に戻す」が効かないため）。断ったら何もしない', async () => {
  const st = state();
  const t = addThought(st.library, { text: '書いた思いつき' }, T1);
  const asked = [];
  let answer = false;
  const app = fakeApp(st, { confirm: (m) => (asked.push(m), answer) });
  await app.actions['thought-delete'](button({ id: t.id }));
  assert.match(asked[0], /このメモを削除しますか？/);
  assert.equal(st.library.thoughts[t.id].text, '書いた思いつき');
  assert.deepEqual(app.log, []);
  answer = true;
  await app.actions['thought-delete'](button({ id: t.id }));
  assert.equal(st.library.thoughts[t.id].deleted, true);
  assert.deepEqual(app.log, ['persist', 'toast', 'render', 'sync']);
  // 消えたメモ（別の端末で消して同期で届いた）は何もしない
  await app.actions['thought-delete'](button({ id: t.id }));
  assert.equal(asked.length, 2);
});

test('G2-2: ★のメモは、線を作る AI への入力に優先して入る（点の★と同じ）', async () => {
  const texts = Array.from({ length: 20 }, (_, i) => `似た考え その${i + 1}`);
  const order = new Map(texts.map((t, i) => [t, i]));
  const vecFor = (t) => {
    const i = order.get(t.split('\n')[0]);
    return l2normalize(Float32Array.from(i === undefined ? [0, 0, 1, 0] : [1, i * 0.01, 0, 0]));
  };
  const linePromptOf = async (favorite) => {
    const lib = emptyLibrary();
    for (const text of texts) {
      const t = addThought(lib, { text }, T1);
      if (text === favorite) updateThought(lib, t.id, { favorite: true }, T2);
    }
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
  assert.doesNotMatch(await linePromptOf(null), /似た考え その18\n/, '★が無ければ中心から遠いメモは入らない');
  assert.match(await linePromptOf('似た考え その18'), /似た考え その18\n/, '★のメモが優先して入る');
});

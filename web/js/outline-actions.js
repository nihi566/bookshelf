// 文章の骨組みの操作（作る・直す・Markdown をコピー・消す）。PC への依頼・シート・保存・同期・画面の移動・コピーは引数で受け取る
// （app.js がブラウザの物を渡す。テストからは偽物を渡して確かめる）
import { randomId } from '../core/text.js';
import { addOutline, deleteOutline, outlinesOf, updateOutline } from '../core/outlines.js';
import { PICKS_MAX, cleanPicks, outlineMarkdown, unavailableQuotes } from '../core/outline-draft.js';
import { outlineSheet, readOutlineSheet } from './views/outlines.js';

// 作る画面（作り終えたとき、まだこの画面にいれば作った骨組みを開く）
const NEW_PATH = '/outline/new';

// 比べるときの形（1 行にして前後の空白を落とす）
const flat = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const sectionsKey = (sections) => JSON.stringify(sections.map((s) => ({ heading: flat(s.heading), points: s.points.map(flat).filter(Boolean), quotes: s.quotes })));

/** 直すシートで変えた欄だけ（題・節）。開いている間に同期で届いた別の端末の直しを、変えていない欄で負かさない */
function changedFields(edit, o) {
  return {
    ...(flat(edit.title) !== o.title ? { title: edit.title } : {}),
    ...(sectionsKey(edit.sections) !== sectionsKey(o.sections) ? { sections: edit.sections } : {}),
  };
}

/**
 * @param {object} deps
 * @param {{ library: object, loaded: boolean, outlineDraft?: object }} deps.state state.outlineDraft に作っている間・失敗を置く
 * @param {(picks: object[]) => Promise<object>} deps.generate PC に骨組みを作らせる（保存前の下書きが返る）
 * @param {(content: unknown, onSubmit: (data: FormData, action: string) => Promise<boolean|void>) => void} deps.openSheet
 * @param {(message: string, ms?: number) => void} deps.toast
 * @param {() => Promise<void>} deps.persist 端末に保存する
 * @param {() => void} deps.sync 変えたあとに PC と同期する
 * @param {() => void} deps.render 作っている間・失敗の欄を描き直す
 * @param {(opts?: object) => void} deps.renderPage 今の画面を描き直す
 * @param {(hash: string) => void} deps.go 画面を移る
 * @param {() => string} deps.here 今の画面の場所（'/outline/new' など）
 * @param {(message: string) => boolean} deps.confirm
 * @param {(text: string) => Promise<void>} deps.copy クリップボードに書く
 */
export function outlineActions({ state, generate, openSheet, toast, persist, sync, render, renderPage, go, here, confirm, copy }) {
  const live = (id) => {
    const all = outlinesOf(state.library);
    return Object.hasOwn(all, id) && !all[id].deleted ? all[id] : null;
  };
  const fail = (mine, message) => {
    if (state.outlineDraft !== mine) return;
    state.outlineDraft = { status: 'error', error: message };
    render();
    // 作る画面を離れていたら、作る画面の欄は見えないので知らせる（PC の文がすでに「骨組みを作れませんでした」で始まるなら重ねない）
    if (here() !== NEW_PATH) toast(message.startsWith('骨組みを作れませんでした') ? message : `骨組みを作れませんでした: ${message}`, 6000);
  };
  return {
    /** 選んだ材料で骨組みを作って保存する（作っている間に押し直しても 2 つ作らない）。まだ作る画面にいれば開く */
    async create(rawPicks) {
      // 選べるのは 8 つまで（黙って先頭だけで作らない）
      if (Array.isArray(rawPicks) && rawPicks.length > PICKS_MAX) return toast(`材料は ${PICKS_MAX} つまで選べます（いま ${rawPicks.length} つ）`);
      const picks = cleanPicks(rawPicks);
      if (!picks.length) return toast('面・線・永久ノートを 1 つ以上選んでください');
      if (!state.loaded) return toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
      if (state.outlineDraft?.status === 'pending') return;
      const mine = { status: 'pending' };
      state.outlineDraft = mine;
      render();
      let o;
      try {
        const draft = await generate(picks);
        if (state.outlineDraft !== mine) return;
        o = addOutline(state.library, draft, new Date().toISOString(), randomId('o'));
      } catch (e) {
        // PC の bh serve が古いと、骨組みを作る窓口が無い
        return fail(mine, e.status === 404 ? 'PC の bh serve が古いため、骨組みを作れません。PC で更新して、bh serve を起動し直してください' : e.message);
      }
      // 作っている間の表示は、保存の成否によらず消す（押せないままにしない。押し直して 2 つ作らせない）
      state.outlineDraft = null;
      render();
      let saved = true;
      try {
        await persist();
      } catch (e) {
        saved = false;
        toast(`骨組みは作れましたが、この端末に保存できませんでした（${e.message}）。PC と同期できれば PC に残ります`, 6000);
      }
      if (here() === NEW_PATH) {
        if (saved) toast('骨組みを作りました（直して使えます）');
        go(`#/outline/${o.id}`);
      } else if (saved) toast('骨組みを作りました。知識の画面の「文章の骨組み」から開けます', 5000);
      sync();
    },
    'outline-edit'(el) {
      const o = live(el.dataset.id);
      if (!o) return;
      openSheet(outlineSheet(state.library, o), async (data) => {
        const patch = changedFields(readOutlineSheet(data, o), o);
        if (!Object.keys(patch).length) return;
        updateOutline(state.library, o.id, patch);
        await persist();
        toast('保存しました');
        renderPage({ keepScroll: true });
        sync();
      });
    },
    async 'outline-copy'(el) {
      const o = live(el.dataset.id);
      if (!o) return;
      await copy(outlineMarkdown(state.library, o));
      const left = unavailableQuotes(state.library, o);
      toast(left ? `Markdown をコピーしました（消えた点・この端末にまだ無い点の引用 ${left} 件は入れていません）` : 'Markdown をコピーしました', left ? 5000 : undefined);
    },
    async 'outline-delete'(el) {
      const o = live(el.dataset.id);
      if (!o || !confirm('この骨組みを削除しますか？（材料の面・線・ノート・点は消えません）')) return;
      deleteOutline(state.library, o.id);
      await persist();
      toast('骨組みを削除しました');
      go('#/outlines');
      sync();
    },
  };
}

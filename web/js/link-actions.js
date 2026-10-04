// リンクの操作（張る・理由を書く・外す）。画面の部品・保存・同期・画面の移動は引数で受け取る
// （app.js がブラウザの物を渡す。テストからは偽物を渡して確かめる）
import { addLink, linksOf, removeLinksBetween } from '../core/links.js';
import { endView, linkReasonSheet } from './views/links.js';

/**
 * @param {object} deps
 * @param {{ library: object, loaded: boolean }} deps.state
 * @param {(content: unknown, onSubmit: (data: FormData, action: string) => Promise<boolean|void>) => void} deps.openSheet
 * @param {(message: string, ms?: number) => void} deps.toast
 * @param {() => Promise<void>} deps.persist 端末に保存する
 * @param {() => void} deps.sync 変えたあとに PC と同期する
 * @param {(opts?: object) => void} deps.render 今の画面を描き直す
 * @param {(hash: string) => void} deps.go 画面を移る
 * @param {(message: string) => boolean} deps.confirm
 */
export function linkActions({ state, openSheet, toast, persist, sync, render, go, confirm }) {
  const notLoaded = () => {
    if (state.loaded) return false;
    toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
    return true;
  };
  const linkOf = (id) => {
    const all = linksOf(state.library);
    return Object.hasOwn(all, id) && !all[id].deleted ? all[id] : null;
  };
  return {
    // 意味の近い点を 1 回の操作でリンクにする（理由はあとから書ける）
    async 'link-quick'(el) {
      if (notLoaded()) return;
      addLink(state.library, el.dataset.from, el.dataset.to);
      await persist();
      toast('リンクしました（「理由」で 1 行添えられます）');
      render({ keepScroll: true });
      sync();
    },
    // 選んだ相手とリンクする（理由を 1 行添えられる）。張ったら元の画面へ戻る
    'link-to'(el) {
      if (notLoaded()) return;
      const { from, to } = el.dataset;
      openSheet(linkReasonSheet(state.library, from, to), async (data) => {
        addLink(state.library, from, to, String(data.get('reason') || ''));
        await persist();
        toast('リンクしました');
        go(endView(state.library, from).href || '#/');
        sync();
      });
    },
    'link-reason'(el) {
      const l = linkOf(el.dataset.id);
      if (!l) return;
      openSheet(linkReasonSheet(state.library, l.a, l.b, l.reason), async (data) => {
        addLink(state.library, l.a, l.b, String(data.get('reason') || ''));
        await persist();
        toast('理由を保存しました');
        render({ keepScroll: true });
        sync();
      });
    },
    async 'link-remove'(el) {
      const l = linkOf(el.dataset.id);
      if (!l || !confirm('このリンクを外しますか？（リンクした点やノートは消えません。理由は消えます）')) return;
      // 同じ 2 つの間のリンクはまとめて外す（別の端末で、Kindle で伸ばす前と後の点に張ったリンクが残らないように）
      removeLinksBetween(state.library, l.a, l.b);
      await persist();
      toast('リンクを外しました');
      render({ keepScroll: true });
      sync();
    },
  };
}

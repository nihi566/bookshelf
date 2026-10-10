// 画面のボタンの操作のうち、本・点・思いつき・線(グループ)・反応のデータを変えるもの。
// 画面の部品・保存・同期・画面の移動は引数で受け取る（app.js がブラウザの物を渡す。テストからは偽物を渡して確かめる）
import { highlightEditSheet } from './ui.js';
import { TECHNICAL_VALUES, editBookSheet, registerBookSheet } from './views/library.js';
import { editThoughtSheet, lineSheet, newThoughtSheet } from './views/thoughts.js';
import { toggleLineStar } from '../core/line-stars.js';
import { markDiscoveryRead } from '../core/discovery-reads.js';
import { FAR_REACTIONS, farConnectionById, reactFar } from '../core/far-reactions.js';
import { assignThoughtToLine, lineAssignmentOf, unassignThought } from '../core/line-assignments.js';
import { FEEDBACK_LABELS, deleteBook, mergeParsed, registerBook, setFeedback, updateBook, updateHighlight } from '../core/model.js';
import { THOUGHT_STATUS, addThought, deleteThought, thoughtsOf, updateThought } from '../core/thoughts.js';
import { isThought, pointById } from '../core/points.js';
import { randomId } from '../core/text.js';
import { SAMPLE_BOOKS } from '../core/sample.js';

const NOT_LOADED = 'まだ端末のデータを読み込んでいます。少し待ってから押してください';

/**
 * @param {object} deps
 * @param {{ library: object, analysis: object|null, loaded: boolean, job: object|null }} deps.state
 * @param {(content: unknown, onSubmit: (data: FormData, action: string) => Promise<boolean|void>) => void} deps.openSheet
 * @param {(message: string, ms?: number, action?: { label: string, run: () => unknown }) => void} deps.toast
 * @param {() => Promise<void>} deps.persist 端末にライブラリを保存する
 * @param {() => Promise<void>} deps.saveAnalysis 端末に分析を保存する
 * @param {() => void} deps.sync 変えたあとに PC と同期する
 * @param {(opts?: object) => void} deps.render 今の画面を描き直す
 * @param {() => void} deps.refreshThoughts 思いつきを出している画面だけ描き直す
 * @param {(hash: string) => void} deps.go 画面を移る
 * @param {(message: string) => boolean} deps.confirm
 * @param {(file: File|null) => Promise<string>} deps.coverDataUrl 選んだ表紙の画像を縮めた data URL にする
 * @param {() => { writeText(text: string): Promise<void> }|undefined} deps.clipboard 使えない画面では undefined
 * @param {(id: string) => Promise<object>} deps.restoreHistory PC の過去の分析をいまの分析に戻す
 * @param {(id: string, pinned: boolean) => Promise<unknown>} deps.pinHistory PC の過去の分析に「この回を残す」の印を付け外しする
 */
export function appActions({ state, openSheet, toast, persist, saveAnalysis, sync, render, refreshThoughts, go, confirm, coverDataUrl, clipboard, restoreHistory, pinHistory }) {
  const notLoaded = () => {
    if (state.loaded) return false;
    toast(NOT_LOADED);
    return true;
  };

  /** 削除した点を戻す（削除は印を付けるだけなので、印を外せばメモ・タグ・★ごと戻る） */
  async function undoDeleteHighlight(id) {
    if (!updateHighlight(state.library, id, { deleted: false })) throw new Error('この点はもう見つかりません（同期で消えた可能性があります）');
    await persist();
    render({ keepScroll: true });
    sync();
    toast('元に戻しました');
  }

  /** 発見を開いたら既読にする（端末に保存し、PC と同期してほかの端末でも既読にする） */
  async function readDiscovery(id) {
    if (!state.loaded || !markDiscoveryRead(state.library, id)) return;
    try {
      await persist();
      sync();
    } catch (e) {
      toast(e.message, 4000);
    }
  }

  const actions = {
    // 失敗したら例外のままシートに出す（シートの上ではトーストが隠れて見えない）
    'register-book'() {
      openSheet(registerBookSheet(), async (data) => {
        const b = registerBook(state.library, {
          title: data.get('title'),
          author: data.get('author'),
          cover: await coverDataUrl(data.get('cover')),
          technical: TECHNICAL_VALUES[data.get('technical')] ?? undefined,
        });
        await persist();
        toast(`『${b.title}』を登録しました。線を引いた文を足せます`);
        go(`#/book/${b.id}`);
        sync();
      });
    },
    'edit-book'(el) {
      const b = state.library.books[el.dataset.id];
      openSheet(editBookSheet(b), async (data) => {
        // 変えた欄だけを送る（変えていない表紙・技術書の編集時刻を進めて、別の端末の編集を負かさない）
        const patch = { author: data.get('author') };
        const technical = TECHNICAL_VALUES[data.get('technical')] ?? null;
        if (technical !== (typeof b.technical === 'boolean' ? b.technical : null)) patch.technical = technical;
        const cover = await coverDataUrl(data.get('cover'));
        if (cover) patch.cover = cover;
        else if (data.get('removeCover')) patch.cover = '';
        updateBook(state.library, b.id, patch);
        await persist();
        toast('保存しました');
        render({ keepScroll: true });
        sync();
      });
    },
    async fav(el) {
      const h = updateHighlight(state.library, el.dataset.id, { favorite: !state.library.highlights[el.dataset.id].favorite });
      await persist();
      el.classList.toggle('on', h.favorite);
      el.textContent = h.favorite ? '★' : '☆';
      el.setAttribute('aria-pressed', String(h.favorite));
      sync();
    },
    edit(el) {
      const h = state.library.highlights[el.dataset.id];
      openSheet(highlightEditSheet(h), async (data, action) => {
        if (action === 'delete') {
          updateHighlight(state.library, h.id, { deleted: true });
        } else {
          // 文が空なら例外のままシートに出す（書いた内容はシートに残る）
          updateHighlight(state.library, h.id, { text: String(data.get('text') || ''), userNote: String(data.get('userNote') || '').trim(), tags: String(data.get('tags') || '').split(/[\s,、]+/) });
        }
        await persist();
        // 保存できてから知らせる。確認なしの 1 押しで消えるので、押し間違えてもすぐ戻せるようにする
        if (action === 'delete') toast('削除しました', 6000, { label: '元に戻す', run: () => undoDeleteHighlight(h.id) });
        render({ keepScroll: true });
        sync();
      });
    },
    'restore-original-text'(el) {
      // 文の欄に取り込んだときの文を入れるだけ（保存は利用者が「保存」を押す。やめれば何も変わらない）
      const original = state.library.highlights[el.dataset.id]?.originalText;
      const field = el.closest('form')?.elements.text;
      if (typeof original !== 'string' || !field) return;
      field.value = original;
      field.focus();
    },
    // 編集を開かずに 1 回で消す（編集シートの「この点を削除」と同じ処理。押し間違えてもトーストから戻せる）
    async delete(el) {
      const id = el.dataset.id;
      if (!state.library.highlights[id]) return;
      updateHighlight(state.library, id, { deleted: true });
      await persist();
      toast('削除しました', 6000, { label: '元に戻す', run: () => undoDeleteHighlight(id) });
      render({ keepScroll: true });
      sync();
    },
    // 削除した点の画面（#/trash）から戻す。通知の「元に戻す」と同じ処理
    'restore-highlight'(el) {
      return undoDeleteHighlight(el.dataset.id);
    },
    async copy(el) {
      const h = pointById(state.library, el.dataset.id);
      if (!h) return;
      // http の LAN アドレスなど、安全でない画面ではクリップボードを使えない
      const board = clipboard();
      if (!board) return toast('この画面ではコピーできません（https か localhost で開いてください）', 4000);
      const b = state.library.books[h.bookId];
      await board.writeText(isThought(h) || !b ? h.text : `${h.text}\n— ${b.title}${b.author ? `（${b.author}）` : ''}`);
      toast('コピーしました');
    },
    // ---- 思いつき（フリートノート） ----
    'new-thought'() {
      if (notLoaded()) return;
      // ID はシートを開いたときに 1 回だけ作る（保存に失敗して押し直しても、同じメモが 2 件にならない）
      const id = randomId('t');
      openSheet(newThoughtSheet(), async (data) => {
        // 失敗したら例外のままシートに出す（書いた文はシートに残る）
        addThought(state.library, { text: data.get('text') }, undefined, id);
        // 端末に先に保存する（PC とつながっていなくても消えない。つながったときに同期する）
        await persist();
        toast('受け箱に入れました');
        refreshThoughts();
        sync();
      });
    },
    'edit-thought'(el) {
      const t = thoughtsOf(state.library)[el.dataset.id];
      if (!t || t.deleted) return;
      openSheet(editThoughtSheet(t), async (data, action) => {
        // 消したメモは本文の無い墓標になり、同期しても生き返らない（「元に戻す」は効かない）ので、消す前に確かめる。
        // 断ったらシートを開いたままにする（書きかけの文を失わない）
        if (action === 'delete') {
          if (!confirm('このメモを削除しますか？（書いた文は戻せません）')) return true;
          deleteThought(state.library, t.id);
        }
        // 本文が変わっていなければ updateThought は何もしない（別の端末の新しい編集を負かさない）
        else updateThought(state.library, t.id, { text: data.get('text') });
        await persist();
        toast(action === 'delete' ? '削除しました' : '保存しました');
        render({ keepScroll: true });
        sync();
      });
    },
    async 'thought-status'(el) {
      const t = updateThought(state.library, el.dataset.id, { status: el.dataset.status });
      await persist();
      toast(`「${THOUGHT_STATUS[t.status]}」にしました`);
      render({ keepScroll: true });
      sync();
    },
    // 思いつきを、自分で選んだ線(グループ)に入れる（分析を待たずに整理する。分析し直しても外れない）
    'thought-to-line'(el) {
      if (notLoaded()) return;
      const t = thoughtsOf(state.library)[el.dataset.id];
      if (!t || t.deleted) return;
      const lines = state.analysis?.lines || [];
      if (!lines.length) return toast('線(グループ)がまだありません。知識の画面で分析すると選べます', 4000);
      openSheet(lineSheet(t, lines), async (data) => {
        // シートを開いている間に分析が差し替わっていたら、今の分析から引き直す（無い線(グループ)には入れない）
        const line = (state.analysis?.lines || []).find((l) => l.id === data.get('line'));
        if (!line) throw new Error('選んだ線(グループ)が、分析し直して無くなりました。もう一度選んでください');
        assignThoughtToLine(state.library, t.id, line);
        await persist();
        toast(`線(グループ)「${line.name}」に入れました`);
        render({ keepScroll: true });
        sync();
      });
    },
    // 線(グループ)の★（★のページの「無くなった線(グループ)」からも外せるよう、分析に無い線は★をつけたときの名前で外す）
    async 'line-star'(el) {
      if (notLoaded()) return;
      const line = (state.analysis?.lines || []).find((l) => l.id === el.dataset.id) || { id: el.dataset.id, name: '' };
      const on = toggleLineStar(state.library, line);
      await persist();
      toast(on ? '★をつけました（★の一覧はホームの「★」から）' : '★を外しました');
      render({ keepScroll: true });
      sync();
    },
    async 'thought-unline'(el) {
      // ほかの端末の同期で先に外れていたら、何もしない
      if (!lineAssignmentOf(state.library, el.dataset.id)) return render({ keepScroll: true });
      unassignThought(state.library, el.dataset.id);
      await persist();
      toast('線(グループ)から外しました');
      render({ keepScroll: true });
      sync();
    },
    async 'delete-book'(el) {
      const b = state.library.books[el.dataset.id];
      if (!confirm(`『${b.title}』とその点をすべて削除しますか？`)) return;
      deleteBook(state.library, b.id);
      await persist();
      go('#/books');
      toast('削除しました');
      sync();
    },
    async 'load-sample'() {
      const stats = mergeParsed(state.library, SAMPLE_BOOKS);
      await persist();
      toast(`サンプルを入れました（点 ${stats.added} 件）`);
      go('#/');
      render();
    },
    // 過去の分析に戻す（NIH-7。PC がその回を今の分析として保存し、手元の分析も差し替える）
    async 'restore-analysis'(el) {
      if (state.job?.running) return toast('分析の最中です。終わってから押してください');
      if (!confirm('この分析に戻しますか？ 知識の画面の線(グループ)・面・立体が、この回のものになります（今の分析も履歴に残っているので、あとで戻せます）')) return;
      el.disabled = true;
      try {
        state.analysis = await restoreHistory(el.dataset.id);
        await saveAnalysis();
      } finally {
        el.disabled = false;
      }
      toast('この分析に戻しました');
      go('#/knowledge');
    },
    // 履歴の回に「この回を残す」の印を付け外しする（NIH-102。PC の履歴の一覧に印を持つ）
    async 'pin-history'(el) {
      const pinned = el.dataset.pinned !== 'true';
      el.disabled = true;
      try {
        await pinHistory(el.dataset.id, pinned);
      } catch (e) {
        el.disabled = false;
        return toast(e.message);
      }
      toast(pinned ? 'この回を残します。直近 12 回を過ぎても消えません' : '残すのをやめました。直近 12 回を過ぎると消えます');
      render({ keepScroll: true });
    },
    async 'rec-feedback'(el) {
      const r = state.analysis?.recommendations?.[Number(el.dataset.i)];
      if (!r) return;
      const f = setFeedback(state.library, { title: r.title, author: r.author }, el.dataset.status);
      await persist();
      toast(f.status ? `「${r.title}」を「${FEEDBACK_LABELS[f.status]}」にしました。次のおすすめに反映します` : '反応を外しました');
      render({ keepScroll: true });
      sync();
    },
    // 遠いつながりへの反応（面白い: 残り続ける / ちがう: もう出さない）。「ちがう」とした組は画面に無いので、反応の記録からも探す
    async 'far-react'(el) {
      if (notLoaded()) return;
      const f = farConnectionById(state.analysis, state.library, el.dataset.id);
      if (!f || !Object.hasOwn(FAR_REACTIONS, el.dataset.status)) return;
      const r = reactFar(state.library, f, el.dataset.status);
      await persist();
      toast(r.status === 'wrong' ? '「ちがう」にしました。この組はもう出しません（すべての遠いつながりの画面で取り消せます）' : r.status === 'interesting' ? '「面白い」にしました。分析し直しても残ります' : '反応を外しました');
      render({ keepScroll: true });
      sync();
    },
  };

  return { actions, readDiscovery };
}

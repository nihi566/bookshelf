// 問いかけるの操作（質問を PC に送る・答えをメモにする）。PC への問い合わせ・保存・同期・描き直しは引数で受け取る
// （app.js がブラウザの物を渡す。テストからは偽物を渡して確かめる）
import { addThought } from '../core/thoughts.js';
import { randomId } from '../core/text.js';
import { answerMemoText, cleanQuery } from '../core/ask.js';

/**
 * @param {object} deps
 * @param {{ library: object, loaded: boolean, ask?: object }} deps.state state.ask に今の問いかけ（質問・状態・答え）を置く
 * @param {(question: string) => Promise<object>} deps.ask PC に問いかける
 * @param {() => Promise<void>} deps.persist 端末に保存する
 * @param {() => void} deps.sync 変えたあとに PC と同期する
 * @param {() => void} deps.render 今の画面を描き直す
 * @param {(message: string, ms?: number) => void} deps.toast
 */
export function askActions({ state, ask, persist, sync, render, toast }) {
  return {
    /** 質問を送る。待っている間に別の質問を送ったら、古い答えで上書きしない */
    async submit(raw) {
      const question = cleanQuery(raw);
      if (!question) return toast('質問を入れてください');
      if (state.ask?.status === 'pending') return;
      const mine = { question, status: 'pending' };
      state.ask = mine;
      render();
      let next;
      try {
        // メモにするときの ID は答えが届いたときに 1 回だけ作る（保存を押し直しても 2 件にならないように）
        next = { question, status: 'done', result: await ask(question), memoId: randomId('t') };
      } catch (e) {
        next = { question, status: 'error', error: e.message };
      }
      if (state.ask !== mine) return;
      state.ask = next;
      render();
    },
    /** 答えを受け箱のメモにする（根拠の書名と位置を添える。次の分析で点になる） */
    async save() {
      const a = state.ask;
      if (a?.status !== 'done' || !a.result?.answerable || a.savedId) return;
      if (!state.loaded) return toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
      addThought(state.library, { text: answerMemoText(state.library, a.result), answerTo: { kind: 'ask', question: a.result.question } }, new Date().toISOString(), a.memoId);
      await persist();
      a.savedId = a.memoId;
      toast('受け箱のメモに保存しました（次の分析で点になります）');
      render();
      sync();
    },
  };
}

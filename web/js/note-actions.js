// 永久ノートの操作（書く・直す・消す・線やメモから作る・点を根拠にする）。
// 画面の部品・保存・同期・画面の移動は引数で受け取る（app.js がブラウザの物を渡す。テストからは偽物を渡して確かめる）
import { addNote, addNotePoint, deleteNote, noteDraftFromLine, noteFromThought, notesOf, updateNote } from '../core/notes.js';
import { pointById } from '../core/points.js';
import { randomId } from '../core/text.js';
import { citeSheet, noteSheet } from './views/notes.js';

/** 入力欄の文を、比べるために整える（ブラウザによって改行が \r\n で届く） */
const tidy = (v) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * @param {object} deps
 * @param {{ library: object, analysis: object|null, loaded: boolean }} deps.state
 * @param {(content: unknown, onSubmit: (data: FormData, action: string) => Promise<boolean|void>) => void} deps.openSheet
 * @param {(message: string, ms?: number) => void} deps.toast
 * @param {() => Promise<void>} deps.persist 端末に保存する
 * @param {() => void} deps.sync 変えたあとに PC と同期する
 * @param {(opts?: object) => void} deps.render 今の画面を描き直す
 * @param {(hash: string) => void} deps.go 画面を移る
 * @param {(message: string) => boolean} deps.confirm
 * @param {(fn: () => void) => void} [deps.later] シートが閉じてから次のシートを開く
 */
export function noteActions({ state, openSheet, toast, persist, sync, render, go, confirm, later = (fn) => setTimeout(fn) }) {
  const notLoaded = () => {
    if (state.loaded) return false;
    toast('まだ端末のデータを読み込んでいます。少し待ってから押してください');
    return true;
  };
  // 押すだけで作る操作は、終わるまで押し直しを受け付けない（連打で同じノートが 2 件にならないように）
  const running = new Set();
  const once = (key, fn) => async (el) => {
    if (running.has(key)) return;
    running.add(key);
    try {
      await fn(el);
    } finally {
      running.delete(key);
    }
  };
  const actions = {
    // 書く（点のページからは、その点を根拠にして書く）
    'new-note'(el) {
      if (notLoaded()) return;
      // ID はシートを開いたときに 1 回だけ作る（保存に失敗して押し直しても、同じノートが 2 件にならない）
      const id = randomId('n');
      const pointIds = el.dataset.point ? [el.dataset.point] : [];
      openSheet(noteSheet(state.library, null, pointIds), async (data) => {
        addNote(state.library, { title: data.get('title'), body: data.get('body'), pointIds: data.getAll('point') }, undefined, id);
        await persist();
        toast('永久ノートを保存しました');
        go(`#/note/${id}`);
        sync();
      });
    },
    'edit-note'(el) {
      const all = notesOf(state.library);
      const n = Object.hasOwn(all, el.dataset.id) ? all[el.dataset.id] : null;
      if (!n || n.deleted) return;
      // 開いたときの値。変えた欄だけを保存する（開いている間に同期で届いた別の端末の編集を、触っていない欄で負かさない）
      const opened = { title: n.title, body: n.body, pointIds: [...n.pointIds] };
      openSheet(noteSheet(state.library, n), async (data, action) => {
        if (action === 'delete') {
          if (!confirm('この永久ノートを削除しますか？（根拠の点は消えません）')) return true;
          deleteNote(state.library, n.id);
          await persist();
          toast('削除しました');
          go('#/notes');
          sync();
          return;
        }
        const patch = {};
        if (tidy(data.get('title')) !== tidy(opened.title)) patch.title = data.get('title');
        if (tidy(data.get('body')) !== tidy(opened.body)) patch.body = data.get('body');
        // 根拠の点の欄はノートに根拠があるときだけ出る（無いときは触らない）
        const kept = data.getAll('point');
        if (opened.pointIds.length && kept.join('|') !== opened.pointIds.join('|')) patch.pointIds = kept;
        // 何も変わっていなければ updateNote は何もしない（時刻を進めない）
        updateNote(state.library, n.id, patch);
        await persist();
        toast('保存しました');
        render({ keepScroll: true });
        sync();
      });
    },
    // 線を下書きにして永久ノートを作る（1 回の操作。作ったノートを開いて、自分の言葉に直す）
    'line-to-note': once('line-to-note', async (el) => {
      if (notLoaded()) return;
      const line = (state.analysis?.lines || []).find((l) => l.id === el.dataset.id);
      if (!line) return;
      // 古い分析に残る、消えた点は根拠に写さない
      const n = addNote(state.library, noteDraftFromLine(line, (id) => Boolean(pointById(state.library, id))));
      await persist();
      toast('線(グループ)を下書きにした永久ノートを作りました。自分の言葉に直しましょう', 4000);
      go(`#/note/${n.id}`);
      sync();
    }),
    // 受け箱のメモを永久ノートにする（メモは整理済みにして、根拠に残す）
    'thought-to-note': once('thought-to-note', async (el) => {
      if (notLoaded()) return;
      const n = noteFromThought(state.library, el.dataset.id);
      await persist();
      toast('永久ノートにしました（メモは整理済みにしました）', 4000);
      go(`#/note/${n.id}`);
      sync();
    }),
    // 点を、ほかの永久ノートの根拠にする（「新しいノートを書く」なら、その点を根拠にして書く）
    'cite-point'(el) {
      const p = pointById(state.library, el.dataset.id);
      if (!p) return;
      openSheet(citeSheet(state.library, p), async (data, action) => {
        if (action === 'new') {
          // シートが閉じてから、書くシートを開く（開いたままのシートには次のシートを重ねられない）
          later(() => {
            try {
              actions['new-note']({ dataset: { point: p.id } });
            } catch (e) {
              toast(e.message, 5000);
            }
          });
          return;
        }
        addNotePoint(state.library, String(data.get('note') || ''), p.id);
        await persist();
        toast('永久ノートの根拠にしました');
        render({ keepScroll: true });
        sync();
      });
    },
  };
  return actions;
}

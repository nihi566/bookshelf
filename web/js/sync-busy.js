// 同期している間は「同期する」「今すぐ同期」を押せなくし、「同期しています」と出す（NIH-141）。
// 押してから結果のトーストが出るまで画面が変わらず、続けて押すと同期が二重に走っていたため。
// DOM に頼らない（Node のテストから import して呼べる）。画面にあるボタンは applySyncBusy に渡された root から探す
import { html } from './html.js';

export const SYNC_BUSY_LABEL = '同期しています';

/** 同期が 1 つでも走っているか（自動同期と押した同期が重なることがあるので数で持つ） */
export const isSyncing = (state) => (state.syncing || 0) > 0;

/**
 * 同期 run を走らせ、その間だけ state.syncing を数える。始まりと終わり（成功・失敗のどちらでも）に onChange を呼ぶ。
 * run の結果・失敗はそのまま返す
 */
export async function trackSync(state, run, onChange) {
  state.syncing = (state.syncing || 0) + 1;
  try {
    onChange();
    return await run();
  } finally {
    state.syncing -= 1;
    onChange();
  }
}

/** 同期のボタン。同期中は押せず「同期しています」で描く（元の文字は data-label に持ち、終わったら戻す） */
export function syncButton(state, label, cls = 'btn') {
  return isSyncing(state)
    ? html`<button type="button" class="${cls}" data-action="sync" data-label="${label}" disabled aria-busy="true">${SYNC_BUSY_LABEL}</button>`
    : html`<button type="button" class="${cls}" data-action="sync" data-label="${label}">${label}</button>`;
}

/** 画面にある同期のボタンを、描き直さずに同期中 / 元の形へ差し替える */
export function applySyncBusy(root, busy) {
  for (const btn of root.querySelectorAll('[data-action="sync"]')) {
    btn.disabled = busy;
    btn.textContent = busy ? SYNC_BUSY_LABEL : btn.dataset.label || btn.textContent;
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
  }
}

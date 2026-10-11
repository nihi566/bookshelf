// 同期している間は「同期する」「今すぐ同期」を押せなくし、「同期しています」と出す（NIH-141）。
// 押してから結果のトーストが出るまで画面が変わらず、続けて押すと同期が二重に走っていたため。
// DOM に頼らない（Node のテストから import して呼べる）。画面にあるボタンは applySyncBusy に渡された root から探す
import { html } from './html.js';
import { isoDate } from '../core/text.js';

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

// ---- 最後の同期の結果（NIH-146） ----
// 押した同期の失敗はトースト（5 秒）でしか出ず、自動同期の失敗はどこにも出なかったため、設定の「今すぐ同期」の横に残す

/** 同期の結果を覚える。失敗なら時刻と理由（同期の処理が出したメッセージ）、成功（error が無い）なら消す。保存はしない */
export function recordSyncResult(state, error, now = new Date()) {
  state.lastSyncError = error ? { at: now.toISOString(), message: error.message || '理由の分からないエラー' } : null;
}

const when = (iso) => `${isoDate(iso)} ${new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;

/**
 * 「今すぐ同期」の横の表示: 最後に成功した同期と、そのあと失敗していれば失敗の時刻と理由。
 * 失敗より後に成功した同期があれば失敗は出さない（入力中の自動同期など、recordSyncResult を通らずに成功する同期もあるため）
 */
export function syncStatus(state) {
  const failed = state.lastSyncError;
  const err = failed && !(Date.parse(state.lastSync ?? '') >= Date.parse(failed.at)) ? failed : null;
  return html`<span class="small muted" data-sync-status>${state.lastSync ? `最終: ${when(state.lastSync)}` : '未同期'}${err ? html`<br><span class="warn-text">失敗: ${when(err.at)} — ${err.message}</span>` : ''}</span>`;
}

/** 画面にある同期の表示を、描き直さずに今の状態へ差し替える（設定を開いたまま自動同期が失敗したときのため） */
export function applySyncStatus(root, state) {
  for (const box of root.querySelectorAll('[data-sync-status]')) box.outerHTML = String(syncStatus(state));
}

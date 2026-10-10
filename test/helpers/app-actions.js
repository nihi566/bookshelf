// 画面の操作（web/js/app-actions.js）を、ブラウザ無しで呼ぶための偽物の部品。
// 呼ばれた順を log に残すので、「端末に保存してから同期する」のような順番を確かめられる
import { appActions } from '../../web/js/app-actions.js';

/**
 * @param {object} state 画面の状態（library・analysis・loaded など）
 * @param {object} [overrides] 差し替えたい部品（confirm・clipboard・restoreHistory など）
 */
export function fakeApp(state, overrides = {}) {
  const log = [];
  const sheets = [];
  const toasts = [];
  const deps = {
    state,
    openSheet: (content, onSubmit) => {
      log.push('openSheet');
      sheets.push({ content: String(content), onSubmit });
    },
    toast: (message, ms, action) => {
      log.push('toast');
      toasts.push({ message, ms, action });
    },
    persist: async () => {
      log.push('persist');
    },
    saveAnalysis: async () => {
      log.push('saveAnalysis');
    },
    sync: () => log.push('sync'),
    render: () => log.push('render'),
    refreshThoughts: () => log.push('refreshThoughts'),
    go: (hash) => log.push(`go ${hash}`),
    confirm: () => true,
    coverDataUrl: async () => '',
    clipboard: () => undefined,
    restoreHistory: async () => {
      throw new Error('restoreHistory を差し替えていません');
    },
    ...overrides,
  };
  const { actions, readDiscovery } = appActions(deps);
  return { actions, readDiscovery, log, sheets, toasts };
}

/** シートの入力（FormData の代わり。get だけ使う） */
export const formData = (fields) => ({ get: (name) => fields[name] ?? null });

/** data-* を持つボタン（★のように見た目を変える操作のため、class・文字・属性も受け取れる） */
export function button(dataset) {
  const classes = new Set();
  return {
    dataset,
    disabled: false,
    textContent: '',
    attributes: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    closest: () => null,
  };
}

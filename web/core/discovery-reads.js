// 発見の既読（どの端末で読んでも、ほかの端末でも既読になる。いちど読んだら戻らない）
//
// library.discoveryReads = { [発見の ID]: 読んだ時刻 }。古い版のデータには無いので readsOf() を通して読む

import { isDiscovery } from './analysis/discoveries.js';

const DISCOVERY_ID = /^d[0-9a-z]{1,40}$/;

/** 分析結果の発見のうち、画面に出せる形のもの（形の壊れた分析が届いても画面を落とさない） */
export function discoveriesOf(analysis) {
  return (Array.isArray(analysis?.discoveries) ? analysis.discoveries : []).filter(isDiscovery);
}

export function readsOf(library) {
  const r = library?.discoveryReads;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}

/** その発見を読んだか */
export function isRead(library, id) {
  return Object.hasOwn(readsOf(library), id);
}

/** 発見を既読にする（既に読んでいれば何もしない）。変えたら true */
export function markDiscoveryRead(library, id, now = new Date().toISOString()) {
  if (!DISCOVERY_ID.test(String(id)) || isRead(library, id)) return false;
  library.discoveryReads = { ...readsOf(library), [id]: now };
  library.updatedAt = now;
  return true;
}

/** 2 つの端末の既読をまとめる（どちらかで読んでいれば既読。時刻は早い方。向きに依らない） */
export function mergeReads(a, b) {
  const out = {};
  for (const reads of [a, b]) {
    for (const [id, at] of Object.entries(reads && typeof reads === 'object' ? reads : {})) {
      if (!DISCOVERY_ID.test(id) || typeof at !== 'string' || !at) continue;
      if (!Object.hasOwn(out, id) || at < out[id]) out[id] = at;
    }
  }
  return out;
}

/** まだ読んでいない発見（分析に並んでいる順 = 新しい順） */
export function unreadDiscoveries(analysis, library) {
  return discoveriesOf(analysis).filter((d) => !isRead(library, d.id));
}

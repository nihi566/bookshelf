// 利用者が作る項目（思いつきなど）の集まりを、端末どうしの同期・バックアップの取り込みで統合する
//
// 項目は { id, updatedAt, deleted?, ... }。どちら向きに統合しても同じ結果になるよう、
// 時刻が同じときは内容の並びで勝ち負けを決める。

/** 新しい方（updatedAt が同じなら内容で決める） */
export function newerItem(a, b) {
  const sa = a.updatedAt || '';
  const sb = b.updatedAt || '';
  if (sa !== sb) return sa > sb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/**
 * 2 つの集まり（{ [id]: item }）を統合した新しい集まりを返す。引数は変えない。
 * stickyDelete: 片方でも消していれば消えたまま（消したものは同期・バックアップで戻らない）。
 *   ID を新しく作る項目（思いつきなど）に使う。同じ組から ID が決まる項目（リンクなど）は張り直せるよう使わない
 * normalize: 外から来た項目の形を整える関数（形が壊れていれば null を返して捨てる）
 * mergeItem: 両方にある項目の統合（既定は新しい方）。向きに依らない結果を返すこと
 */
export function mergeCollections(base, incoming, { stickyDelete = false, normalize = (x) => x, mergeItem = newerItem } = {}) {
  const out = {};
  // __proto__ を鍵にすると、入れ物の継承元を書き換えてしまう
  const take = (id, item) => (id !== '__proto__' && item && typeof item === 'object' && !Array.isArray(item) ? normalize({ ...structuredClone(item), id }) || null : null);
  for (const [id, item] of Object.entries(base || {})) {
    const v = take(id, item);
    if (v) out[id] = v;
  }
  for (const [id, item] of Object.entries(incoming || {})) {
    const v = take(id, item);
    if (!v) continue;
    // toString など、入れ物の継承した名前を項目と取り違えない
    const cur = Object.hasOwn(out, id) ? out[id] : null;
    if (!cur) {
      out[id] = v;
      continue;
    }
    if (stickyDelete && (cur.deleted || v.deleted)) {
      out[id] = cur.deleted && v.deleted ? newerItem(cur, v) : cur.deleted ? cur : v;
      continue;
    }
    out[id] = mergeItem(cur, v);
  }
  return out;
}

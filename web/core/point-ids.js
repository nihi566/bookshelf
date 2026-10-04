// 点の ID の小さな道具（ほかのモジュールを読まない。model.js・notes.js・points.js のどこからでも使えるように）

// 点の ID（ハイライトは 'h'、思いつきは 't' で始まる）
const POINT_ID = /^[ht][0-9a-z]{1,40}$/;

export const isPointId = (v) => typeof v === 'string' && POINT_ID.test(v);

/**
 * 今の点の ID。Kindle で伸ばしたハイライトに置き換わった点（supersededBy）は、置き換わった先を 10 回までたどる。
 * 置き換わっていない点・置き換え先の無い点はそこで止まり、たどり着いた ID を返す（その点が消えていれば、呼ぶ側で「消えた点」になる）
 */
export function currentPointId(library, id) {
  let cur = id;
  for (let i = 0; i < 10; i++) {
    const h = Object.hasOwn(library?.highlights || {}, cur) ? library.highlights[cur] : null;
    if (!h?.deleted || !h.supersededBy) return cur;
    cur = h.supersededBy;
  }
  return cur;
}

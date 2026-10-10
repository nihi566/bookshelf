// 前回の分析から何が変わったか（増えた線・大きくなった線・消えた線・新しくつながった点）

/**
 * 前回の分析（prev）と今回の分析（next）の差。前回が無ければ null。
 * 線は ID で比べる（増分の分析では、続いている線の ID は変わらない）
 * @param {(id: string) => string[]} [formerIdsOf]  その点に置き換わる前の点の ID（Kindle で伸ばしたハイライト）。
 *   伸ばしただけの点を「大きくなった線」「新しくつながった点」と数えないため
 * @returns {{ previousAt: string, addedLines: {id,name,size}[], grownLines: {id,name,added}[], removedLines: {id,name,size}[], connectedPoints: {pointId,lineId}[] } | null}
 */
export function diffAnalyses(prev, next, formerIdsOf = () => []) {
  if (!prev?.lines) return null;
  const prevLines = new Map(prev.lines.map((l) => [l.id, l]));
  const nextIds = new Set((next.lines || []).map((l) => l.id));
  const prevMember = new Set(prev.lines.flatMap((l) => l.highlightIds || []));
  // 点の ID と、その点に置き換わる前の ID のどれかが前回にあれば、前回からいた点とみなす
  const wasIn = (set, id) => set.has(id) || formerIdsOf(id).some((x) => set.has(x));
  const addedLines = [];
  const grownLines = [];
  const connectedPoints = [];
  for (const l of next.lines || []) {
    const before = prevLines.get(l.id);
    if (!before) addedLines.push({ id: l.id, name: l.name, size: l.highlightIds.length });
    else {
      const was = new Set(before.highlightIds || []);
      const added = l.highlightIds.filter((id) => !wasIn(was, id)).length;
      if (added > 0) grownLines.push({ id: l.id, name: l.name, added });
    }
    // 前回はどの線にも入っていなかった点（まだつながらない点だった・まだ無かった）が、今回は線に入った
    for (const id of l.highlightIds) if (!wasIn(prevMember, id)) connectedPoints.push({ pointId: id, lineId: l.id });
  }
  const removedLines = prev.lines.filter((l) => !nextIds.has(l.id)).map((l) => ({ id: l.id, name: l.name, size: (l.highlightIds || []).length }));
  return { previousAt: prev.createdAt || '', addedLines, grownLines, removedLines, connectedPoints };
}

/** 変化があったか（画面に「前回から」を出すか） */
export function hasChanges(changes) {
  return Boolean(changes && (changes.addedLines.length || changes.grownLines.length || changes.removedLines.length || changes.connectedPoints.length));
}

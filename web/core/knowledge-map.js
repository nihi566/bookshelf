// 立体（知識の全体像）を図にするための配置

/** 立体の配置（中心=核、周囲=面、その外側=線） */
export function layoutKnowledgeMap(analysis) {
  const nodes = [];
  const edges = [];
  const planes = analysis.planes || [];
  nodes.push({ id: 'core', kind: 'core', x: 0, y: 0, label: analysis.solid?.title || '知識の核' });
  const R1 = 520;
  const R2 = 980;
  const total = Math.max(1, planes.reduce((s, p) => s + Math.max(1, p.lineIds.length), 0));
  let angle = -Math.PI / 2;
  for (const p of planes) {
    const span = (2 * Math.PI * Math.max(1, p.lineIds.length)) / total;
    const mid = angle + span / 2;
    nodes.push({ id: p.id, kind: 'plane', x: Math.cos(mid) * R1, y: Math.sin(mid) * R1, label: p.name, ref: p.id });
    edges.push({ from: 'core', to: p.id, kind: 'core' });
    p.lineIds.forEach((lid, i) => {
      const l = analysis.lines.find((x) => x.id === lid);
      if (!l) return;
      const a = angle + (span * (i + 0.5)) / p.lineIds.length;
      nodes.push({ id: l.id, kind: 'line', x: Math.cos(a) * R2, y: Math.sin(a) * R2, label: l.name, ref: l.id, weight: l.highlightIds.length });
      edges.push({ from: p.id, to: l.id, kind: 'plane' });
    });
    angle += span;
  }
  for (const r of analysis.solid?.relations || []) {
    if (planes.some((p) => p.id === r.from) && planes.some((p) => p.id === r.to)) edges.push({ from: r.from, to: r.to, kind: 'relation', label: r.type || '' });
  }
  return { nodes, edges };
}

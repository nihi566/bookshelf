// 発見の画面: ホームの「発見」（未読の新しい順に 3 件）・発見 1 つ（どの点とどの点が、なぜつながったか）・すべての発見
import { html } from '../html.js';
import { isoDate, truncate } from '../../core/text.js';
import { analysisPointById, isThought, pointLabel } from '../../core/points.js';
import { discoveriesOf, isRead, unreadDiscoveries } from '../../core/discovery-reads.js';
import { farIdOfDiscovery, visibleFarConnections, wrongFarIds } from '../../core/far-reactions.js';
import { lineIndex, pointCard } from '../ui.js';
import { farCard } from './far.js';

// ホームに並べる未読の発見の数（残りは「すべての発見」で見る）
const ON_HOME = 3;

const KIND_LABEL = { cross: '本をまたいだつながり', line: '新しい線', isolated: 'つながった点', far: '遠いつながり' };

/** 「ちがう」とした遠いつながりの発見は出さない */
const shown = (state) => {
  const wrong = wrongFarIds(state.library);
  return (d) => !wrong.has(farIdOfDiscovery(d));
};

/** 点の出どころ（本。思いつきは 1 つずつ別のもの） */
const sourceOf = (p) => (isThought(p) ? p.id : p.bookId);

/** 発見の 1 行（どの点とどの点か・なぜ） */
function discoveryRow(state, d) {
  const [a, b] = d.pointIds.map((id) => analysisPointById(state.library, id));
  const quote = (p) => (p ? `「${truncate(p.text.replace(/\s+/g, ' '), 40)}」（${truncate(pointLabel(state.library, p), 16)}）` : '（消えた点）');
  return html`<li><a class="disc-item ${d.kind === 'far' ? 'far' : ''}" href="#/discovery/${d.id}">
    <span class="disc-kind">${KIND_LABEL[d.kind] || '発見'}${isRead(state.library, d.id) ? '' : html` <span class="badge new">未読</span>`}</span>
    <span class="disc-pair">${quote(a)} ⇄ ${quote(b)}</span>
    <span class="disc-why">${d.kind === 'far' ? '共通する考え' : '線'}「${d.lineName || ''}」</span>
  </a></li>`;
}

/** ホームに出す未読の発見（両側の点が今も見られるものだけ。消した・捨てた点の発見と、「ちがう」とした遠いつながりは数えない） */
export function homeDiscoveries(state) {
  return unreadDiscoveries(state.analysis, state.library).filter(shown(state)).filter((d) => d.pointIds.every((id) => analysisPointById(state.library, id)));
}

/** ホームの「発見」（未読があるときだけ出す） */
export function discoveriesBlock(state) {
  const unread = homeDiscoveries(state);
  if (!unread.length) return '';
  return html`<section class="discoveries" aria-labelledby="disc-title">
    <div class="section"><h2 id="disc-title">発見 <span class="count">${unread.length}</span></h2><a class="small" href="#/discoveries">すべての発見</a></div>
    <p class="help">前に見たあとに、分析で見つかったつながりです。開くと既読になります。</p>
    <ul class="disc-list">${unread.slice(0, ON_HOME).map((d) => discoveryRow(state, d))}</ul>
    ${unread.length > ON_HOME ? html`<p class="small"><a href="#/discoveries">ほか ${unread.length - ON_HOME} 件の未読を見る</a></p>` : ''}
  </section>`;
}

/**
 * 今日の点に添える「つながる別の本の点」: その点の線のうち、別の本（思いつきなら本の点・別の思いつき）の点で、
 * 線の中心にいちばん近いもの。つながる点が無ければ null
 */
export function partnerOf(state, p, idx = lineIndex(state.analysis)) {
  for (const l of idx.get(p.id) || []) {
    for (const id of l.highlightIds) {
      if (id === p.id) continue;
      const q = analysisPointById(state.library, id);
      if (q && sourceOf(q) !== sourceOf(p)) return { point: q, line: l };
    }
  }
  return null;
}

/** 今日の点の下に出す「つながる別の本の点」（idx: 作ってある線の対応表があれば渡す） */
export function partnerBlock(state, p, idx) {
  const m = partnerOf(state, p, idx);
  if (!m) return '';
  return html`<div class="partner">
    <span class="partner-label">つながる別の本の点 ・ <a href="#/knowledge/line/${m.line.id}">線「${m.line.name}」</a></span>
    <p class="partner-text">${truncate(m.point.text.replace(/\s+/g, ' '), 140)}</p>
    <span class="small muted">${pointLabel(state.library, m.point)}</span>
  </div>`;
}

const findDiscovery = (state, id) => discoveriesOf(state.analysis).find((x) => x.id === id);

export const discoveryView = {
  render({ state, params }) {
    const d = findDiscovery(state, params.id);
    if (!d) return html`<a class="back" href="#/">‹ ホーム</a><p class="empty">この発見は見つかりません（分析し直して、つながりの点が消えた可能性があります）。<a href="#/discoveries">すべての発見へ</a></p>`;
    const idx = lineIndex(state.analysis);
    if (d.kind === 'far') {
      // 遠いつながり: 共通する考えと、なぜつながるか（反応もここで付けられる）
      const f = visibleFarConnections(state.analysis, state.library).find((x) => x.id === farIdOfDiscovery(d));
      return html`<a class="back" href="#/">‹ ホーム</a>
        <div class="page-head"><div><h1>${KIND_LABEL.far}</h1><div class="sub">${isoDate(d.foundAt)} の分析で見つかりました</div></div></div>
        <p class="help">別の本・別の面にある 2 つの点を AI が読み、根っこで共通する考えを見つけました。</p>
        ${f ? farCard(state, f, idx) : html`<p class="card small muted">この遠いつながりは「ちがう」としたか、分析し直して消えました。<a href="#/knowledge/far">すべての遠いつながりへ</a></p>`}`;
    }
    const line = (state.analysis.lines || []).find((l) => l.id === d.lineId);
    const points = d.pointIds.map((id) => analysisPointById(state.library, id));
    return html`<a class="back" href="#/">‹ ホーム</a>
      <div class="page-head"><div><h1>${KIND_LABEL[d.kind] || '発見'}</h1><div class="sub">${isoDate(d.foundAt)} の分析で見つかりました</div></div></div>
      <section class="card stack">
        <h2 class="small">なぜつながったか</h2>
        <p>同じ線${line ? html`「<a href="#/knowledge/line/${line.id}">${line.name}</a>」` : `「${d.lineName || ''}」`}に入りました。${line?.summary || d.reason || ''}</p>
      </section>
      <div class="section"><h2>つながった点</h2></div>
      ${points.map((p) => (p ? pointCard(p, { library: state.library, lines: idx.get(p.id) }) : html`<p class="card small muted">この点は消えました。</p>`))}`;
  },
  mount(root, ctx) {
    // 開いたら既読にする（端末の間で同期する）
    if (findDiscovery(ctx.state, ctx.params.id)) ctx.markDiscoveryRead?.(ctx.params.id);
  },
};

export const discoveriesView = {
  render({ state }) {
    const all = discoveriesOf(state.analysis).filter(shown(state));
    const unread = unreadDiscoveries(state.analysis, state.library).filter(shown(state)).length;
    return html`<a class="back" href="#/">‹ ホーム</a>
      <div class="page-head"><div><h1>すべての発見</h1><div class="sub">${all.length} 件（未読 ${unread} 件）</div></div></div>
      <p class="help">分析のたびに、前回からの差で見つかったつながり（本をまたいだつながり・新しい線・つながった点・遠いつながり）です。</p>
      ${all.length ? html`<ul class="disc-list">${all.map((d) => discoveryRow(state, d))}</ul>` : html`<p class="empty">まだ発見はありません。点が増えて分析し直すと見つかります。</p>`}`;
  },
};

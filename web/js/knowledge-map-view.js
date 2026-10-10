// 立体のページの知識マップを描く（Cytoscape.js は大きいので、このページを開いたときだけ読み込む）
import { mapElements, mapPeek, mapPositions, mapStyle } from '../core/knowledge-map.js';
import { isLineStarred } from '../core/line-stars.js';
import { html } from './html.js';

// 全体を枠に収めると点が 2,000 近くあって小さくなるので、ここまで縮められるようにする
const MIN_ZOOM = 0.03;
const MAX_ZOOM = 4;
// 点が少ないと枠いっぱいまで拡大されるので、文字が大きくなりすぎない倍率で止める
const MAX_FIT_ZOOM = 1.5;
// 面の名前は、縮めても画面の上でこの大きさ（px）に見えるようにする（全体を見たときに塊の名前が読めるように）
const PLANE_LABEL_PX = 13;
const PLANE_LABEL_MAX_WIDTH_PX = 140;
const BRIDGE_PX = 1.5;
const ISOLATED_PX = 3;
// 札を出したノードにつながる辺は、全体を見たときも目で追える太さにする
const PEEK_EDGE_PX = 2.5;
const RESIZE_DELAY_MS = 120;
// 札から相手へ移るときの倍率の下限（点が見える大きさ）と、図を動かす時間
const PEER_MIN_ZOOM = 1;
// 札に並べる相手の数の上限（リンクを数百本張った点でも、札が重くならないように）
const PEEK_PEERS_MAX = 30;
const PEER_MOVE_MS = 300;
const PEER_KIND = { far: '遠いつながり', link: 'リンク' };
const WHY_LABEL = { far: '共通する考え', link: 'リンクの理由' };

let cy = null;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 図を出せなかったことを枠の中に書く（読み込み・描画のどちらで失敗しても空の枠のままにしない） */
function showMapError(wrap) {
  const canvas = wrap.querySelector('#knowledge-map');
  if (!canvas?.isConnected) return;
  cy?.destroy();
  cy = null;
  wrap.querySelector('.map-tools').hidden = true;
  const card = wrap.querySelector('.map-peek');
  if (card) card.hidden = true;
  canvas.innerHTML = '<p class="notice err">知識マップを描けませんでした。開き直してください（初めて開くときは通信が要ります）。面と線は上の「面」「線(グループ)」から見られます。</p>';
}

/** wrap（#map-wrap）の中に図を描く。library は自分のリンクと遠いつながりへの反応に使う */
export async function mountKnowledgeMap(wrap, analysis, library) {
  try {
    const cytoscape = (await import('../vendor/cytoscape.esm.min.js')).default;
    draw(cytoscape, wrap, analysis, library);
  } catch {
    showMapError(wrap);
  }
}

const ROUTE = {
  plane: (ref) => `#/knowledge/plane/${encodeURIComponent(ref)}`,
  line: (ref) => `#/knowledge/line/${encodeURIComponent(ref)}`,
  point: (ref) => `#/point/${encodeURIComponent(ref)}`,
};

function draw(cytoscape, wrap, analysis, library) {
  const canvas = wrap.querySelector('#knowledge-map');
  if (!canvas.isConnected) return;
  cy?.destroy();
  // 前の図で出していた札は、描き直した図のノードを指さないので消す
  const card = wrap.querySelector('.map-peek');
  if (card) {
    card.hidden = true;
    card.innerHTML = '';
  }
  const colors = { solid: css('--layer-solid'), plane: css('--layer-plane'), line: css('--layer-line'), point: css('--layer-point'), ink: css('--ink'), surface: css('--surface'), font: css('--font') };
  const els = mapElements(analysis, { library, isStarred: (id) => isLineStarred(library, id) });
  const pos = mapPositions(els);
  const inst = cytoscape({
    container: canvas,
    style: mapStyle(colors),
    elements: [...els.nodes.map((data) => ({ group: 'nodes', data, position: pos[data.id] })), ...els.edges.map((data) => ({ group: 'edges', data }))],
    layout: { name: 'preset', fit: true, padding: 16 },
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    boxSelectionEnabled: false,
    autoungrabify: true,
    // 点が多いので、指で動かしている間は辺を描かない（スマホでも引っかからずに動かせるように）
    hideEdgesOnViewport: true,
  });
  cy = inst;
  if (cy.zoom() > MAX_FIT_ZOOM) cy.zoom(MAX_FIT_ZOOM).center();
  const planes = cy.nodes('[kind = "plane"]');
  const bridges = cy.edges('[kind = "far"], [kind = "link"]');
  const isolated = cy.nodes('[?isolated]');
  const peekCard = wrap.querySelector('.map-peek');
  // 札を出しているノードとそれにつながる辺（無ければ null）
  let peeked = null;
  let timer = 0;
  const resize = () => {
    timer = 0;
    // 描き直したあとに、前の図の予約が残っていても触らない
    if (inst !== cy) return;
    const z = inst.zoom();
    planes.style({ 'font-size': Math.max(16, PLANE_LABEL_PX / z), 'text-max-width': Math.max(160, PLANE_LABEL_MAX_WIDTH_PX / z), 'text-outline-width': Math.max(3, 3 / z) });
    // 塊どうしの橋は、全体を見たときも見える太さにする
    bridges.style('width', Math.max(1, BRIDGE_PX / z));
    // まだつながらない点も、全体を見たときに散らばっているのが見える大きさにする
    const size = Math.max(6, ISOLATED_PX / z);
    isolated.style({ width: size, height: size });
    // 橋の太さより後に決める（札を出した橋は、橋の太さより太く見せる）
    peeked?.edges.style('width', Math.max(2, PEEK_EDGE_PX / z));
  };
  resize();
  // リンクは数千本になり得るので、拡大・縮小の途中では書き換えず、止まってから 1 回だけ直す
  inst.on('zoom', () => {
    clearTimeout(timer);
    timer = setTimeout(resize, RESIZE_DELAY_MS);
  });
  const hidePeek = () => {
    if (!peeked) return;
    peeked.node.removeClass('peek');
    peeked.edges.removeClass('peek').removeStyle('width');
    peeked = null;
    if (peekCard) {
      peekCard.hidden = true;
      peekCard.innerHTML = '';
    }
    // 外した辺のうち橋だったものは、橋の太さに戻す
    resize();
  };
  // 点につながる橋（遠いつながり・リンク）の辺の中身
  const bridgesOf = (node) => node.connectedEdges('[kind = "far"], [kind = "link"]').map((e) => e.data());
  const peekOf = (node, via = null) => mapPeek(node.data(), library, { bridges: bridgesOf(node), via });
  // 札の下に見えるように、相手の点を札より下の真ん中へ寄せる（小さすぎて見えない倍率なら拡大する）
  // 札の高さを測るので、showPeek で札を出した後に呼ぶ
  const moveTo = (node) => {
    const zoom = Math.max(inst.zoom(), PEER_MIN_ZOOM);
    const below = peekCard ? peekCard.getBoundingClientRect().bottom - canvas.getBoundingClientRect().top : 0;
    const y = Math.min(Math.max(inst.height() / 2, (below + inst.height()) / 2), inst.height() - 16);
    const p = node.position();
    inst.stop();
    inst.animate({ zoom, pan: { x: inst.width() / 2 - p.x * zoom, y: y - p.y * zoom } }, { duration: PEER_MOVE_MS });
  };
  const peersHtml = (info) => {
    if (!info.peers?.length) return '';
    const counts = Object.entries(info.counts).filter(([, n]) => n).map(([k, n]) => `${PEER_KIND[k]} ${n}`).join('・');
    // 相手が多いときは、札の中だけを縦に動かして見る（札が図を覆いすぎないように、高さは CSS で抑える）。並べるのは PEEK_PEERS_MAX 件まで
    const rest = info.peers.length - PEEK_PEERS_MAX;
    return html`<div class="map-peek-peers"><span>${counts}</span><div>${info.peers.slice(0, PEEK_PEERS_MAX).map((p, i) => html`<button type="button" class="map-peek-peer" data-peer="${i}"><i>${PEER_KIND[p.kind]}</i>${p.title}</button>`)}${rest > 0 ? html`<span>ほか ${rest} 件</span>` : ''}</div></div>`;
  };
  const showPeek = (node, info) => {
    hidePeek();
    peeked = { node, edges: node.connectedEdges() };
    node.addClass('peek');
    peeked.edges.addClass('peek');
    resize();
    if (!peekCard) return;
    const href = ROUTE[node.data('kind')](node.data('ref'));
    const open = info.kind === 'line' ? '線(グループ)を開く' : '点を開く';
    const why = info.why ? html`<p class="map-peek-why"><i>${WHY_LABEL[info.why.kind]}</i>${info.why.text}</p>` : '';
    peekCard.innerHTML = String(html`<a class="map-peek-go" href="${href}">${info.title ? html`<b>${info.title}</b>` : ''}<span>${info.sub}</span><em>${open} ›</em></a><button type="button" class="map-peek-close" aria-label="閉じる">×</button>${why}${peersHtml(info)}`);
    peekCard.querySelector('.map-peek-close').onclick = hidePeek;
    // 相手を押すと、その点に札を移し、たどった辺の言葉を添える（NIH-88）
    for (const b of peekCard.querySelectorAll('.map-peek-peer')) {
      b.onclick = () => {
        const peer = info.peers[Number(b.dataset.peer)];
        const target = inst.$id(peer.id);
        if (!target.nonempty()) return;
        showPeek(target, peekOf(target, inst.$id(peer.edge).data()));
        moveTo(target);
        peekCard.querySelector('.map-peek-go')?.focus({ preventScroll: true });
      };
    }
    peekCard.hidden = false;
  };
  // 面は 1 回でその画面へ。点・線は 1 回目で札を出し、同じものをもう 1 回押すか札を押すとその画面へ
  cy.on('tap', 'node', (e) => {
    const node = e.target;
    const go = ROUTE[node.data('kind')];
    if (!go) return;
    const info = peekOf(node);
    if (!info || peeked?.node.same(node)) location.hash = go(node.data('ref'));
    else showPeek(node, info);
  });
  cy.on('tap', (e) => {
    if (e.target === cy) hidePeek();
  });
  for (const b of wrap.querySelectorAll('[data-map="zoom"]')) {
    b.onclick = () => {
      const level = cy.zoom() * (b.dataset.dir === '1' ? 1.4 : 1 / 1.4);
      // 札から相手へ寄せている途中なら止める（押した拡大・縮小を上書きしないように）
      cy.stop();
      cy.zoom({ level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    };
  }
  const fit = wrap.querySelector('[data-map="fit"]');
  if (fit)
    fit.onclick = () => {
      cy.stop();
      cy.fit(undefined, 16);
    };
}

// 立体のページの知識マップを描く（Cytoscape.js は大きいので、このページを開いたときだけ読み込む）
import { mapElements, mapLayout, mapStyle } from '../core/knowledge-map.js';

// 文字（14px）がおよそ 10px 以上で見える倍率
const READABLE_ZOOM = 0.75;
// これより狭い枠（スマホ）では名前を細く折り返す
const NARROW_WIDTH = 520;
const MAX_FIT_ZOOM = 1.5;

let cy = null;
// 開いている面（描き直し・同期のあとも同じ面を開いたままにする）
let focus = null;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 図を出せなかったことを枠の中に書く（読み込み・描画のどちらで失敗しても空の枠のままにしない） */
function showMapError(wrap) {
  const canvas = wrap.querySelector('#knowledge-map');
  if (!canvas?.isConnected) return;
  cy?.destroy();
  cy = null;
  wrap.querySelector('.map-tools').hidden = true;
  canvas.innerHTML = '<p class="notice err">知識マップを描けませんでした。開き直してください（初めて開くときは通信が要ります）。面と線は上の「面」「線(グループ)」から見られます。</p>';
}

/** wrap（#map-wrap）の中に図を描く。分析が変わっても同じ面を開いたままにする */
export async function mountKnowledgeMap(wrap, analysis) {
  try {
    const cytoscape = (await import('../vendor/cytoscape.esm.min.js')).default;
    draw(cytoscape, wrap, analysis);
  } catch {
    showMapError(wrap);
  }
}

function draw(cytoscape, wrap, analysis) {
  const canvas = wrap.querySelector('#knowledge-map');
  if (!canvas.isConnected) return;
  cy?.destroy();
  const colors = { solid: css('--layer-solid'), plane: css('--layer-plane'), line: css('--layer-line'), ink: css('--ink'), surface: css('--surface'), font: css('--font') };
  cy = cytoscape({ container: canvas, style: mapStyle(colors, { narrow: canvas.clientWidth < NARROW_WIDTH }), minZoom: 0.2, maxZoom: 4, boxSelectionEnabled: false, autoungrabify: true });
  const show = (next) => {
    const { nodes, edges, focus: shown } = mapElements(analysis, { focus: next });
    focus = shown;
    cy.elements().remove();
    cy.add([...nodes.map((data) => ({ group: 'nodes', data })), ...edges.map((data) => ({ group: 'edges', data }))]);
    cy.layout(mapLayout({ focus })).run();
    // 線の多い面は枠に収めると文字が読めない大きさになるので、読める倍率まで寄せて面を真ん中に置く（残りは指で動かして見る）
    if (focus && cy.zoom() < READABLE_ZOOM) cy.zoom(READABLE_ZOOM).center(cy.$id(`p:${focus}`));
    // 点が少ないと枠いっぱいまで拡大されるので、文字が大きくなりすぎない倍率で止める
    if (cy.zoom() > MAX_FIT_ZOOM) cy.zoom(MAX_FIT_ZOOM).center();
    const plane = analysis.planes.find((p) => p.id === focus);
    const back = wrap.querySelector('[data-map="back"]');
    const link = wrap.querySelector('[data-map="plane"]');
    back.hidden = !plane;
    link.hidden = !plane;
    if (plane) {
      link.href = `#/knowledge/plane/${encodeURIComponent(plane.id)}`;
      link.textContent = `${plane.name} のページへ`;
    }
  };
  cy.on('tap', 'node', (e) => {
    const n = e.target;
    if (n.data('kind') === 'line') location.hash = `#/knowledge/line/${encodeURIComponent(n.data('ref'))}`;
    else if (n.data('kind') === 'plane') {
      // 開いた面・線の無い面は、開いても見るものが無いので面のページへ
      if (focus || !n.data('weight')) location.hash = `#/knowledge/plane/${encodeURIComponent(n.data('ref'))}`;
      else show(n.data('ref'));
    }
  });
  wrap.querySelector('[data-map="back"]').onclick = () => show(null);
  for (const b of wrap.querySelectorAll('[data-map="zoom"]')) {
    b.onclick = () => {
      const level = cy.zoom() * (b.dataset.dir === '1' ? 1.4 : 1 / 1.4);
      cy.zoom({ level, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    };
  }
  show(focus);
}

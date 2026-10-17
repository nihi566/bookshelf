// 画面のルート表と、画面ごとに描き直し方を決める表。DOM に触れないので Node のテストからも import できる
import { html } from './html.js';
import { homeAlertBlock } from './ui.js';
import { book, books, home, search } from './views/library.js';
import { autoStatusBlock, historyView, pcPanelHead, isolatedView, knowledge, lineView, pendingView, planeView } from './views/knowledge.js';
import { linesView, planesView, solidView } from './views/layers.js';
import { starsView } from './views/stars.js';
import { trashView } from './views/trash.js';
import { removedView } from './views/removed.js';
import { discoveriesView, discoveryView } from './views/discoveries.js';
import { farView } from './views/far.js';
import { noteView, notesView } from './views/notes.js';
import { pointView } from './views/point.js';
import { linkPickerView } from './views/links.js';
import { askView } from './views/ask.js';
import { outlineNewView, outlineView, outlinesView } from './views/outlines.js';
import { importView, kindleSyncBlock, settingsView } from './views/settings.js';
import { wishlist } from './views/wishlist.js';
import { records } from './views/records.js';
import { thoughtsView } from './views/thoughts.js';

// 「すべての画面」（サイトマップ。NIH-286 の残り = NIH-296）の見出し。本の側は下のタブの順、最後に価格
const SITEMAP_GROUPS = [
  ['home', 'ホーム'],
  ['books', '読んだ本'],
  ['stars', '★'],
  ['knowledge', '知識'],
  ['records', '読書記録'],
  ['settings', '設定'],
  ['price', '価格'],
];

/** ルートの正規表現から、そのまま開ける URL（#/ の後ろ）を取り出す。URL に値を含むルート（本 1 冊など）は null */
export function fixedPath(re) {
  const m = re.source.match(/^\^((?:\\\/|[\w-])*)\$$/);
  return m ? m[1].replace(/\\\//g, '/') || '/' : null;
}

/**
 * 「すべての画面」に並べる画面。ROUTES の URL に値を含まない画面を、タブごとにまとめる（画面を足すと自動で出る）。
 * 戻り値は [{ axis, title, pages: [{ href, name }] }]（中身の無い見出しは出さない）
 */
export function siteMap() {
  return SITEMAP_GROUPS.map(([tab, title]) => ({
    axis: axisOfTab(tab),
    title,
    pages: ROUTES.filter(([re, , t]) => t === tab && fixedPath(re) !== null).map(([re, , , name]) => ({ href: `#${fixedPath(re)}`, name })),
  })).filter((g) => g.pages.length);
}

const siteMapGroup = (g) => html`<div class="card stack">
        <div class="small muted">${g.title}</div>
        ${g.pages.map((p) => html`<a class="row spread" href="${p.href}"><b>${p.name}</b><span class="muted">›</span></a>`)}
      </div>`;

// すべての画面（入口は設定の先頭）
const siteMapView = {
  render() {
    const map = siteMap();
    const side = (axis) => map.filter((g) => g.axis === axis).map(siteMapGroup);
    return html`<a class="back" href="#/settings">‹ 設定</a>
      <div class="page-head"><div><h1>すべての画面</h1><div class="sub">下のタブに無い画面も、ここから開けます</div></div></div>
      <div class="section"><h2>本</h2></div>
      ${side('memo')}
      <div class="section"><h2>価格</h2></div>
      ${side('price')}`;
  },
};

// [URL, 画面, タブ, 画面名]。画面名は「すべての画面」に出す名前で、URL に値を含まない画面には必ず付ける（test/sitemap.test.js）
export const ROUTES = [
  [/^\/$/, home, 'home', 'ホーム'],
  [/^\/books$/, books, 'books', '読んだ本'],
  [/^\/book\/(?<id>[\w-]+)$/, book, 'books'],
  [/^\/wishlist$/, wishlist, 'price', '価格チェック'],
  // 全ての点の一覧（点の専用ページ。言葉・意味で探せる）。入口はホームの点の数・読んだ本・知識の画面
  [/^\/search$/, search, 'books', '全ての点'],
  [/^\/records$/, records, 'records', '読書記録'],
  // 思いつき（フリートノート）の一覧。受け箱はホームにあるので、タブはホーム
  [/^\/thoughts$/, thoughtsView, 'home', 'メモ（思いつき）'],
  [/^\/knowledge$/, knowledge, 'knowledge', '知識'],
  // 線・面・立体の専用ページ（一覧。点の一覧は全ての点 = #/search）
  [/^\/lines$/, linesView, 'knowledge', '線(グループ)'],
  [/^\/planes$/, planesView, 'knowledge', '面'],
  [/^\/solid$/, solidView, 'knowledge', '立体'],
  // ★をつけた線(グループ)と点（入口は下のタブの★・ホームの「★ N」・線(グループ)の画面。NIH-286）
  [/^\/stars$/, starsView, 'stars', '★をつけた線(グループ)と点'],
  [/^\/knowledge\/line\/(?<id>[\w-]+)$/, lineView, 'knowledge'],
  [/^\/knowledge\/plane\/(?<id>[\w-]+)$/, planeView, 'knowledge'],
  [/^\/knowledge\/isolated$/, isolatedView, 'knowledge', 'まだつながっていない点'],
  // 前回の分析のあとに増えた点（知識の画面・ホームの「増えた点 N 件」から）
  [/^\/knowledge\/pending$/, pendingView, 'knowledge', '前回の分析のあとに増えた点'],
  // 前回の分析のあとに消えた点（「減った点 N 件」から。理由と戻す画面への入口）
  [/^\/knowledge\/removed$/, removedView, 'knowledge', '前回の分析のあとに消えた点'],
  // 遠いつながり（別の本・別の面の点の組を AI が読み、共通する考えがあったもの）
  [/^\/knowledge\/far$/, farView, 'knowledge', '遠いつながり'],
  // 永久ノート（1 ノート = 1 アイデア）と、点 1 つ（それを根拠にしている永久ノート）
  [/^\/notes$/, notesView, 'knowledge', '永久ノート'],
  [/^\/note\/(?<id>[\w-]+)$/, noteView, 'knowledge'],
  [/^\/point\/(?<id>[\w-]+)$/, pointView, 'knowledge'],
  // リンクを張る相手を選ぶ（点・メモ・永久ノートから）
  [/^\/link\/(?<id>[\w-]+)$/, linkPickerView, 'knowledge'],
  // 問いかける（PC の AI が、自分の点を根拠に答える）
  [/^\/ask$/, askView, 'knowledge', '問いかける'],
  // 文章の骨組み（一覧・材料を選んで作る・骨組み 1 つ）
  [/^\/outlines$/, outlinesView, 'knowledge', '文章の骨組み'],
  [/^\/outline\/new$/, outlineNewView, 'knowledge', '骨組みを作る'],
  [/^\/outline\/(?<id>[\w-]+)$/, outlineView, 'knowledge'],
  // 過去の分析（履歴は PC にだけある）
  [/^\/knowledge\/history\/(?<id>[0-9TZ]+)$/, historyView, 'knowledge'],
  // 発見（ホームの「発見」から開く）
  [/^\/discovery\/(?<id>[\w-]+)$/, discoveryView, 'home'],
  [/^\/discoveries$/, discoveriesView, 'home', 'すべての発見'],
  [/^\/import$/, importView, 'settings', '取り込み'],
  [/^\/settings$/, settingsView, 'settings', '設定'],
  // 削除した点（通知の「元に戻す」が消えた後でも戻せる。入口は設定の「データ」）
  [/^\/trash$/, trashView, 'settings', '削除した点'],
  // すべての画面（NIH-296）
  [/^\/sitemap$/, siteMapView, 'settings', 'すべての画面'],
];

/** location.hash（「#/book/x?q=y」）を、パスと問い合わせに分ける */
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

/** どのルートにも合わない URL の画面。ホームの先頭に、開いた URL が無いことを知らせる（NIH-123） */
function notFoundView(path) {
  return {
    render: (ctx) => html`<p class="notice err" role="alert" style="margin-bottom:12px">このページはありません（URL: #${path}）。古いブックマークか、消えた画面へのリンクかもしれません。ホームを出しています</p>${home.render(ctx)}`,
    mount: (root, ctx) => home.mount(root, ctx),
  };
}

// 上のバーで切り替える 2 つの軸（NIH-286）。価格チェックの画面が「価格」、ほかはすべて「本」。
// 値はまだ開いていない軸の入口
export const AXIS_HOME = Object.freeze({ memo: '#/', price: '#/wishlist' });
const axisOfTab = (tab) => (tab === 'price' ? 'price' : 'memo');

/**
 * 軸ごとに最後に開いた画面（hash）を覚え直した新しい表。切り替えで、その軸で見ていた画面に戻すため。
 * match は matchRoute の戻り値。どのルートにも合わない URL は覚えない（戻った先が「このページはありません」にならないように）
 */
export function rememberAxisHash(last, match, hash) {
  if (match.notFound) return last;
  return { ...last, [match.axis]: hash || AXIS_HOME[match.axis] };
}

/** パスに合う画面・タブ・軸・URL の中の値。どれにも合わなければ、案内つきのホーム（notFound に開いたパス） */
export function matchRoute(path) {
  for (const [re, view, tab] of ROUTES) {
    const m = path.match(re);
    if (m) return { view, tab, axis: axisOfTab(tab), params: m.groups || {} };
  }
  return { view: notFoundView(path), tab: 'home', axis: 'memo', params: {}, notFound: path };
}

// 思いつきを出している画面（受け箱・メモの一覧・点の検索）
export const THOUGHT_PATHS = ['/', '/thoughts', '/search'];

// 分析の結果を出す線・面・立体のページ（分析が終わったら描き直す）
export const LAYER_PATHS = ['/lines', '/planes', '/solid'];

// 「分析し直す」と分析の進み具合を出すページ（進み具合が変わるたびに描き直す）
export const JOB_PATHS = ['/knowledge', '/knowledge/pending'];

// PC の状態（拡張の確認結果など）を表示する画面
export const PC_INFO_PATHS = ['/settings', '/import', '/', '/knowledge'];
// 描き直さず、欄だけ差し替える画面（描き直すと取り込み結果の表示・開いた説明・今日の点の「別の点」が消える）
export const PC_INFO_BOXES = {
  '/import': [['#kindle-sync', kindleSyncBlock]],
  '/': [['#home-alert', homeAlertBlock]],
  '/knowledge': [['#auto-status', autoStatusBlock], ['#pc-analysis-head', pcPanelHead]],
};

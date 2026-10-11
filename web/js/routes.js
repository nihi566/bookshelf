// 画面のルート表と、画面ごとに描き直し方を決める表。DOM に触れないので Node のテストからも import できる
import { html } from './html.js';
import { homeAlertBlock } from './ui.js';
import { book, books, home, search } from './views/library.js';
import { autoStatusBlock, historyView, isolatedView, knowledge, lineView, pendingView, planeView } from './views/knowledge.js';
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
import { importView, kindleSyncBlock, playbooksSyncBlock, settingsView } from './views/settings.js';
import { wishlist } from './views/wishlist.js';
import { records } from './views/records.js';
import { thoughtsView } from './views/thoughts.js';

export const ROUTES = [
  [/^\/$/, home, 'home'],
  [/^\/books$/, books, 'books'],
  [/^\/book\/(?<id>[\w-]+)$/, book, 'books'],
  [/^\/wishlist$/, wishlist, 'price'],
  // 全ての点の一覧（点の専用ページ。言葉・意味で探せる）。入口はホームの点の数・読んだ本・知識の画面
  [/^\/search$/, search, 'books'],
  [/^\/records$/, records, 'records'],
  // 思いつき（フリートノート）の一覧。受け箱はホームにあるので、タブはホーム
  [/^\/thoughts$/, thoughtsView, 'home'],
  [/^\/knowledge$/, knowledge, 'knowledge'],
  // 線・面・立体の専用ページ（一覧。点の一覧は全ての点 = #/search）
  [/^\/lines$/, linesView, 'knowledge'],
  [/^\/planes$/, planesView, 'knowledge'],
  [/^\/solid$/, solidView, 'knowledge'],
  // ★をつけた線(グループ)と点（入口はホームの「★ N」と線(グループ)の画面）
  [/^\/stars$/, starsView, 'home'],
  [/^\/knowledge\/line\/(?<id>[\w-]+)$/, lineView, 'knowledge'],
  [/^\/knowledge\/plane\/(?<id>[\w-]+)$/, planeView, 'knowledge'],
  [/^\/knowledge\/isolated$/, isolatedView, 'knowledge'],
  // 前回の分析のあとに増えた点（知識の画面・ホームの「増えた点 N 件」から）
  [/^\/knowledge\/pending$/, pendingView, 'knowledge'],
  // 前回の分析のあとに消えた点（「減った点 N 件」から。理由と戻す画面への入口）
  [/^\/knowledge\/removed$/, removedView, 'knowledge'],
  // 遠いつながり（別の本・別の面の点の組を AI が読み、共通する考えがあったもの）
  [/^\/knowledge\/far$/, farView, 'knowledge'],
  // 永久ノート（1 ノート = 1 アイデア）と、点 1 つ（それを根拠にしている永久ノート）
  [/^\/notes$/, notesView, 'knowledge'],
  [/^\/note\/(?<id>[\w-]+)$/, noteView, 'knowledge'],
  [/^\/point\/(?<id>[\w-]+)$/, pointView, 'knowledge'],
  // リンクを張る相手を選ぶ（点・メモ・永久ノートから）
  [/^\/link\/(?<id>[\w-]+)$/, linkPickerView, 'knowledge'],
  // 問いかける（PC の AI が、自分の点を根拠に答える）
  [/^\/ask$/, askView, 'knowledge'],
  // 文章の骨組み（一覧・材料を選んで作る・骨組み 1 つ）
  [/^\/outlines$/, outlinesView, 'knowledge'],
  [/^\/outline\/new$/, outlineNewView, 'knowledge'],
  [/^\/outline\/(?<id>[\w-]+)$/, outlineView, 'knowledge'],
  // 過去の分析（履歴は PC にだけある）
  [/^\/knowledge\/history\/(?<id>[0-9TZ]+)$/, historyView, 'knowledge'],
  // 発見（ホームの「発見」から開く）
  [/^\/discovery\/(?<id>[\w-]+)$/, discoveryView, 'home'],
  [/^\/discoveries$/, discoveriesView, 'home'],
  [/^\/import$/, importView, 'settings'],
  [/^\/settings$/, settingsView, 'settings'],
  // 削除した点（通知の「元に戻す」が消えた後でも戻せる。入口は設定の「データ」）
  [/^\/trash$/, trashView, 'settings'],
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

/** パスに合う画面・タブ・URL の中の値。どれにも合わなければ、案内つきのホーム（notFound に開いたパス） */
export function matchRoute(path) {
  for (const [re, view, tab] of ROUTES) {
    const m = path.match(re);
    if (m) return { view, tab, params: m.groups || {} };
  }
  return { view: notFoundView(path), tab: 'home', params: {}, notFound: path };
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
  '/import': [['#kindle-sync', kindleSyncBlock], ['#playbooks-sync', playbooksSyncBlock]],
  '/': [['#home-alert', homeAlertBlock]],
  '/knowledge': [['#auto-status', autoStatusBlock]],
};

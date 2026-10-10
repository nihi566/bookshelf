// ホーム・本・検索の画面
import { html } from '../html.js';
import { bookHighlights, dailyPicks, isTechnicalBook, libraryStats, listBooks, searchHighlights, SOURCES } from '../../core/model.js';
import { searchPoints } from '../../core/points.js';
import { THOUGHT_LABEL, liveThoughts } from '../../core/thoughts.js';
import { normalizeText } from '../../core/text.js';
import { browserStore, formatPrice, loadMarks, searchWishlist, wishlistSummary } from '../../core/wishlist.js';
import { loadWishlist } from '../wishlist-data.js';
import { bookRow, bookSpine, emptyBooksBlock, highlightCard, homeAlertBlock, lineIndex, pendingNudge, pointCard, sourceBadge } from '../ui.js';
import { inboxBlock } from './thoughts.js';
import { discoveriesBlock, partnerBlock } from './discoveries.js';
import { noteRow } from './notes.js';
import { searchNotes } from '../../core/notes.js';
import { meaningResults, semanticAvailability, unavailableNotice } from './ask.js';
import { companion } from '../services.js';

const flow = html`<div class="flow" aria-label="点から立体へ">
  <div class="f-point"><b>点</b>線を引いた一文</div>
  <div class="f-line"><b>線(グループ)</b>点をつなぐ概念</div>
  <div class="f-plane"><b>面</b>線を束ねたテーマ</div>
  <div class="f-solid"><b>立体</b>知識の全体像</div>
</div>`;

// ホームの今日の点の件数
const HOME_PICKS = 2;

export const home = {
  render({ state, shuffle = 0 }) {
    const lib = state.library;
    const s = libraryStats(lib);
    const a = state.analysis;
    // 自動取り込み・分析の異常はスマホで最初に開くホームで気づけるようにする（中身は PC の情報を取り直したときに差し替える）
    const alert = html`<div id="home-alert">${homeAlertBlock(state)}</div>`;
    if (!s.highlights && !s.technical && !liveThoughts(lib).length) {
      return html`${alert}<section class="card hero">
          <h1>本に引いた線を、<br>知識の立体へ。</h1>
          <p class="help">Kindle と Play ブックスのハイライトを 1 か所に集めます。PC のローカル LLM が「点」をつないで「線(グループ)」「面」「立体」に組み立て、次に読む本も提案します。</p>
          ${flow}
          <div class="row">
            <a class="btn primary" href="#/import">ハイライトを取り込む</a>
            <button class="btn" data-action="load-sample">サンプルで試す</button>
          </div>
        </section>
        <div class="section"><h2>使い方</h2></div>
        <ol class="card stack help" style="padding-left:2em">
          <li><b>取り込む</b> — Kindle（端末の My Clippings.txt・アプリのノートブック）と Play ブックス（ドライブのメモ）、読書メモ（Markdown）に対応。紙の本は「読んだ本」から登録して、線を引いた文を入力できます。</li>
          <li><b>AI で立体にする</b> — PC のローカル LLM（Ollama など）が点を線(グループ)・面・立体に組み立て、おすすめの本を選びます。</li>
        </ol>`;
    }
    const picks = dailyPicks(lib, HOME_PICKS, new Date(), shuffle);
    const idx = lineIndex(a);
    const recent = searchHighlights(lib, '').slice(0, 5);
    const bySource = [...Object.entries(s.bySource).map(([k, v]) => `${SOURCES[k] || k} ${v}`), ...(s.thoughts ? [`${THOUGHT_LABEL} ${s.thoughts}`] : [])];
    return html`${alert}
      <div class="stats">
        <a class="stat point" href="#/search"><b>${s.points}</b><span>点</span></a>
        <a class="stat line" href="#/lines"><b>${a ? a.lines.length : '–'}</b><span>線(グループ)</span></a>
        <a class="stat plane" href="#/planes"><b>${a ? a.planes.length : '–'}</b><span>面</span></a>
        <a class="stat solid" href="#/solid"><b>${a ? 1 : '–'}</b><span>立体</span></a>
      </div>
      <p class="small muted" style="margin-top:8px">${[`本 ${s.books} 冊`, ...bySource, html`<a href="#/stars">★ ${s.favorites}</a>`].map((x, i) => html`${i ? ' ・ ' : ''}<span class="nowrap">${x}</span>`)}${s.technical ? ` ・ 技術書の線 ${s.technical} 件は点に数えていません` : ''}</p>

      ${discoveriesBlock(state)}

      <section class="today" aria-labelledby="today-title">
        <div class="section"><h2 id="today-title">今日の点</h2><button class="btn small" data-action="shuffle">別の点</button></div>
        ${picks.map((p) => html`${pointCard(p, { library: lib, lines: idx.get(p.id) })}${partnerBlock(state, p, idx)}`)}
      </section>

      ${inboxBlock(state)}

      ${a
        ? html`<div class="section"><h2>立体</h2><a class="small" href="#/solid">知識マップへ</a></div>
            <a class="card solid-card" href="#/solid" style="display:block;color:inherit;text-decoration:none">
              <div class="layer-label solid">立体</div>
              <h2>${a.solid.title}</h2>
              <p class="core">${a.solid.core}</p>
            </a>
            ${pendingNudge(state, { toKnowledge: true })}`
        : html`<div class="section"><h2>AI 分析</h2></div>
            <div class="card"><p>点が ${s.points} 件たまりました。ローカル LLM で点をつないで、線(グループ)・面・立体にしてみましょう。</p>
            <a class="btn primary" href="#/knowledge">分析する</a></div>`}

      <div id="home-wishlist"></div>

      <div class="section"><h2>最近の点</h2><a class="small" href="#/search">全ての点の一覧</a></div>
      ${recent.map((h) => highlightCard(h, { library: lib, lines: idx.get(h.id) }))}`;
  },
  mount(root) {
    renderHomeWishlist(root.querySelector('#home-wishlist'));
  },
};

/** ホームの「欲しい本」。Kindle Unlimited で読める本に気づけるように。読めないときは何も出さない（ホームを邪魔しない） */
function renderHomeWishlist(box) {
  if (!box) return;
  loadWishlist()
    .then((w) => {
      if (!box.isConnected || !w.books.length) return;
      // タグは読むだけ（ホームでは保存値を片付けない。欲しい本の画面と同じく、保存できないブラウザでは公開データのタグ）
      const store = browserStore();
      const s = wishlistSummary(w.books.map((book) => ({ book, marks: loadMarks(book, store) })));
      box.innerHTML = String(html`<section class="home-wishlist">
          <div class="section"><h2>欲しい本</h2><a class="small" href="#/wishlist">欲しい本へ</a></div>
          <p class="small muted">欲しい本 ${s.total} 冊${s.kuCount ? ` ・ Kindle Unlimited 対象 ${s.kuCount} 冊` : ''}</p>
          ${s.picks.length ? html`<ul class="book-list">${s.picks.map(wishlistHitRow)}</ul>` : ''}
          ${s.kuCount ? html`<a class="small" href="#/wishlist?ku=1">Kindle Unlimited 対象をすべて見る（${s.kuCount} 冊）</a>` : ''}
        </section>`);
    })
    .catch(() => {
      if (box.isConnected) box.innerHTML = '';
    });
}

export const books = {
  render({ state, query }) {
    const source = query.get('source') || '';
    const sort = query.get('sort') || 'recent';
    const q = (query.get('q') || '').trim().toLowerCase();
    // 登録しただけで線がまだ無い紙の本も出す（開いて線を足せるように）
    let list = listBooks(state.library, { includeEmpty: true }).filter((b) => (!source || b.sources.includes(source)) && (!q || `${b.title} ${b.author}`.toLowerCase().includes(q)));
    if (sort === 'title') list = list.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    if (sort === 'count') list = list.sort((a, b) => b.count - a.count);
    const chip = (key, value, label) => {
      const params = new URLSearchParams(query);
      if (value) params.set(key, value);
      else params.delete(key);
      const on = (query.get(key) || '') === value || (!query.get(key) && key === 'sort' && value === 'recent');
      return html`<a class="chip ${on ? 'on' : ''}" href="#/books?${params}" ${on ? html`aria-current="true"` : ''}>${label}</a>`;
    };
    return html`<div class="page-head"><div><h1>読んだ本</h1><div class="sub">${list.length} 冊</div></div><span class="row"><button class="btn small" data-action="register-book">＋ 紙の本</button><a class="btn small" href="#/import">＋ 取り込む</a></span></div>
      <div class="row" style="margin-bottom:12px"><a class="btn small" href="#/search">全ての点の一覧・検索</a></div>
      <form class="search-box" data-form="book-filter" role="search"><input type="search" name="q" value="${query.get('q') || ''}" placeholder="書名・著者で絞り込む" aria-label="書名・著者で絞り込む"></form>
      <div class="chips" role="group" aria-label="読み方で絞り込む">${chip('source', '', 'すべて')}${chip('source', 'kindle', 'Kindle')}${chip('source', 'playbooks', 'Play Books')}${chip('source', 'paper', '紙の本')}${chip('source', 'memo', '読書メモ')}</div>
      <div class="chips" style="margin-top:6px" role="group" aria-labelledby="books-sort-label"><span class="chips-label" id="books-sort-label">並び順</span>${chip('sort', 'recent', '最近')}${chip('sort', 'title', '書名')}${chip('sort', 'count', '点の数')}</div>
      ${list.length ? html`<ul class="book-list">${list.map(bookRow)}</ul>` : emptyBooksBlock(state)}`;
  },
};

export const book = {
  render({ state, params }) {
    const b = state.library.books[params.id];
    if (!b || b.deleted) return html`<p class="empty">本が見つかりません。<a href="#/books">読んだ本の一覧へ</a></p>`;
    const hs = bookHighlights(state.library, b.id);
    const idx = lineIndex(state.analysis);
    const linesHere = (state.analysis?.lines || []).filter((l) => l.bookIds?.includes(b.id));
    let chapter = null;
    const items = [];
    for (const h of hs) {
      if (h.chapter && h.chapter !== chapter) {
        chapter = h.chapter;
        items.push(html`<h3 class="chapter">${chapter}</h3>`);
      }
      items.push(highlightCard(h, { library: state.library, lines: idx.get(h.id), showBook: false }));
    }
    const technical = isTechnicalBook(b);
    // 紙の本には線を引いた文を手で足す欄を出す（章は前に入れたものから選べる）
    const chapters = [...new Set(hs.map((h) => h.chapter).filter(Boolean))];
    const addForm = b.sources.includes('paper')
      ? html`<form class="card stack" data-form="add-highlight" data-id="${b.id}" style="margin-top:16px">
          <h2 style="font-size:1rem;margin:0">線を引いた文を足す</h2>
          <label class="field"><span>文</span><textarea name="text" rows="3" required placeholder="本で線を引いた箇所を書き写す"></textarea></label>
          <div class="row" style="flex-wrap:nowrap;gap:8px">
            <label class="field" style="flex:0 0 6.5em;margin:0"><span>ページ</span><input type="text" name="page" inputmode="numeric" autocomplete="off"></label>
            <label class="field grow" style="margin:0"><span>章（任意）</span><input type="text" name="chapter" list="chapter-list" autocomplete="off"></label>
          </div>
          <datalist id="chapter-list">${chapters.map((c) => html`<option value="${c}">`)}</datalist>
          <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">追加</button></div>
        </form>`
      : '';
    return html`<a class="back" href="#/books">‹ 読んだ本</a>
      <div class="page-head">
        <div class="row" style="flex-wrap:nowrap;align-items:flex-start;gap:12px">
          ${bookSpine(b)}
          <div><h1>${b.title}</h1><div class="sub">${b.author || '著者不明'} ${b.sources.map(sourceBadge)} <span class="nowrap">・ ${hs.length} ${technical ? '件' : '点'}</span>${technical ? html` <span class="badge tech">技術書</span>` : ''}</div>
            ${technical ? html`<p class="small muted" style="margin:4px 0 0">技術書の線は点に数えません（点の数・今日の点・AI 分析から外します）</p>` : ''}</div>
        </div>
      </div>
      <div class="row">
        <a class="btn small" href="#/records?book=${encodeURIComponent(b.id)}">読み終えた日を記録</a>
        <button class="btn small" data-action="edit-book" data-id="${b.id}">本の情報を編集</button>
        <button class="btn small danger" data-action="delete-book" data-id="${b.id}">この本を削除</button>
      </div>
      ${addForm}
      ${b.sources.includes('paper') && !hs.length ? html`<p class="empty">まだ線を引いた文がありません。上の欄から足せます。</p>` : ''}
      ${linesHere.length ? html`<div class="section"><h2>この本から伸びる線(グループ)</h2></div><div class="hl-lines">${linesHere.map((l) => html`<a class="line-chip" href="#/knowledge/line/${l.id}">${l.name}</a>`)}</div>` : ''}
      <div style="margin-top:16px">${items}</div>`;
  },
};

/** 探し方の切り替え先（今の言葉・絞り込みをそのまま持っていく） */
function modeHref(query, value) {
  const p = new URLSearchParams(query);
  if (value) p.set('mode', value);
  else p.delete('mode');
  return `#/search${p.toString() ? `?${p}` : ''}`;
}

export const search = {
  render({ query }) {
    const q = query.get('q') || '';
    const meaning = query.get('mode') === 'meaning';
    // 探し方の切り替え（言葉の一致 / 意味の近さ。意味で探すときは PC の AI を使う）
    const mode = (on, label, value) => html`<a class="chip ${on ? 'on' : ''}" data-mode="${value}" href="${modeHref(query, value)}" ${on ? html`aria-current="true"` : ''}>${label}</a>`;
    return html`<a class="back" href="#/books">‹ 読んだ本</a>
      <div class="page-head"><div><h1>全ての点</h1><div class="sub">本に引いた線と思いつき。言葉・意味で探せます</div></div><a class="btn small" id="search-ask" href="${askHref(q)}">問いかける</a></div>
      <form class="search-box" data-form="search" role="search">
        <input type="search" name="q" value="${q}" placeholder="${meaning ? '探したいこと（言葉が一致しなくても探します）' : '言葉・書名・#タグ（空白で AND）'}" aria-label="ハイライトと思いつきを検索" autocomplete="off" ${q ? '' : 'autofocus'}>
      </form>
      <div class="chips search-modes" role="group" aria-label="探し方">${mode(!meaning, '言葉で探す', '')}${mode(meaning, '意味で探す', 'meaning')}</div>
      <div class="chips" id="search-filters" role="group" aria-label="絞り込み"></div>
      <div id="search-wishlist"></div>
      <div id="search-results"></div>`;
  },
  mount(root, ctx) {
    const input = root.querySelector('input[name="q"]');
    const meaning = ctx.query.get('mode') === 'meaning';
    // 描くたびに番号を進める（待っている間に打ち直した・切り替えた・描き直したときの、古い意味で探すの結果を出さない）
    const update = () => {
      const token = ++searchToken;
      return meaning ? renderMeaning(root, ctx, input.value, token) : renderResults(root, ctx, input.value);
    };
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(
        () => {
          // 待つ間に画面を移っていたら何もしない（URL を書き換えない）
          if (!input.isConnected) return;
          const params = new URLSearchParams(ctx.query);
          if (input.value) params.set('q', input.value);
          else params.delete('q');
          history.replaceState(null, '', `#/search${params.toString() ? '?' + params : ''}`);
          ctx.query = params;
          // 「問いかける」と探し方の切り替えにも、今の言葉を引き継ぐ
          root.querySelector('#search-ask')?.setAttribute('href', askHref(input.value));
          for (const a of root.querySelectorAll('.search-modes a[data-mode]')) a.setAttribute('href', modeHref(params, a.dataset.mode));
          update();
        },
        // 意味で探すときは PC に問い合わせるので、打ち終わるのを少し長く待つ
        meaning ? 500 : 150,
      );
    });
    update();
  },
};

/** 問いかける画面へ（探している言葉を質問に引き継ぐ） */
const askHref = (q) => `#/ask${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`;

let searchToken = 0;
// 直前に意味で探した結果（メモの保存・同期で描き直すたびに PC へ問い合わせ直さない。スクロールの位置も保てる）
let lastMeaning = { q: '', at: 0, results: [] };
const MEANING_REUSE_MS = 5 * 60 * 1000;

/** 意味で探す（PC が近い順の ID を返す）。PC とつながっていない・埋め込みモデルが無いときは理由を出して言葉の一致の検索に戻る */
async function renderMeaning(root, ctx, q, token) {
  const box = root.querySelector('#search-results');
  const filters = root.querySelector('#search-filters');
  const wishlist = root.querySelector('#search-wishlist');
  if (!box || !filters || !wishlist) return;
  // 絞り込み（Kindle・★など）と欲しい本は、言葉で探すときだけ
  filters.innerHTML = '';
  wishlist.innerHTML = '';
  const query = q.trim();
  if (!query) {
    box.innerHTML = String(html`<p class="help">言葉が一致しなくても、意味の近い点・メモ・永久ノートを探します（PC の AI を使います）。</p>`);
    return;
  }
  const why = semanticAvailability(ctx.state);
  if (why !== 'ok') return wordsInstead(root, ctx, q, unavailableNotice(why));
  if (lastMeaning.q === query && Date.now() - lastMeaning.at < MEANING_REUSE_MS) {
    box.innerHTML = String(meaningResults(ctx.state, lastMeaning.results));
    return;
  }
  box.innerHTML = String(html`<p class="small muted" role="status">PC で意味の近い点を探しています…</p>`);
  let found;
  try {
    found = await companion.search(query);
  } catch (e) {
    // 待っている間に打ち直した・切り替えた・画面を移ったときは、何も書かない
    if (token === searchToken && box.isConnected) wordsInstead(root, ctx, q, unavailableNotice(e.code === 'no-embed-model' ? 'no-embed' : '', e.message));
    return;
  }
  lastMeaning = { q: query, at: Date.now(), results: found?.results || [] };
  if (token === searchToken && box.isConnected) box.innerHTML = String(meaningResults(ctx.state, lastMeaning.results));
}

function wordsInstead(root, ctx, q, notice) {
  renderResults(root, ctx, q);
  root.querySelector('#search-results').insertAdjacentHTML('afterbegin', String(notice));
}

function renderResults(root, ctx, q) {
  const { state, query } = ctx;
  const source = query.get('source') || '';
  const fav = query.get('fav') === '1';
  // 捨てた思いつきは出さない（メモの一覧の「捨てた」でだけ見られる）
  const results = searchPoints(state.library, q, { source, favorite: fav });
  const idx = lineIndex(state.analysis);
  const link = (patch, label, on) => {
    const p = new URLSearchParams(query);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    return html`<a class="chip ${on ? 'on' : ''}" href="#/search?${p}" ${on ? html`aria-current="true"` : ''}>${label}</a>`;
  };
  root.querySelector('#search-filters').innerHTML = String(html`${link({ source: '' }, 'すべて', !source)}${link({ source: 'kindle' }, 'Kindle', source === 'kindle')}${link({ source: 'playbooks' }, 'Play Books', source === 'playbooks')}${link({ source: 'paper' }, '紙の本', source === 'paper')}${link({ source: 'memo' }, '読書メモ', source === 'memo')}${link({ source: 'thought' }, THOUGHT_LABEL, source === 'thought')}${link({ fav: fav ? '' : '1' }, '★ お気に入り', fav)}`);
  const shown = results.slice(0, 200);
  // 検索語に当たる永久ノート（先頭 5 件。ノートは点ではないので、点の件数とは分けて出す）
  const notes = q.trim() ? searchNotes(state.library, q) : [];
  root.querySelector('#search-results').innerHTML = String(html`${notes.length
      ? html`<section class="note-hits"><div class="section"><h2>永久ノート</h2><a class="small" href="#/notes?q=${encodeURIComponent(q)}">永久ノートで見る（${notes.length} 件）</a></div><ul class="note-list">${notes.slice(0, 5).map((n) => noteRow(state.library, n))}</ul></section>`
      : ''}
    <p class="small muted">${results.length} 件${results.length > shown.length ? `（先頭 ${shown.length} 件を表示）` : ''}</p>
    ${shown.map((p) => pointCard(p, { library: state.library, lines: idx.get(p.id), query: q }))}
    ${!results.length ? html`<p class="empty">見つかりませんでした</p>` : ''}`);
  renderWishlistHits(root, q);
}

let wishlistToken = 0;

/** 検索語に当たる欲しい本（先頭 5 件）。読めないときは何も出さない（ハイライトの検索を邪魔しない） */
function renderWishlistHits(root, q) {
  const box = root.querySelector('#search-wishlist');
  const token = ++wishlistToken;
  // #タグはハイライト用なので、欲しい本の画面へ渡す語から外す
  // 全角の「＃」もタグとして外すため、searchWishlist と同じ正規化をしてから分ける
  const words = normalizeText(q).split(' ').filter((w) => w && !w.startsWith('#')).join(' ');
  if (!words) {
    box.innerHTML = '';
    return;
  }
  loadWishlist()
    .then((w) => {
      if (token !== wishlistToken || !box.isConnected) return;
      const hits = searchWishlist(w.books, words);
      box.innerHTML = hits.length
        ? String(html`<section class="wishlist-hits"><div class="section"><h2>欲しい本</h2><a class="small" href="#/wishlist?q=${encodeURIComponent(words)}">欲しい本で見る（${hits.length} 件）</a></div>
            <ul class="book-list">${hits.slice(0, 5).map(wishlistHitRow)}</ul></section>`)
        : '';
    })
    .catch(() => {
      if (token === wishlistToken && box.isConnected) box.innerHTML = '';
    });
}

function wishlistHitRow(b) {
  const inner = html`${bookSpine(b)}
    <span class="grow"><span class="title">${b.title}</span><span class="meta">${formatPrice(b)}</span></span>`;
  return b.asin
    ? html`<li><a class="book-item" href="https://www.amazon.co.jp/dp/${b.asin}" target="_blank" rel="noopener noreferrer" aria-label="${b.title}（Amazon で開く）">${inner}</a></li>`
    : html`<li><a class="book-item" href="#/wishlist?q=${encodeURIComponent(b.title)}">${inner}</a></li>`;
}

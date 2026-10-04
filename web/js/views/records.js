// 読書記録の画面（年・月・日ごとに、読み終えた本の冊数とページ数）。
// 記録は GitHub の records ブランチの records.json に保存する（core/records-github.js）。どの端末からでも同じ記録を見られる。
import { html } from '../html.js';
import { listBooks } from '../../core/model.js';
import { addMonths, newManualId, parsePagesInput, summarizeMonth, summarizeYear, todayLocal, weekdayLabel } from '../../core/records.js';
import { BRANCH, OWNER, REPO, fetchRecords, recordsErrorMessage, saveChange } from '../../core/records-github.js';
import { bookSpine, openSheet, toast } from '../ui.js';

// GitHub トークンはこの端末のブラウザ（localStorage）にだけ保存する。使えないブラウザでは「未設定」として扱う
const TOKEN_KEY = 'book-highlights.github-token';

function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function storeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

// 画面を移っても読み直さない（開くたびに GitHub に問い合わせない）。保存・「読み込み直す」で更新する
const rec = { status: 'idle', file: null, error: null };
let loadSeq = 0;
let loading = Promise.resolve();

/** 読み直す。古い問い合わせの結果で新しい結果を上書きしない。戻り値は読み終わる Promise */
function reload(onDone) {
  const seq = ++loadSeq;
  rec.status = 'loading';
  rec.error = null;
  onDone();
  loading = fetchRecords(loadToken())
    .then((file) => {
      if (seq === loadSeq) Object.assign(rec, { status: 'ready', file, error: null });
    })
    .catch((error) => {
      if (seq === loadSeq) Object.assign(rec, { status: 'error', error });
    })
    .finally(() => seq === loadSeq && onDone());
  return loading;
}

function periodOf(query) {
  const [ty, tm] = todayLocal().split('-').map(Number);
  const y = Number(query.get('y'));
  const m = Number(query.get('m'));
  return Number.isInteger(y) && y >= 1900 && y <= 9999 && Number.isInteger(m) && m >= 1 && m <= 12 ? { year: y, month: m } : { year: ty, month: tm };
}

const periodHref = ({ year, month }) => `#/records?y=${year}&m=${month}`;

function comparisonText(current, previous) {
  if (!previous.count) return '';
  const diff = current.count - previous.count;
  if (diff === 0) return '先月と同じ冊数です';
  return diff > 0 ? `先月より ${diff} 冊多く読みました` : `先月より ${-diff} 冊少なめです`;
}

const pagesText = (pages, unknown) => `${pages.toLocaleString('ja-JP')}${unknown ? `（ページ数未記入 ${unknown} 冊）` : ''}`;

function dayHeading(day) {
  const [, m, d] = day.date.split('-').map(Number);
  return `${m}月${d}日（${weekdayLabel(day.date)}）`;
}

function monthBars(year, selectedMonth, lastMonth) {
  const max = Math.max(1, ...year.months.map((x) => x.count));
  return html`<div class="month-bars">${year.months.map(({ month, count, pages }) => {
    const future = month > lastMonth;
    const bar = html`<span class="mb-count">${count || ''}</span><span class="mb-track"><span class="mb-bar ${count ? '' : 'zero'}" style="height:${count ? Math.max(8, Math.round((count / max) * 100)) : 4}%"></span></span><span class="mb-label">${month}</span>`;
    return future
      ? html`<span class="mb future" aria-hidden="true">${bar}</span>`
      : html`<a class="mb ${month === selectedMonth ? 'on' : ''}" href="${periodHref({ year: year.year, month })}" aria-label="${month}月 ${count}冊 ${pages}ページ" ${month === selectedMonth ? html`aria-current="true"` : ''}>${bar}</a>`;
  })}</div>`;
}

function itemRow(item, canEdit) {
  const meta = item.pages != null ? `${item.pages.toLocaleString('ja-JP')} ページ` : 'ページ数未記入';
  const inner = html`${bookSpine(item)}<span class="grow"><span class="title">${item.title}</span><span class="meta">${item.author ? `${item.author} ・ ` : ''}${meta}</span></span>`;
  return html`<li class="rec-item">${canEdit
    ? html`<button type="button" class="book-item" data-rec="edit" data-id="${item.book_id}" aria-label="${item.title} の記録を編集">${inner}<span class="rec-edit" aria-hidden="true">✎</span></button>`
    : html`<span class="book-item">${inner}</span>`}</li>`;
}

function tokenSection(token) {
  return html`<details class="rec-token" ${token ? '' : 'open'}>
    <summary>記録の保存先（GitHub）</summary>
    <p class="small muted">記録は <a href="https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/records.json" target="_blank" rel="noopener noreferrer">${OWNER}/${REPO} の ${BRANCH} ブランチ</a>の records.json に保存し、どの端末からでも同じ記録を見られます。
      見るだけならトークンは要りません。記録をつけるには、この端末で一度だけ GitHub のトークンを保存します（トークンはこのブラウザの中にだけ保存し、GitHub への送信にだけ使います）。</p>
    <ol class="small muted">
      <li>GitHub の Settings → Developer settings → Fine-grained tokens で「Generate new token」</li>
      <li>Repository access で ${OWNER}/${REPO} だけを選び、Permissions の Contents を「Read and write」にする</li>
      <li>発行したトークンを下に貼って保存</li>
    </ol>
    <form class="row" data-rec-form="token">
      <input type="password" name="token" autocomplete="off" placeholder="${token ? '保存済み（入れ直すときだけ貼る）' : 'github_pat_…'}" aria-label="GitHub トークン" class="grow">
      <button class="btn small primary" value="save">保存</button>
      ${token ? html`<button class="btn small danger" value="clear">この端末から消す</button>` : ''}
    </form>
  </details>`;
}

function body(ctx) {
  const token = loadToken();
  if (rec.status === 'loading' || rec.status === 'idle') return html`<p class="loading">読み込み中…</p>${tokenSection(token)}`;
  if (rec.status === 'error') {
    return html`<p class="notice err">${recordsErrorMessage(rec.error)}</p>
      <div class="row" style="margin-top:12px"><button type="button" class="btn small" data-rec="reload">読み込み直す</button></div>${tokenSection(token)}`;
  }
  const records = rec.file.records;
  const period = periodOf(ctx.query);
  const [ty, tm] = todayLocal().split('-').map(Number);
  const month = summarizeMonth(records, period.year, period.month);
  const prev = addMonths(period.year, period.month, -1);
  const next = addMonths(period.year, period.month, 1);
  const year = summarizeYear(records, period.year);
  const isFuture = (p) => p.year > ty || (p.year === ty && p.month > tm);
  const canEdit = Boolean(token);
  return html`<div class="rec-nav">
      <a class="btn small" href="${periodHref(prev)}" aria-label="前の月">‹</a>
      <h2>${period.year}年${period.month}月</h2>
      ${isFuture(next) ? html`<span class="btn small" aria-hidden="true" style="visibility:hidden">›</span>` : html`<a class="btn small" href="${periodHref(next)}" aria-label="次の月">›</a>`}
    </div>
    <div class="rec-summary">
      <div class="card"><div class="rec-label">${period.month}月</div><div class="rec-num"><b>${month.count}</b> 冊</div><div class="rec-num"><b>${pagesText(month.pages, 0)}</b> ページ</div>
        <p class="small muted">${month.unknownCount ? `ページ数未記入 ${month.unknownCount} 冊` : ''} ${comparisonText(month, summarizeMonth(records, prev.year, prev.month))}</p></div>
      <div class="card"><div class="rec-label">${period.year}年</div><div class="rec-num"><b>${year.count}</b> 冊</div><div class="rec-num"><b>${pagesText(year.pages, 0)}</b> ページ</div>
        <p class="small muted">${year.unknownCount ? `ページ数未記入 ${year.unknownCount} 冊` : ''}</p></div>
    </div>
    ${monthBars({ ...year, year: period.year }, period.month, period.year < ty ? 12 : period.year === ty ? tm : 0)}
    <div class="section"><h2>${period.month}月に読んだ本</h2>${canEdit ? html`<button type="button" class="btn small primary" data-rec="add">＋ 記録する</button>` : ''}</div>
    ${month.days.length
      ? month.days.map((day) => html`<h3 class="chapter">${dayHeading(day)} <span class="small muted">${day.count} 冊・${day.pages.toLocaleString('ja-JP')} ページ</span></h3>
          <ul class="book-list">${day.items.map((item) => itemRow(item, canEdit))}</ul>`)
      : html`<p class="empty">この月に読み終えた本の記録はまだありません。${canEdit ? '' : 'GitHub のトークンを保存すると記録できます。'}</p>`}
    <div class="row" style="margin-top:16px"><button type="button" class="btn small" data-rec="reload">読み込み直す</button></div>
    ${tokenSection(token)}`;
}

/** 記録のシート。bookId を渡すとその本で開く（記録済みなら中身を入れて開く） */
function openRecordSheet(state, { bookId = '', onSaved }) {
  const existing = bookId ? rec.file?.records[bookId] : null;
  const libBook = bookId ? state.library.books[bookId] : null;
  const fixed = existing || libBook;
  const books = listBooks(state.library);
  openSheet(
    html`<h2>${existing ? '読書記録を編集' : '読み終えた本を記録'}</h2>
      ${fixed
        ? html`<p class="quote">${fixed.title}</p>`
        : html`<label class="field"><span>本</span><select name="book">${books.map((b) => html`<option value="${b.id}">${b.title}</option>`)}<option value="">ライブラリに無い本（書名を入れる）</option></select></label>
          <label class="field"><span>書名（ライブラリに無い本のとき）</span><input type="text" name="title" maxlength="200"></label>
          <label class="field"><span>著者（任意）</span><input type="text" name="author" maxlength="100"></label>`}
      <label class="field"><span>読み終えた日</span><input type="date" name="read_on" required value="${existing?.read_on || todayLocal()}"></label>
      <label class="field"><span>ページ数（分からなければ空のまま）</span><input type="number" name="pages" inputmode="numeric" min="1" step="1" value="${existing?.pages ?? ''}"></label>
      <div class="row spread">${existing ? html`<button class="btn danger" value="delete">記録を消す</button>` : html`<span></span>`}<span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`,
    async (data, action) => {
      const token = loadToken();
      let change;
      try {
        if (action === 'delete') {
          if (!confirm(`『${fixed.title}』の記録を消しますか？`)) return true;
          change = { type: 'remove', book_id: bookId };
        } else {
          const pick = fixed ? bookId : String(data.get('book') || '');
          const b = pick ? state.library.books[pick] || existing : null;
          const title = b ? b.title : String(data.get('title') || '').trim();
          if (!title) throw new Error('書名を入れてください');
          change = {
            type: 'read',
            book_id: pick || newManualId(),
            title,
            author: b ? b.author : String(data.get('author') || '').trim(),
            asin: b?.asin,
            volumeId: b?.volumeId,
            read_on: String(data.get('read_on') || ''),
            pages: parsePagesInput(data.get('pages')),
          };
        }
        rec.file = await saveChange(token, change);
        rec.status = 'ready';
      } catch (err) {
        toast(err.kind ? recordsErrorMessage(err) : err.message, 5000);
        return true;
      }
      toast(action === 'delete' ? '記録を消しました' : '記録しました');
      onSaved(change);
      return false;
    },
  );
}

export const records = {
  render() {
    return html`<a class="back" href="#/books">‹ 読んだ本</a>
      <div class="page-head"><div><h1>読書記録</h1><div class="sub">読み終えた本の冊数とページ数（年・月・日）</div></div></div>
      <div id="records-page"><div id="records-body"></div></div>`;
  },
  mount(root, ctx) {
    const page = root.querySelector('#records-page');
    const box = root.querySelector('#records-body');
    const draw = () => {
      if (box.isConnected) box.innerHTML = String(body(ctx));
    };
    // 追加・編集した記録が今の月から外れるときは、その月へ移る
    const showRecord = (change) => {
      const [y, m] = (change.read_on || '').split('-').map(Number);
      const p = periodOf(ctx.query);
      if (change.type === 'read' && (y !== p.year || m !== p.month)) location.hash = periodHref({ year: y, month: m });
      else draw();
    };
    page.addEventListener('click', (e) => {
      const el = e.target.closest('[data-rec]');
      if (!el) return;
      if (el.dataset.rec === 'reload') reload(draw);
      else if (rec.status !== 'ready') toast('記録を読み込んでから操作してください');
      else if (el.dataset.rec === 'add') openRecordSheet(ctx.state, { onSaved: showRecord });
      else if (el.dataset.rec === 'edit') openRecordSheet(ctx.state, { bookId: el.dataset.id, onSaved: showRecord });
    });
    page.addEventListener('submit', (e) => {
      const form = e.target.closest('form[data-rec-form="token"]');
      if (!form) return;
      e.preventDefault();
      const clear = e.submitter?.value === 'clear';
      const token = clear ? '' : String(new FormData(form).get('token') || '').trim();
      if (!clear && !token) return toast('トークンを貼ってください');
      if (!storeToken(token)) return toast('このブラウザには保存できませんでした（プライベートブラウズなど）', 5000);
      toast(clear ? 'この端末からトークンを消しました' : 'トークンを保存しました');
      reload(draw);
    });
    if (rec.status === 'idle' || rec.status === 'error') reload(draw);
    else draw();
    // 本の画面の「読書記録をつける」から来たら、その本で記録のシートを開く（開いたら URL から外す）
    const bookId = ctx.query.get('book');
    if (bookId) {
      const params = new URLSearchParams(ctx.query);
      params.delete('book');
      history.replaceState(null, '', `#/records${params.toString() ? `?${params}` : ''}`);
      ctx.query = params;
      const open = () => {
        if (rec.status !== 'ready') return toast(rec.status === 'error' ? recordsErrorMessage(rec.error) : '記録を読み込めませんでした', 5000);
        if (!loadToken()) return toast('記録をつけるには、下の「記録の保存先（GitHub）」でトークンを保存してください', 5000);
        openRecordSheet(ctx.state, { bookId, onSaved: showRecord });
      };
      loading.then(() => box.isConnected && open());
    }
  },
};

// 文章の骨組みの画面（G9）: 一覧（#/outlines）・材料を選んで作る（#/outline/new）・骨組み 1 つ（#/outline/<id>）・直すシート・知識の画面の欄
// 骨組みを作るのは PC のローカル LLM（スマホからも PC を通す）。引用は点の今の文をそのまま出す
import { html } from '../html.js';
import { isoDate, truncate } from '../../core/text.js';
import { liveNotes } from '../../core/notes.js';
import { HEADING_MAX, OUTLINE_TITLE_MAX, liveOutlines, outlinesOf } from '../../core/outlines.js';
import { PICKS_MAX, quoteOf } from '../../core/outline-draft.js';
import { semanticAvailability } from './ask.js';

// 知識の画面に並べる数（残りは一覧で見る）
const ON_KNOWLEDGE = 3;
const KIND_LABEL = { plane: '面', line: '線', note: '永久ノート' };

/** 材料（面・線・永久ノート）の名前。今の分析・ノートにあればリンクにする */
function sourceLabel(state, s) {
  const label = `${KIND_LABEL[s.kind]}「${s.name}」`;
  if (s.kind === 'plane' && state.analysis?.planes.some((p) => p.id === s.id)) return html`<a href="#/knowledge/plane/${s.id}">${label}</a>`;
  if (s.kind === 'line' && state.analysis?.lines.some((l) => l.id === s.id)) return html`<a href="#/knowledge/line/${s.id}">${label}</a>`;
  if (s.kind === 'note' && liveNotes(state.library).some((n) => n.id === s.id)) return html`<a href="#/note/${s.id}">${label}</a>`;
  return label;
}

function outlineRow(o) {
  return html`<li><a class="note-item" href="#/outline/${o.id}">
    <span class="note-title">${o.title || '（題なし）'}</span>
    <span class="note-excerpt">${o.sections.map((s) => s.heading).filter(Boolean).join(' / ')}</span>
    <span class="note-meta">節 ${o.sections.length} ・ ${o.sources.map((s) => `${KIND_LABEL[s.kind]}「${s.name}」`).join('・') || '材料なし'} ・ ${isoDate(o.updatedAt)}</span>
  </a></li>`;
}

/** 知識の画面の「文章の骨組み」 */
export function outlinesSummaryBlock(state) {
  const list = liveOutlines(state.library);
  return html`<div class="section"><h2>文章の骨組み</h2>${list.length ? html`<a class="small" href="#/outlines">すべて見る（${list.length}）</a>` : html`<a class="small" href="#/outline/new">骨組みを作る</a>`}</div>
    ${list.length
      ? html`<ul class="note-list">${list.slice(0, ON_KNOWLEDGE).map(outlineRow)}</ul>`
      : html`<p class="card small muted">面・線・永久ノートを選ぶと、PC の AI が、人に読ませる文章の見出し・各節の要点・使う引用を作ります。引用は点の文そのままです。直して Markdown でコピーできます。</p>`}`;
}

export const outlinesView = {
  render({ state }) {
    const list = liveOutlines(state.library);
    return html`<a class="back" href="#/knowledge">‹ 知識</a>
      <div class="page-head"><div><h1>文章の骨組み</h1><div class="sub">面・線・永久ノートから、人に読ませる文章の見出し・要点・引用を作ります</div></div><a class="btn small primary" href="#/outline/new">＋ 作る</a></div>
      <p class="small muted" style="margin-top:8px">${list.length} 件</p>
      ${list.length ? html`<ul class="note-list">${list.map(outlineRow)}</ul>` : html`<p class="empty">まだ骨組みはありません。「＋ 作る」か、面・線・永久ノートの画面の「文章の骨組みを作る」から作れます。</p>`}`;
  },
};

/** 作っている間・失敗の表示（state.outlineDraft = { status: 'pending'|'error', error? }） */
export function outlineStatusBlock(state) {
  const d = state.outlineDraft;
  if (d?.status === 'pending') return html`<p class="notice" role="status">PC の AI が骨組みを作っています（1 分ほどかかることがあります）。できあがるまで、この画面を開いたままにしてください。</p>`;
  if (d?.status === 'error') return html`<p class="notice err" role="alert">${d.error}</p>`;
  return '';
}

const check = (name, value, label, on, sub = '') => html`<label class="check"><input type="checkbox" name="${name}" value="${value}" ${on ? 'checked' : ''}> <span>${label}${sub ? html` <span class="small muted">${sub}</span>` : ''}</span></label>`;

/** 材料を選んで作る画面（#/outline/new?plane=…&line=…&note=…。選んだ状態で開ける） */
export const outlineNewView = {
  render({ state, query }) {
    const why = semanticAvailability(state);
    const chosen = { plane: new Set(query.getAll('plane')), line: new Set(query.getAll('line')), note: new Set(query.getAll('note')) };
    const a = state.analysis;
    const lines = new Map((a?.lines || []).map((l) => [l.id, l]));
    const notes = liveNotes(state.library);
    const pending = state.outlineDraft?.status === 'pending';
    return html`<a class="back" href="#/outlines">‹ 文章の骨組み</a>
      <div class="page-head"><div><h1>骨組みを作る</h1><div class="sub">材料を選びます（${PICKS_MAX} つまで）。PC の AI が、見出し・各節の要点・使う引用を作ります</div></div></div>
      ${why === 'ok' ? '' : html`<p class="notice">骨組みを作るのは、PC（bh serve）とつながっているときです（PC の AI を使うため）。</p>`}
      <form class="stack" data-form="outline-new">
        ${a?.planes.length
          ? html`<fieldset class="stack"><legend>面と線</legend>
              ${a.planes.map((p) => {
                const ls = p.lineIds.map((id) => lines.get(id)).filter(Boolean);
                const open = ls.some((l) => chosen.line.has(l.id));
                return html`<div>${check('plane', p.id, p.name, chosen.plane.has(p.id), `線 ${ls.length}`)}
                  <details ${open ? 'open' : ''}><summary class="small">線から選ぶ</summary>
                    ${ls.map((l) => check('line', l.id, l.name, chosen.line.has(l.id), `点 ${l.highlightIds.length}`))}
                  </details></div>`;
              })}
            </fieldset>`
          : html`<p class="small muted">面と線は、分析すると選べます（知識の画面の「分析し直す」）。</p>`}
        ${notes.length
          ? html`<fieldset><legend>永久ノート</legend><details ${chosen.note.size ? 'open' : ''}><summary class="small">ノートから選ぶ（${notes.length}）</summary>
              ${notes.map((n) => check('note', n.id, n.title || '（題なし）', chosen.note.has(n.id), `根拠の点 ${n.pointIds.length}`))}
            </details></fieldset>`
          : ''}
        <div class="row"><button class="btn primary" id="outline-submit" ${why === 'ok' && !pending ? '' : 'disabled'}>骨組みを作る</button><span class="small muted">引用は点の文そのまま。作ったあとで直せます</span></div>
      </form>
      <div id="outline-status">${outlineStatusBlock(state)}</div>`;
  },
  // 選んだ材料を URL に残す（同期のあとの描き直しで、チェックが開いたときの状態に戻らないように）
  mount(root) {
    const form = root.querySelector('form[data-form="outline-new"]');
    form?.addEventListener('change', () => {
      const d = new FormData(form);
      const q = new URLSearchParams();
      for (const kind of ['plane', 'line', 'note']) for (const id of d.getAll(kind)) q.append(kind, String(id));
      history.replaceState(null, '', `#/outline/new${q.toString() ? `?${q}` : ''}`);
    });
  },
};

/** 引用 1 つ（点の今の文をそのまま。書名と位置。押すとその点へ） */
function quoteBlock(library, id) {
  const q = quoteOf(library, id);
  if (q.gone) return html`<blockquote class="outline-quote gone"><p>${q.notYet ? '（この端末にまだ無い点。PC と同期すると出ます）' : '（消えた点）'}</p></blockquote>`;
  return html`<blockquote class="outline-quote"><p>${q.text}</p><footer>— ${q.source} <a href="#/point/${q.id}">点へ</a></footer></blockquote>`;
}

export const outlineView = {
  render({ state, params }) {
    const all = outlinesOf(state.library);
    const o = Object.hasOwn(all, params.id) ? all[params.id] : null;
    if (!o || o.deleted) return html`<a class="back" href="#/outlines">‹ 文章の骨組み</a><p class="empty">この骨組みは見つかりません（消した可能性があります）。<a href="#/outlines">骨組みの一覧へ</a></p>`;
    return html`<a class="back" href="#/outlines">‹ 文章の骨組み</a>
      <div class="layer-label note">文章の骨組み</div>
      <h1 class="note-h1">${o.title || '（題なし）'}</h1>
      <p class="small muted">${isoDate(o.createdAt)} に作成 ・ ${isoDate(o.updatedAt)} に更新${o.sources.length ? html` ・ 材料: ${o.sources.map((s, i) => html`${i ? '・' : ''}${sourceLabel(state, s)}`)}` : ''}</p>
      <div class="row" style="margin-top:12px"><button class="btn small" data-action="outline-edit" data-id="${o.id}">直す</button><button class="btn small primary" data-action="outline-copy" data-id="${o.id}">Markdown をコピー</button></div>
      ${o.sections.map(
        (s) => html`<section class="card stack outline-section">
          <h2>${s.heading || '（見出しなし）'}</h2>
          ${s.points.length ? html`<ul class="plain outline-points">${s.points.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
          ${s.quotes.map((id) => quoteBlock(state.library, id))}
        </section>`,
      )}
      <div class="row" style="margin-top:16px"><button class="btn small danger" data-action="outline-delete" data-id="${o.id}">この骨組みを削除</button></div>`;
  },
};

/** 直すシートの中身（題・各節の見出し・要点（1 行 1 つ）・引用を外す・節を消す・節を足す） */
export function outlineSheet(library, o) {
  return html`<h2>骨組みを直す</h2>
    <label class="field"><span>題</span><input type="text" name="title" maxlength="${OUTLINE_TITLE_MAX}" value="${o.title}"></label>
    ${o.sections.map(
      (s, i) => html`<fieldset class="stack outline-edit"><legend>節 ${i + 1}</legend>
        <label class="field"><span>見出し</span><input type="text" name="heading-${i}" maxlength="${HEADING_MAX}" value="${s.heading}"></label>
        <label class="field"><span>要点（1 行に 1 つ）</span><textarea name="points-${i}" rows="4">${s.points.join('\n')}</textarea></label>
        ${s.quotes.length ? html`<div><span class="small muted">引用（外すときはチェックを外す）</span>${s.quotes.map((id) => {
          const q = quoteOf(library, id);
          return check(`quote-${i}`, id, q.gone ? (q.notYet ? '（この端末にまだ無い点）' : '（消えた点）') : truncate(q.text.replace(/\s+/g, ' '), 60), true);
        })}</div>` : ''}
        ${check(`drop-${i}`, '1', 'この節を消す', false)}
      </fieldset>`,
    )}
    <label class="field"><span>節を足す（見出し。足さないなら空のまま）</span><input type="text" name="heading-new" maxlength="${HEADING_MAX}" value=""></label>
    <div class="row spread"><span></span><span class="row"><button class="btn" value="cancel">やめる</button><button class="btn primary" value="save">保存</button></span></div>`;
}

/** 直すシートの送信を、題と節に読む（form は FormData と同じ get・getAll を持つ） */
export function readOutlineSheet(form, o) {
  const sections = o.sections
    // 要点は 1 行 1 つ（空の行は先に除く。数の上限は空でない行で数える）
    .map((s, i) => (form.get(`drop-${i}`) ? null : { heading: String(form.get(`heading-${i}`) ?? ''), points: String(form.get(`points-${i}`) ?? '').split('\n').map((l) => l.trim()).filter(Boolean), quotes: form.getAll(`quote-${i}`).map(String) }))
    .filter(Boolean);
  const extra = String(form.get('heading-new') ?? '').trim();
  return { title: String(form.get('title') ?? ''), sections: extra ? [...sections, { heading: extra, points: [], quotes: [] }] : sections };
}

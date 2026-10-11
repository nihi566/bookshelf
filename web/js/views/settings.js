// 取り込み・設定の画面
import { html } from '../html.js';
import { deletedBooks, deletedHighlights, libraryStats } from '../../core/model.js';
import { ACCEPT } from '../../core/parsers/index.js';
import { isoDate } from '../../core/text.js';
import { kindleSyncLines } from '../ui.js';
import { syncButton } from '../sync-busy.js';

/** 取り込み画面の Kindle 自動取り込みの状態欄の中身。拡張からの確認結果は PC が持っているので、PC モードで PC の情報を取れているときだけ出す */
export function kindleSyncBlock(state) {
  const lines = state.settings.ai.mode === 'companion' && state.pcInfo ? kindleSyncLines(state.pcInfo.kindleSync) : [];
  return html`${lines.map((l) => html`<p class="small">${l}</p>`)}`;
}

/** 時刻を短く（例: 10/4 18:05）。無ければ — */
function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Play ブックスで最後に新しい点が届いた時刻・件数（PC の state.json に残るので、bh serve を起動し直しても消えない） */
function lastNewText(n) {
  return n?.at ? `${shortTime(n.at)}・${Number(n.added) || 0} 件${n.updated ? `（更新 ${n.updated} 件）` : ''}` : 'まだ届いていません';
}

/** 設定 → 接続を確認 の Play ブックスの要約（取り込み画面と同じ「最後に新しい点」を出す） */
export function googleLabel(g) {
  if (!g) return '未対応（PC の bh を更新してください）';
  if (!g.active) return g.error || '未設定';
  const problems = g.problemCount ?? g.problems?.length ?? 0;
  return `有効（最終確認 ${shortTime(g.lastCheck)}・最後に新しい点 ${lastNewText(g.lastNew)}）${problems ? ` ／ 取り込めない本 ${problems} 冊（取り込みの画面に理由）` : ''}${g.error ? ` ／ ${g.error}` : ''}`;
}

/** 設定 → 接続を確認 の Kindle（ブラウザ拡張）の要約。拡張から連絡が無い（ks が null）ときも「まだ届いていません」 */
export function kindleLabel(ks) {
  return `最後に新しい点 ${lastNewText(ks?.lastNew)}`;
}

/**
 * 取り込み画面の Play ブックス自動取り込みの状態欄の中身（PC がドライブを見張っている結果）。
 * 取り込めない本は、文書が直るまで出し続ける（PC の記録に残っている）
 */
export function playbooksSyncBlock(state) {
  if (state.settings.ai.mode !== 'companion' || !state.pcInfo) return '';
  const g = state.pcInfo.google;
  if (!g) return html`<p class="small">自動取り込み: 未対応（PC の bh を更新してください）</p>`;
  if (!g.active) return html`<p class="small">自動取り込み: ${g.error || '未設定'}</p>`;
  const problems = Array.isArray(g.problems) ? g.problems : [];
  const count = Number.isInteger(g.problemCount) ? g.problemCount : problems.length;
  return html`<p class="small">自動取り込み: 有効（最終確認 ${shortTime(g.lastCheck)}）</p>
    <p class="small">最後に新しい点: ${lastNewText(g.lastNew)}</p>
    ${count
      ? html`<details class="pb-problems">
          <summary class="small">取り込めない本 ${count} 冊（押すと理由）</summary>
          <ul class="plain small">${problems.map((p) => html`<li><b>${p.name}</b><br><span class="muted">${p.error}</span></li>`)}</ul>
          ${count > problems.length ? html`<p class="small muted">ほか ${count - problems.length} 冊</p>` : ''}
          <p class="help">Play ブックスがハイライトの文をドライブのメモに書き出していない本は、ここからは取り込めません（出版社の設定によります）。文書が更新されて読めるようになると、自動で取り込んでこの一覧から消えます。</p>
        </details>`
      : ''}`;
}

/**
 * 取り込みの結果のまとめ。読めなかったファイルがあれば、通知と欄の色で成功と区別する
 * @returns {{ failed: number, summary: string, message: string, tone: 'ok' | '' | 'err', note: string }}
 */
export function importOutcome(results, stats) {
  const total = results.length;
  const failed = results.filter((r) => r.error).length;
  const summary = `新しい点 ${stats.added} 件${stats.updated ? `・更新 ${stats.updated} 件` : ''}${stats.unchanged ? `・既存 ${stats.unchanged} 件` : ''}`;
  if (failed && failed === total) {
    const what = total === 1 ? 'ファイルを読めませんでした' : `${total} 件のファイルがすべて読めませんでした`;
    return { failed, summary, message: `取り込めませんでした: ${total === 1 ? 'ファイルを読めません' : `${total} 件のファイルがすべて読めません`}`, tone: 'err', note: `${what}（理由は下）` };
  }
  if (failed) {
    return { failed, summary, message: `取り込みました（${failed} 件のファイルは読めませんでした）: ${summary}`, tone: '', note: `${summary}。${total} 件のうち ${failed} 件のファイルは読めませんでした（理由は下）` };
  }
  return { failed, summary, message: `取り込みました: ${summary}`, tone: stats.added || stats.backups ? 'ok' : '', note: summary };
}

// 取り込み画面の取り出し方の説明（下の details の id と、案内のボタンに出す名前）
const HELP = {
  kindleDevice: { id: 'help-kindle-device', label: 'Kindle 端末' },
  kindleExport: { id: 'help-kindle-export', label: 'Kindle のエクスポート' },
  kindleBookmarklet: { id: 'help-kindle-bookmarklet', label: 'ブックマークレット' },
  playbooks: { id: 'help-playbooks', label: 'Play ブックスのメモ' },
  readingNotes: { id: 'help-reading-notes', label: '読書メモ' },
};
const HELP_BY_EXT = {
  txt: [HELP.kindleDevice],
  html: [HELP.kindleExport, HELP.playbooks],
  htm: [HELP.kindleExport, HELP.playbooks],
  docx: [HELP.playbooks],
  zip: [HELP.playbooks],
  json: [HELP.kindleBookmarklet],
  md: [HELP.readingNotes],
};

/**
 * 読めなかったファイルに添える取り出し方の説明。拡張子から、そのファイルで取り込もうとしたらしい方法を選ぶ。分からない形式は主な取り出し方を並べる
 * @param {string} name ファイル名
 * @returns {{ id: string, label: string }[]}
 */
export function importHelpTargets(name) {
  const ext = /\.([^.]+)$/.exec(String(name ?? ''))?.[1].toLowerCase();
  // a.constructor のような名前で Object の持ち物を拾わないよう、自分の持ち物だけを見る
  return (ext && Object.hasOwn(HELP_BY_EXT, ext)) ? HELP_BY_EXT[ext] : [HELP.kindleDevice, HELP.kindleExport, HELP.playbooks];
}

/** 読めなかったファイルの行の、取り出し方の説明を開くボタン */
function importHelpLinks(name) {
  return html`<div class="row small" style="margin-top:4px">取り出し方: ${importHelpTargets(name).map((t) => html`<button type="button" class="btn small" data-action="open-import-help" data-target="${t.id}">${t.label}</button>`)}</div>`;
}

/**
 * 新しい点が入ったときの、分析への導線（知識の画面の「分析し直す」へ）。PC の自動の分析がオンなら、自動で分析される旨を添える
 * @param {number} added 新しい点の数
 * @param {object} [state] 自動の分析の状態を見るため（無ければ自動の一言は出さない）
 */
function analyzeLink(added, state) {
  if (!added) return { button: '', note: '' };
  const auto = state?.settings?.ai?.mode === 'companion' && state.pcInfo?.autoAnalysis?.enabled === true;
  return {
    button: html`<a class="btn small primary" href="#/knowledge">分析する</a>`,
    note: auto ? html`<p class="small muted">PC の自動の分析がオンです。条件を満たすと PC が分析し直します。すぐに線につなぐなら「分析する」から。</p>` : '',
  };
}

/** 取り込み画面の結果欄の中身。{ error } は読み込みそのものの失敗、{ results, stats, analysisChanged } はファイルごとの結果 */
export function importResultBlock(result, state) {
  if (result.error) return html`<p class="notice err">${result.error}</p>`;
  const { results, stats } = result;
  const o = importOutcome(results, stats);
  const analyze = analyzeLink(stats.added, state);
  return html`<div class="card" style="margin-top:12px">
        <p class="notice${o.tone ? ` ${o.tone}` : ''}">${o.note}${result.analysisChanged ? '（バックアップの新しい分析結果も反映）' : ''}</p>
        <ul class="result-list">${results.map((r) => html`<li>${r.error ? '✗' : '✓'} <b>${r.name}</b><br><span class="small muted">${r.error || `${r.formatLabel} — 本 ${r.books} 冊 / 点 ${r.highlights} 件${r.images ? `（画像 ${r.images} 枚は取り込めません）` : ''}`}</span>${r.error ? importHelpLinks(r.name) : ''}</li>`)}</ul>
        ${stats.memoTitles?.length ? html`<p class="small muted">既にある本にまとめた読書メモ: ${stats.memoTitles.map((m) => `「${m.from}」→『${m.to}』`).join('、')}</p>` : ''}
        ${analyze.note}
        <div class="row" style="margin-top:8px">${analyze.button}<a class="btn small" href="#/books">本を見る</a></div>
      </div>`;
}

export const importView = {
  render({ state, refresh }) {
    return html`<a class="back" href="#/settings">‹ 設定</a>
      <div class="page-head"><div><h1>取り込み</h1><div class="sub">ファイルは端末の中だけで読み取ります</div></div></div>
      <label class="drop" id="drop">
        <input type="file" id="file-input" multiple accept="${ACCEPT}">
        <b>ファイルを選ぶ</b><br><span class="help">またはここにドロップ（.txt .html .docx .md .json .zip）</span>
      </label>
      <div id="import-result">${refresh && state.lastImport ? importResultBlock(state.lastImport, state) : ''}</div>

      <div class="section"><h2>Kindle</h2></div>
      <div class="card">
        <div id="kindle-sync">${kindleSyncBlock(state)}</div>
        <details>
          <summary>Kindle アプリで読んでいる（おすすめ: 自動取り込みの拡張機能）</summary>
          <p class="help">アプリで引いた線は Amazon のノートブック（read.amazon.co.jp/notebook）に集まります。PC の Chrome / Edge に拡張機能を入れておくと、ノートブックを定期的に（既定 15 分ごと）確認し、新しい線だけを PC の bh serve に送ります。この画面には PC との同期で届きます。</p>
          <ol class="help">
            <li>PC で <span class="code">bh serve</span> を起動しておきます。</li>
            <li>Chrome / Edge で <span class="code">chrome://extensions</span> を開き、「デベロッパー モード」をオン →「パッケージ化されていない拡張機能を読み込む」でリポジトリの <span class="code">extension</span> フォルダを選びます。</li>
            <li>開いた設定画面に出るコマンド（<span class="code">bh config origin chrome-extension://…</span>）を PC で実行し、bh serve を再起動します。</li>
            <li>同じブラウザで <a href="https://read.amazon.co.jp/notebook" target="_blank" rel="noopener">read.amazon.co.jp/notebook</a> にログインしておきます。ログインしたらこのタブは閉じてかまいません。</li>
          </ol>
          <p class="help">ノートブックを開いたままにする必要はありません。Chrome が起動していて Amazon にログインしたままなら、裏側で確認します。ログインが切れると、拡張機能の状態欄とこの画面の Kindle 欄（ホームの先頭にも）に「Amazon のログインが切れています」と出ます。そのときだけノートブックを開いてログインし直してください。</p>
          <p class="help">Amazon のパスワードや Cookie は保存しません。ブラウザを閉じている間と、線がノートブックに反映されるまでの数分は届きません。</p>
        </details>
        <details id="help-kindle-bookmarklet">
          <summary>Kindle アプリの線を手動でまとめて取り込む（ブックマークレット）</summary>
          <p class="help">PC を常に動かしていない場合はこちら。PC のブラウザで次の手順を 1 度設定すれば、全ての本のハイライトをまとめて取り込めます。</p>
          <ol class="help">
            <li>下のボタンをブックマークバーにドラッグして登録します（または「コピー」して、新しいブックマークの URL に貼り付けます）。</li>
            <li><a href="https://read.amazon.co.jp/notebook" target="_blank" rel="noopener">read.amazon.co.jp/notebook</a> を開いてログインします。</li>
            <li>登録したブックマークをクリック → 集め終わったら「アプリに送る」か「ファイルに保存」。保存した JSON はこの画面で取り込めます。</li>
          </ol>
          <div class="row"><a class="btn primary" id="bookmarklet" href="#" title="ブックマークバーへドラッグ">📥 Kindle ハイライトを集める</a><button class="btn small" data-action="copy-bookmarklet">コピー</button></div>
        </details>
        <details id="help-kindle-device">
          <summary>Kindle 端末（Paperwhite など）で読んでいる</summary>
          <ol class="help">
            <li>Kindle を USB で PC につなぎます。</li>
            <li><span class="code">documents/My Clippings.txt</span> を選んで取り込みます。</li>
          </ol>
          <p class="help">何度取り込んでも重複しません。伸ばしたハイライトは新しい方に置き換わります。</p>
        </details>
        <details id="help-kindle-export">
          <summary>アプリの「ノートブックをエクスポート」を使う（1 冊ずつ）</summary>
          <p class="help">Kindle アプリで本を開く → ノートブック → 共有（エクスポート）→「引用なし」でメール送信。届いた HTML ファイルを取り込みます。</p>
        </details>
      </div>

      <div class="section"><h2>Play ブックス</h2></div>
      <div class="card">
        <div id="playbooks-sync">${playbooksSyncBlock(state)}</div>
        <details id="help-playbooks">
          <summary>Google ドライブの「Play ブックスのメモ」から</summary>
          <ol class="help">
            <li>Play ブックスの設定で「メモ、ハイライト、しおりを Google ドライブに保存」をオンにします（本ごとのドキュメントが自動で作られます）。</li>
            <li>PC: Google ドライブで <b>「Play ブックスのメモ」フォルダを右クリック → ダウンロード</b>。できた zip をそのまま取り込めます。</li>
            <li>スマホ: ドキュメントを開き「共有とエクスポート → 形式を指定して保存 → Word（.docx）」で保存し、ここで選びます。</li>
          </ol>
          <p class="help">.docx / .html / .md のどれでも読めます。ドキュメントが自動で更新されるので、時々ダウンロードし直すと差分だけ増えます。</p>
          <p class="help"><b>自動で取り込むには:</b> PC で <code>bh google login</code> して <code>bh serve</code> を動かしておくと、PC がドライブを 1 分ごとに確認し、新しく引いた線を取り込みます（Google がドキュメントを更新するまで数分かかることがあります）。この画面にも PC との同期で届きます。手順は docs/setup.md の「Play ブックスの自動取り込み」。</p>
        </details>
      </div>

      <div class="section"><h2>紙の本・読書メモ</h2></div>
      <div class="card" id="help-reading-notes">
        <p class="help">紙の本は <a href="#/books">読んだ本</a> の「＋ 紙の本」で書名と表紙を登録し、本の画面で線を引いた文を入力します。</p>
        <p class="help">Obsidian などに書いた<b>読書メモ（.md）</b>は、上の欄でそのまま選べます（複数可）。ファイル名を書名にし、見出しを章、段落・箇条書きの項目を 1 点ずつにします。書名の一部が同じ本が 1 冊だけあればその本にまとめ、既にある線と同じ文は増やしません。画像の埋め込みは取り込めません。PC では <code>bh import &lt;フォルダ&gt;</code> でフォルダごと取り込めます。</p>
      </div>

      <div class="section"><h2>ほかに</h2></div>
      <div class="card row spread"><span class="help grow">架空の 8 冊・48 の点で動きを試せます。</span><button class="btn" data-action="load-sample">サンプルを入れる</button></div>
      <p class="small muted" style="margin-top:12px">現在: 本 ${libraryStats(state.library).books} 冊 / 点 ${libraryStats(state.library).points} 件</p>`;
  },
};

/** 削除した点の入口に出す件数（削除した本は点と分けて冊で数える） */
function trashCount(library) {
  const points = deletedHighlights(library).length;
  const books = deletedBooks(library).length;
  if (!books) return `${points} 件`;
  return points ? `${points} 件・本 ${books} 冊` : `本 ${books} 冊`;
}

export const settingsView = {
  render({ state }) {
    const ai = state.settings.ai;
    const s = libraryStats(state.library);
    return html`<div class="page-head"><h1>設定</h1></div>
      <div class="card stack">
        <a class="row spread" href="#/import"><b>取り込み</b><span class="muted">Kindle・Play ブックス・<span class="nowrap">読書メモ ›</span></span></a>
      </div>

      <div class="section"><h2>AI（ローカル LLM）</h2></div>
      <form class="card" data-form="ai-settings">
        <fieldset style="border:none;padding:0;margin:0">
          <legend class="small muted">分析を動かす場所</legend>
          <label class="check" style="margin:8px 0"><input type="radio" name="mode" value="companion" ${ai.mode === 'companion' ? 'checked' : ''}> <span><b>PC のコンパニオンサーバ</b><span class="nowrap">（おすすめ・</span><span class="nowrap">スマホからも可）</span></span></label>
          <label class="check" style="margin:8px 0"><input type="radio" name="mode" value="direct" ${ai.mode === 'direct' ? 'checked' : ''}> <span><b>このブラウザから LLM に直接</b>（PC のみ）</span></label>
        </fieldset>
        <div data-show="companion" ${ai.mode === 'companion' ? '' : 'hidden'}>
          <label class="field"><span>コンパニオンサーバの URL</span><input type="url" name="companionUrl" value="${ai.companionUrl}" placeholder="${state.servedByCompanion ? location.origin : 'http://localhost:8787'}"></label>
          ${state.servedByCompanion ? '' : html`<p class="help">例: <span class="code">http://localhost:8787</span> または <span class="code">https://&lt;PC名&gt;.&lt;tailnet&gt;.ts.net</span></p>`}
          <label class="field"><span>トークン（設定した場合のみ）</span><input type="password" name="token" value="${ai.token}" autocomplete="off"></label>
          <p class="help">PC で <span class="code">node cli/bh.js serve</span>（<span class="code">npm link</span> 済みなら <span class="code">bh serve</span>）を起動します。スマホからは <span class="code">tailscale serve --bg 8787</span> で表示される https の URL を入れます。モデルは PC 側で <span class="code">bh config model …</span> で設定します。</p>
        </div>
        <div data-show="direct" ${ai.mode === 'direct' ? '' : 'hidden'}>
          <label class="field"><span>LLM サーバの URL（OpenAI 互換）</span><input type="url" name="baseUrl" value="${ai.baseUrl}" placeholder="http://localhost:11434"></label>
          <label class="field"><span>チャットモデル</span><input type="text" name="chatModel" value="${ai.chatModel}" list="model-list" placeholder="例: qwen3.5:9b"></label>
          <label class="field"><span>埋め込みモデル（任意）</span><input type="text" name="embedModel" value="${ai.embedModel}" list="model-list" placeholder="例: bge-m3（空なら文字の特徴で代用）"></label>
          <datalist id="model-list"></datalist>
          <p class="help">Ollama は環境変数 <span class="code">OLLAMA_ORIGINS=${location.origin}</span> を設定して再起動してください。Safari は https のページから localhost に接続できないため、コンパニオンサーバを使ってください。</p>
        </div>
        <div class="row"><button class="btn primary" type="submit">保存</button><button class="btn" type="submit" value="test">接続を確認</button></div>
        <div id="ai-test"></div>
      </form>

      <div class="section"><h2>PC と同期</h2></div>
      <div class="card stack">
        <p class="help">スマホで取り込んだ点や編集を PC に送り、PC の分析結果を受け取ります（コンパニオンサーバ経由）。</p>
        <label class="check"><input type="checkbox" data-action="toggle-autosync" ${state.settings.autoSync ? 'checked' : ''}> 自動で同期する（起動時と、開いている間 PC に新しい線が入ったとき）</label>
        <div class="row">${syncButton(state, '今すぐ同期')}<span class="small muted">${state.lastSync ? `最終: ${isoDate(state.lastSync)} ${new Date(state.lastSync).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : '未同期'}</span></div>
      </div>

      <div class="section"><h2>データ</h2></div>
      <div class="card stack">
        <p class="help">ハイライトと思いつきはこの端末（ブラウザ）の中だけに保存されています。本 ${s.books} 冊 / 点 ${s.points} 件${s.thoughts ? `（うち思いつき ${s.thoughts} 件）` : ''}。</p>
        <a class="row spread" href="#/trash"><b>削除した点</b><span class="muted">${trashCount(state.library)} ›</span></a>
        <div class="row"><button class="btn" data-action="backup">バックアップを保存</button><a class="btn" href="#/import">バックアップから戻す</a></div>
        <button class="btn danger" data-action="clear-all">この端末のデータをすべて消す</button>
      </div>
      <p class="small muted" style="margin:24px 0 8px;text-align:center">本棚 — <a href="https://github.com/nihi566/bookshelf" target="_blank" rel="noopener">GitHub</a></p>`;
  },
  mount(root) {
    const form = root.querySelector('form[data-form="ai-settings"]');
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'mode') return;
      for (const el of form.querySelectorAll('[data-show]')) el.hidden = el.dataset.show !== e.target.value;
    });
  },
};

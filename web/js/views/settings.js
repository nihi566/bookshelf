// 取り込み・設定の画面
import { html } from '../html.js';
import { libraryStats } from '../../core/model.js';
import { ACCEPT } from '../../core/parsers/index.js';
import { isoDate } from '../../core/text.js';
import { kindleSyncLines } from '../ui.js';

/** 取り込み画面の Kindle 自動取り込みの状態欄の中身。拡張からの確認結果は PC が持っているので、PC モードで PC の情報を取れているときだけ出す */
export function kindleSyncBlock(state) {
  const lines = state.settings.ai.mode === 'companion' && state.pcInfo ? kindleSyncLines(state.pcInfo.kindleSync) : [];
  return html`${lines.map((l) => html`<p class="small">${l}</p>`)}`;
}

export const importView = {
  render({ state }) {
    return html`<a class="back" href="#/settings">‹ 設定</a>
      <div class="page-head"><div><h1>取り込み</h1><div class="sub">ファイルは端末の中だけで読み取ります</div></div></div>
      <label class="drop" id="drop">
        <input type="file" id="file-input" multiple accept="${ACCEPT}">
        <b>ファイルを選ぶ</b><br><span class="help">またはここにドロップ（.txt .html .docx .md .json .zip）</span>
      </label>
      <div id="import-result"></div>

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
        <details>
          <summary>Kindle アプリの線を手動でまとめて取り込む（ブックマークレット）</summary>
          <p class="help">PC を常に動かしていない場合はこちら。PC のブラウザで次の手順を 1 度設定すれば、全ての本のハイライトをまとめて取り込めます。</p>
          <ol class="help">
            <li>下のボタンをブックマークバーにドラッグして登録します（または「コピー」して、新しいブックマークの URL に貼り付けます）。</li>
            <li><a href="https://read.amazon.co.jp/notebook" target="_blank" rel="noopener">read.amazon.co.jp/notebook</a> を開いてログインします。</li>
            <li>登録したブックマークをクリック → 集め終わったら「アプリに送る」か「ファイルに保存」。保存した JSON はこの画面で取り込めます。</li>
          </ol>
          <div class="row"><a class="btn primary" id="bookmarklet" href="#" title="ブックマークバーへドラッグ">📥 Kindle ハイライトを集める</a><button class="btn small" data-action="copy-bookmarklet">コピー</button></div>
        </details>
        <details>
          <summary>Kindle 端末（Paperwhite など）で読んでいる</summary>
          <ol class="help">
            <li>Kindle を USB で PC につなぎます。</li>
            <li><span class="code">documents/My Clippings.txt</span> を選んで取り込みます。</li>
          </ol>
          <p class="help">何度取り込んでも重複しません。伸ばしたハイライトは新しい方に置き換わります。</p>
        </details>
        <details>
          <summary>アプリの「ノートブックをエクスポート」を使う（1 冊ずつ）</summary>
          <p class="help">Kindle アプリで本を開く → ノートブック → 共有（エクスポート）→「引用なし」でメール送信。届いた HTML ファイルを取り込みます。</p>
        </details>
      </div>

      <div class="section"><h2>Play ブックス</h2></div>
      <div class="card">
        <details>
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

      <div class="section"><h2>ほかに</h2></div>
      <div class="card row spread"><span class="help grow">架空の 8 冊・48 の点で動きを試せます。</span><button class="btn" data-action="load-sample">サンプルを入れる</button></div>
      <p class="small muted" style="margin-top:12px">現在: 本 ${libraryStats(state.library).books} 冊 / 点 ${libraryStats(state.library).highlights} 件</p>`;
  },
};

export const settingsView = {
  render({ state }) {
    const ai = state.settings.ai;
    const s = libraryStats(state.library);
    return html`<div class="page-head"><h1>設定</h1></div>
      <div class="card stack">
        <a class="row spread" href="#/import"><b>取り込み</b><span class="muted">Kindle・Play ブックス ›</span></a>
      </div>

      <div class="section"><h2>AI（ローカル LLM）</h2></div>
      <form class="card" data-form="ai-settings">
        <fieldset style="border:none;padding:0;margin:0">
          <legend class="small muted">分析を動かす場所</legend>
          <label class="row" style="margin:8px 0"><input type="radio" name="mode" value="companion" ${ai.mode === 'companion' ? 'checked' : ''}> <span><b>PC のコンパニオンサーバ</b>（おすすめ・スマホからも可）</span></label>
          <label class="row" style="margin:8px 0"><input type="radio" name="mode" value="direct" ${ai.mode === 'direct' ? 'checked' : ''}> <span><b>このブラウザから LLM に直接</b>（PC のみ）</span></label>
        </fieldset>
        <div data-show="companion" ${ai.mode === 'companion' ? '' : 'hidden'}>
          <label class="field"><span>コンパニオンサーバの URL</span><input type="url" name="companionUrl" value="${ai.companionUrl}" placeholder="${state.servedByCompanion ? location.origin : 'http://localhost:8787 または https://<PC名>.<tailnet>.ts.net'}"></label>
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
        <div class="row"><button class="btn" data-action="sync">今すぐ同期</button><span class="small muted">${state.lastSync ? `最終: ${isoDate(state.lastSync)} ${new Date(state.lastSync).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}` : '未同期'}</span></div>
      </div>

      <div class="section"><h2>データ</h2></div>
      <div class="card stack">
        <p class="help">ハイライトはこの端末（ブラウザ）の中だけに保存されています。本 ${s.books} 冊 / 点 ${s.highlights} 件。</p>
        <div class="row"><button class="btn" data-action="backup">バックアップを保存</button><a class="btn" href="#/import">バックアップから戻す</a></div>
        <button class="btn danger" data-action="clear-all">この端末のデータをすべて消す</button>
      </div>
      <p class="small muted" style="margin:24px 0 8px;text-align:center">本 — <a href="https://github.com/nihi566/bookshelf" target="_blank" rel="noopener">GitHub</a></p>`;
  },
  mount(root) {
    const form = root.querySelector('form[data-form="ai-settings"]');
    form.addEventListener('change', (e) => {
      if (e.target.name !== 'mode') return;
      for (const el of form.querySelectorAll('[data-show]')) el.hidden = el.dataset.show !== e.target.value;
    });
  },
};

# セットアップ詳細

## 0. 必要なもの

- PC: Node.js 20 以上、ローカル LLM（[Ollama](https://ollama.com) か LM Studio など OpenAI 互換 API を持つもの）
- スマホ: ブラウザ（Safari / Chrome）。PC の AI を使うなら [Tailscale](https://tailscale.com)

## 1. Web アプリを GitHub Pages で公開する

1. このリポジトリの **Settings → Pages → Build and deployment → Source** を「**GitHub Actions**」にする
2. `main` ブランチに push すると `.github/workflows/pages.yml` がテストして `web/` を公開する
3. `https://<ユーザー名>.github.io/bookshelf/` を開き、スマホではホーム画面に追加する

公開されるのはアプリのプログラムだけです。ハイライトは各端末のブラウザ（IndexedDB）と PC の `data/` にしか保存されません。

非公開（private）リポジトリで GitHub Pages を使うには有料プラン（GitHub Pro など）が必要です。無料プランの場合は、リポジトリを公開にする（ハイライトのデータはリポジトリに含まれないので公開しても中身は漏れません）か、GitHub Pages を使わずに PC の `http://localhost:8787` と Tailscale の URL だけで使ってください（それでもすべての機能が使えます）。

## 2. PC: ローカル LLM

### Ollama

```sh
ollama pull qwen3.5:9b   # チャット。メモリが少なければ qwen3.5:4b、余裕があれば 27b
ollama pull bge-m3       # 埋め込み（多言語）。qwen3-embedding:0.6b なども可
```

- チャットモデルは日本語が得意なもの（Qwen 3.5 / 3.6、Gemma 4 など）を選びます。小さいモデルでも動くよう、1 回の依頼は小さく、出力は JSON スキーマで固定しています
- 思考（thinking）モデルは `reasoning_effort: "none"` で思考を切って呼びます（速く、JSON が崩れにくい）
- 埋め込みモデルは任意です。無い場合は文字 n-gram の TF-IDF で代用します（語彙が同じ点どうしはつながりますが、言い換えには弱くなります）。検索の「意味で探す」と「問いかける」は埋め込みモデルが要ります（無ければ言葉の一致の検索に戻ります）。「答えられない」とする近さの目安は bge-m3 で決めています

### LM Studio / llama.cpp server

```sh
node cli/bh.js config url http://localhost:1234   # LM Studio の既定ポート
```

## 3. PC: `bh` の設定とコンパニオンサーバ

```sh
node cli/bh.js config model qwen3.5:9b
node cli/bh.js config embed bge-m3
node cli/bh.js config origin https://<ユーザー名>.github.io   # GitHub Pages 版から接続する場合
node cli/bh.js serve
```

| コマンド | 内容 |
| --- | --- |
| `bh import <ファイル...>` | 取り込み。このアプリのバックアップ（.json）も取り込め、手元より新しい分析結果なら反映する |
| `bh analyze [--no-recommend]` | 点→線→面→立体の分析とおすすめ |
| `bh recommend` | おすすめだけ選び直す |
| `bh serve [--port 8787] [--host 127.0.0.1]` | コンパニオンサーバ（Google にログイン済みなら Play ブックスを自動取り込み。3.5 節） |
| `bh update` | マージした main を常駐の `bh serve` に反映する（下の「新しいコードに入れ替える」） |
| `bh list` / `bh search <語>` | 一覧・検索 |
| `bh config` | 設定の表示（`data/config.json`） |

データは既定でリポジトリの `data/`（`.gitignore` 済み）に保存されます。`BH_DATA=/path` で変更できます。

常駐させたい場合は、macOS なら launchd、Windows ならタスク スケジューラ、Linux なら systemd のユーザーサービスで `node /path/to/cli/bh.js serve` を起動します。

### 新しいコードに入れ替える（`bh update`）

常駐の `bh serve` は、main をマージしても起動し直すまで古いコードのまま動きます。リポジトリ（main を開いているフォルダ）で `node cli/bh.js update` を実行すると、次を 1 回で行います。

1. `data/` の `library.json`・`analysis.json` を `library.backup-<日時>-before-update.json` のような名前で退避する（コピー。元は変えない）
2. `git pull --ff-only origin main` で main を取り込む。main 以外のブランチにいる・取り込めないときは、ここで止まり、`bh serve` は止めない
3. 設定のポート（既定 8787）で動いている `bh serve` を止める。そのポートを `bh serve` 以外が使っていたら、何も止めずに終わる
4. 起動し直す。Windows でタスク スケジューラに「book-highlights bh serve」というタスクがあればそれを起動し、無ければ `node cli/bh.js serve` を切り離して起動する（出力は `data/serve.log`）
5. 止めた後に起動したサーバが 30 秒以内に応答し、起動したときに読んだ版がディスクの `web/sw.js` と同じかを確かめる（起動したときの版を返さない古いサーバでは、配っている `sw.js` の版で比べる）。確かめられなかったときは、理由に続けて `data/serve.log` の末尾 20 行を出す（ログが無ければ理由だけ）

退避したファイル名・取り込んだコミット・新しい版が表示されます。launchd・systemd で常駐させている場合は、それらが止めた `bh serve` を起動し直すことがあるので、`bh update` ではなく各サービスの再起動を使ってください。

実行を忘れていないかは、Web アプリの 設定 → AI → 接続を確認 で分かります。PC の `bh serve` の起動時刻と、起動したときの版が出ます。その版が画面の版・ディスクの `web/sw.js` の版より古ければ「PC の bh serve が古いコードで動いています（PC で bh update）」と出ます。版は `web/sw.js` の `CACHE` なので、`cli/` だけを変えたときも `CACHE` を上げないと、この表示でも `bh update` の確認でも違いが分かりません。

## 3.5 Play ブックスの自動取り込み（Google ドライブ）

Play ブックスで線を引くと、Google がドライブの「Play ブックスのメモ」フォルダにある本ごとのドキュメントを書き換えます。`bh serve` がそのフォルダを定期的に確認し、更新されたドキュメントだけを取り込みます。スマホの Web アプリには PC との同期で届きます（開いている間は、PC に新しい線が入ったときに自動で同期します）。

```
Play ブックスで線を引く
  → Google がドキュメントを更新（数分かかることがある。間隔は Google 次第）
  → bh serve が確認（既定 60 秒ごと）して取り込み
  → Web アプリが PC と同期
```

### 準備（1 回だけ）

1. Play ブックスの設定で「**メモ、ハイライト、しおりを Google ドライブに保存**」をオンにする
2. [Google Cloud コンソール](https://console.cloud.google.com/) でプロジェクトを作り、「API とサービス → ライブラリ」で **Google Drive API** を有効にする
3. 「Google Auth Platform（OAuth 同意画面）」を作る
   - 対象: **外部**。テストユーザーに自分の Google アカウントを追加する
   - 公開ステータスが「**テスト**」のままだと、ログインが **7 日で切れます**。自分だけで使うなら「**アプリを公開**」で「本番」にしてください（ログイン時に「Google で確認されていないアプリ」と出るので、「詳細 → （安全ではないページ）に移動」で進みます）
4. 「クライアント」で **OAuth クライアント ID** を作る。種類は「**デスクトップ アプリ**」
5. PC で:
   ```sh
   node cli/bh.js config google-client <クライアント ID> <クライアント シークレット>
   node cli/bh.js google login     # ブラウザが開くので、ドライブの「表示」を許可する
   node cli/bh.js serve            # 以後、60 秒ごとに確認
   ```

- 求める権限は「ドライブのファイルの表示」（`drive.readonly`）だけです。ドライブには何も書き込みません
- ログインの鍵（リフレッシュトークン）は `data/google-token.json` に保存されます。このファイルを人に渡さないでください。やめるときは `bh google logout`（Google 側の許可も取り消します）
- 取り込みの状況は `bh serve` のログと、Web アプリの「設定 → 取り込み」の Play ブックス欄（「設定 → AI → 接続を確認」にも要約）に出ます。ログインが切れた・確認に失敗したときは、ホームの先頭にも「Play ブックスの自動取り込みに失敗しています（理由）」と出ます（押すと取り込み画面へ。次の確認で取り込めると消えます。Google を使う設定をしていない・ログアウトしたときは出ません）
- **取り込めない本**: 本によっては、Play ブックスがハイライトの文をドキュメントに書き出さず「ハイライト表示したテキストを表示できません」とだけ書きます（出版社の設定による。Play ブックスのアプリでは線を見られます）。この本の線は自動でも手動でも取り込めません。取り込み画面の Play ブックス欄に「取り込めない本 N 冊」と理由が出続け、ドキュメントが読めるようになると自動で取り込んで一覧から消えます
- **新しい線が来ないとき**: 取り込み画面で「最終確認」が進んでいれば PC は見張れています。「最後に新しい点」には、最後に新しい点・更新が届いた時刻と件数が出ます（PC の `state.json` に残るので、`bh serve` を起動し直しても消えません）。ドライブの「Play ブックスのメモ」で、その本のドキュメントの更新日時が線を引いたあとになっているかを見てください。なっていなければ Play ブックス側（設定の「メモ、ハイライト、しおりを Google ドライブに保存」・アプリの同期）が止まっています

| コマンド | 内容 |
| --- | --- |
| `bh google login` / `logout` | ログイン・ログアウト |
| `bh google sync` | 今すぐ 1 回確認して取り込む（`bh serve` を使わない場合） |
| `bh config google-interval <秒>` | 確認の間隔（既定 60、最短 15） |
| `bh config google-folder <フォルダ ID>` | フォルダ名が「Play ブックスのメモ」「Play Books Notes」以外（表示言語が違う等）のとき。ドライブでフォルダを開いた URL の `folders/` の後ろ |

## 4. スマホから PC につなぐ（Tailscale）

1. Tailscale の管理画面の **DNS** で MagicDNS をオンにし、**HTTPS Certificates** を有効にする
2. PC で:
   ```sh
   tailscale serve --bg 8787
   tailscale serve status   # https://<PC名>.<tailnet>.ts.net が表示される
   ```
3. スマホに Tailscale アプリを入れて同じアカウントでログイン
4. Web アプリの「設定 → AI」で「PC のコンパニオンサーバ」を選び、URL に `https://<PC名>.<tailnet>.ts.net` を入れて「接続を確認」

その URL をスマホのブラウザで直接開いても、同じ Web アプリが使えます（PC が配信）。

- tailnet の外からは見えません。`*.ts.net` からの接続はコンパニオンサーバが自動で許可します
- Chrome / Android では初回に「ローカルネットワークへのアクセス」の許可を求められることがあります。許可してください

### tailnet を使わない場合

`cloudflared tunnel --url http://localhost:8787` などでインターネットに公開する場合は、**必ずトークンを設定**してください。

```sh
node cli/bh.js config token <長いランダムな文字列>
node cli/bh.js config origin https://<ユーザー名>.github.io
```

Web アプリの「設定 → AI → トークン」に同じ文字列を入れます。

## 5. ブラウザから LLM に直接つなぐ（PC のみ・任意）

コンパニオンサーバを使わず、PC の Chrome / Edge / Firefox から Ollama を直接呼ぶこともできます。

1. Ollama に Web アプリのオリジンを許可する（スペースを入れない。パスは不要）
   - macOS: `launchctl setenv OLLAMA_ORIGINS "https://<ユーザー名>.github.io"` → Ollama を再起動
   - Windows: 環境変数 `OLLAMA_ORIGINS` に `https://<ユーザー名>.github.io` を追加 → Ollama を再起動
   - Linux: `systemctl edit ollama.service` で `Environment="OLLAMA_ORIGINS=https://<ユーザー名>.github.io"` → `systemctl daemon-reload && systemctl restart ollama`
2. Web アプリの「設定 → AI」で「このブラウザから LLM に直接」を選び、`http://localhost:11434` とモデル名を入れる
3. 初回にブラウザが「ローカルネットワーク（このデバイス）へのアクセス」の許可を求めたら許可する

**Safari は https のページから `http://localhost` に接続できません。** Mac の Safari では `http://localhost:8787`（コンパニオンサーバ）を開いてください。`https://*.github.io` のようなワイルドカードは、他人の GitHub Pages からも Ollama を呼べてしまうので避けてください。

## 5.5 Kindle アプリの線を自動で取り込む（ブラウザ拡張・任意）

Amazon には Kindle のハイライトを外部に渡す公式の API がありません。そこで、PC の Chrome / Edge に入れた拡張機能（`extension/`）が、ログイン済みのブラウザで Kindle のノートブックを定期的に確認し、新しい線だけを `bh serve` に送ります。

1. `bh serve` を起動しておく
2. `chrome://extensions`（Edge は `edge://extensions`）→「デベロッパー モード」をオン →「パッケージ化されていない拡張機能を読み込む」→ リポジトリの `extension` フォルダを選ぶ
3. 自動で開く設定画面に出るコマンドを実行し、`bh serve` を再起動する

   ```sh
   bh config origin chrome-extension://<拡張機能の ID>
   ```

4. 同じブラウザで `https://read.amazon.co.jp/notebook` にログインしておく。ログインしたらこのタブは閉じてよい（拡張機能はタブを使わず、ブラウザのログイン状態で裏側から読む）。ログインが切れると、拡張機能の状態欄と Web アプリ（取り込み画面の Kindle 欄・ホームの先頭）にログインが切れていると出るので、そのときだけノートブックを開いてログインし直す
5. 設定画面の「今すぐ取り込む」で動作を確かめる。以後は既定で 15 分ごとに確認する（5 分〜1 時間から選べる）

- **動いているかの確認**: 拡張機能は確認のたびに結果を PC に知らせる。Web アプリの「設定 → 取り込み」の Kindle 欄に、最終確認の時刻・その確認で読み直した冊数・結果（正常 / ログイン切れ / 失敗）・最後に新しい線が届いた時刻が出る（冊数が 0 なら拡張は本を読みに行っていない。読み直したのに点が増えないなら、線がまだノートブックに反映されていない）。冊数を送らない古い拡張のときは「拡張機能が古いようです」と出るので、`chrome://extensions` で拡張機能を再読み込みする（リポジトリを更新しても、拡張機能は自動では新しくならない）。確認の間隔の 3 倍を過ぎても連絡が無いと「連絡がありません」と出る（PC のブラウザが閉じている等）。ログイン切れ・失敗・長く連絡なしのときは、ホームの先頭にも警告が出る
- **届くまでの時間**: Kindle アプリで引いた線がノートブックに出るまで数分 + 確認の間隔。Web アプリは画面を開いたとき・表示中は 1 分ごとに PC の更新を確かめ、新しい線があれば同期する（「設定 → AI」がコンパニオンサーバで、自動同期がオンのとき）
- **取得量**: 本の一覧を読み、最後に注釈した日が変わった本と、いちばん新しい日（今日など）に注釈した本だけを読み直す（ノートブックの日付は日単位なので、同じ日の 2 回目の線を取りこぼさないため）。読めなかった本は次回もう一度読む
- **安全性**: Amazon のパスワードや Cookie は保存しない。ブラウザを閉じている間は止まる。拡張機能が接続できるのは Amazon のノートブック・`localhost`・`*.ts.net` だけ
- **削除との関係**: Web アプリで削除した本は、自動の取り込みでは復活しない（手動で取り込み直すと戻る）
- 拡張機能のフォルダを移動すると ID が変わるので、もう一度 `bh config origin` を実行する

## うまくいかないとき

| 症状 | 対処 |
| --- | --- |
| 「PC に接続できません」 | `bh serve` が動いているか、URL（`http://localhost:8787` / `https://…ts.net`）が正しいか |
| 「このオリジンからの接続は許可されていません」 | `bh config origin https://<ユーザー名>.github.io` |
| 「LLM サーバに接続できません」 | Ollama が起動しているか（`ollama list`）、`bh config url` が正しいか |
| 「JSON 形式の応答を得られませんでした」 | モデルが小さすぎる可能性。大きめのモデルに変える |
| Play ブックスのファイルでハイライトが 0 件 | ドライブの「Play ブックスのメモ」のドキュメントか確認。.docx / .html / .md で保存する（.txt / .pdf は非対応） |
| ブックマークレットで「本が見つかりませんでした」 | read.amazon.co.jp/notebook にログインした状態で実行する |
| 「Google のログインが無効になりました」 | OAuth 同意画面が「テスト」のままだと 7 日で切れる。「本番」に切り替えてから `bh google login` |
| 「Play ブックスのメモ」フォルダが見つかりません | Play ブックスの「Google ドライブに保存」がオンか。フォルダ名が違えば `bh config google-folder <ID>` |
| 線を引いたのに取り込まれない | Google がドキュメントを更新するまで数分かかることがある。ドライブでドキュメントを開いて線が載っているか確認する |
| 拡張機能のアイコンに「!」が出る | アイコンを押して設定画面の理由を見る。「ログインしていません」ならノートブックにログインし直す。「オリジンからの接続は許可されていません」なら設定画面のコマンドで `bh config origin` を追加する。「ハイライトがすべて 0 件でした」なら Amazon のノートブックの画面の形が変わった可能性がある（ブラウザでノートブックを開いて線が見えるなら、拡張機能の読み取り `extension/offscreen.js` を直す必要がある。直したら設定画面の「全ての本を取り込み直す」を押す。異常の間に読んだ本は読み終えた扱いになっているため） |

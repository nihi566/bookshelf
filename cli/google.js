// Google ドライブの「Play ブックスのメモ」を見張り、線を引いたら自動で取り込む（依存ライブラリなし）
//
// - ログイン: OAuth 2.0 のループバック方式 + PKCE（Google Cloud の「デスクトップ アプリ」クライアント）
// - 権限: ドライブの読み取り（drive.readonly）だけ。ドライブには何も書かない
// - 見張り方: 一定間隔でフォルダ内のドキュメント一覧（更新日時）を取り、変わったものだけ HTML で書き出して取り込む
//   （ドライブの push 通知は公開された https の受け口が要るので使わない）
// - Play ブックスがドキュメントを書き換えるまでの遅れは Google 次第で、こちらでは縮められない

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mergeParsed } from '../web/core/model.js';
import { parseFiles } from '../web/core/parsers/index.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE = 'https://www.googleapis.com/drive/v3';
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';
// Play ブックスが作るフォルダの名前（表示言語で変わる。見つからなければ bh config google-folder <フォルダ ID>）
export const FOLDER_NAMES = ['Play ブックスのメモ', 'Play Books Notes'];
export const MIN_INTERVAL_SEC = 15;
// 取り込み済みの記録（google-sync.json）の版。2: 表紙に使う書籍 ID を本に付けるようになった
// 3: 取り込めない文書（problems）を残すようになった（前の版で失敗して記録済みの文書も、一度だけ読み直して載せる）
const SYNC_VERSION = 3;

/**
 * ログインし直すしかない失敗（未ログイン・トークン失効・クライアント設定の誤り）。
 * notSetUp: まだ Google を使う設定をしていない（クライアント ID・ログインが無い）。期限切れなど、設定したのに使えなくなったときは付けない
 */
function needsLogin(message, { notSetUp = false } = {}) {
  return Object.assign(new Error(message), { needsLogin: true, notSetUp });
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
// ドライブの検索式の文字列リテラル
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function isFolderId(s) {
  return /^[\w-]{10,}$/.test(String(s || ''));
}

export function createGoogleClient({ store, fetchImpl = fetch }) {
  let access = null; // { token, expiresAt }
  let folders = null; // 見つけたフォルダの ID（見張っている間は使い回す）

  async function credentials() {
    const { google } = await store.config();
    if (!google.clientId) throw needsLogin('Google のクライアント ID が未設定です（bh config google-client <クライアント ID> <クライアント シークレット>）', { notSetUp: true });
    return google;
  }

  async function tokenRequest(params) {
    const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const msg = data.error_description || data.error || `HTTP ${res.status}`;
    // invalid_grant: 取り消された・期限切れ（テスト公開のままだと 7 日で切れる）/ invalid_client: クライアント ID かシークレットの誤り
    if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(data.error)) {
      throw needsLogin(`Google のログインが無効になりました（${msg}）。bh google login でログインし直してください`);
    }
    throw new Error(`Google のトークンを取得できませんでした: ${msg}`);
  }

  function remember(t) {
    access = { token: t.access_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  }

  async function accessToken() {
    if (access && access.expiresAt > Date.now() + 60_000) return access.token;
    const saved = await store.googleToken();
    if (!saved?.refreshToken) throw needsLogin('Google にログインしていません（bh google login）', { notSetUp: true });
    const { clientId, clientSecret } = await credentials();
    remember(await tokenRequest({ client_id: clientId, client_secret: clientSecret, refresh_token: saved.refreshToken, grant_type: 'refresh_token' }));
    return access.token;
  }

  async function drive(pathAndQuery, { bytes = false } = {}) {
    const res = await fetchImpl(DRIVE + pathAndQuery, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!res.ok) {
      if (res.status === 401) access = null; // 次の確認でトークンを取り直す
      const data = await res.json().catch(() => ({}));
      throw new Error(`Google ドライブ: ${data.error?.message || `HTTP ${res.status}`}`);
    }
    return bytes ? new Uint8Array(await res.arrayBuffer()) : res.json();
  }

  async function findFolders() {
    const { google } = await store.config();
    if (google.folderId) return [google.folderId];
    if (folders) return folders;
    const names = FOLDER_NAMES.map((n) => `name = ${q(n)}`).join(' or ');
    const params = new URLSearchParams({ q: `mimeType = '${FOLDER}' and trashed = false and (${names})`, fields: 'files(id,name)', pageSize: '10' });
    const found = (await drive(`/files?${params}`)).files || [];
    if (!found.length) {
      throw new Error(`ドライブに「${FOLDER_NAMES.join('」「')}」フォルダが見つかりません。Play ブックスの設定で「メモ、ハイライト、しおりを Google ドライブに保存」をオンにするか、bh config google-folder <フォルダ ID> で指定してください`);
    }
    folders = found.map((f) => f.id);
    return folders;
  }

  async function listDocs(folderIds) {
    const parents = folderIds.map((id) => `${q(id)} in parents`).join(' or ');
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: `(${parents}) and mimeType = '${DOC}' and trashed = false`, fields: 'nextPageToken,files(id,name,modifiedTime)', pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await drive(`/files?${params}`);
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  return {
    /** ブラウザで Google にログインし、リフレッシュトークンを data/ に保存する */
    async login({ openBrowser = openUrl, log = console.log, timeoutMs = 5 * 60_000 } = {}) {
      const { clientId, clientSecret } = await credentials();
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(16));
      const server = createServer();
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const url = `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent', // 2 回目以降のログインでもリフレッシュトークンを返させる
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state,
      })}`;
      try {
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${Math.round(timeoutMs / 60_000)} 分以内にログインが終わりませんでした`)), timeoutMs);
          server.on('request', (req, res) => {
            const u = new URL(req.url, redirectUri);
            if (u.pathname !== '/') {
              res.writeHead(404);
              return res.end();
            }
            const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ok ? '<p>ログインしました。この画面は閉じてかまいません。</p>' : '<p>ログインできませんでした。ターミナルを確認してください。</p>');
            clearTimeout(timer);
            if (ok) resolve(u.searchParams.get('code'));
            else reject(new Error(u.searchParams.get('error') ? `ログインが中断されました（${u.searchParams.get('error')}）` : 'ログインの応答を確認できませんでした（state が一致しません）'));
          });
          log(`ブラウザで Google にログインしてください。開かない場合は次の URL を開きます:\n${url}`);
          openBrowser(url);
        });
        const t = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
        if (!t.refresh_token) throw new Error('Google がリフレッシュトークンを返しませんでした。もう一度 bh google login を実行してください');
        await store.saveGoogleToken({ refreshToken: t.refresh_token, scope: t.scope || SCOPE, createdAt: new Date().toISOString() });
        remember(t);
      } finally {
        server.close();
      }
    },

    /** ログアウト: Google 側でトークンを取り消し（失敗しても続ける）、手元のトークンを消す */
    async logout() {
      const saved = await store.googleToken();
      if (saved?.refreshToken) {
        await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken }) }).catch(() => {});
      }
      await store.removeGoogleToken();
      await store.saveGoogleSync({ files: {} });
      access = null;
      folders = null;
    },

    /** 1 回分の確認: 更新されたドキュメントだけ取り込む */
    async sync() {
      const docs = await listDocs(await findFolders());
      const synced = await store.googleSync();
      // 記録の files が無い・形が違う（手で書き換えた・壊れた）ときは、取り込み済みの記録なしとして扱う
      if (!synced.files || typeof synced.files !== 'object') synced.files = {};
      if (!synced.problems || typeof synced.problems !== 'object' || Array.isArray(synced.problems)) synced.problems = {};
      if (!docs.length) {
        // フォルダが作り直された（設定のオフ → オン等）かもしれないので、次の確認で探し直す。
        // 取り込み済みの記録は消さない（消すと全部を取り込み直すことになる）
        folders = null;
        // 一覧が一時的に空で返っただけかもしれないので、取り込めない文書の記録はそのまま出す
        return { checked: 0, changed: 0, added: 0, updated: 0, booksAdded: 0, errors: [], problems: problemList(synced.problems, new Set(Object.keys(synced.problems))) };
      }
      const present = new Set(docs.map((d) => d.id));
      // 前の版の記録（表紙の書籍 ID を拾う前）なら、変わっていないドキュメントも一度だけ読み直して本に ID を付ける
      const reread = synced.version !== SYNC_VERSION;
      const changed = docs.filter((d) => reread || synced.files[d.id] !== d.modifiedTime);
      const result = { checked: docs.length, changed: changed.length, added: 0, updated: 0, booksAdded: 0, errors: [], problems: problemList(synced.problems, present) };
      if (!changed.length) return result;

      const inputs = [];
      for (const d of changed) {
        try {
          inputs.push({ name: `${d.name}.html`, bytes: await drive(`/files/${encodeURIComponent(d.id)}/export?mimeType=text%2Fhtml`, { bytes: true }), doc: d });
        } catch (e) {
          // 書き出せなかったものは記録しないので、次の確認でもう一度試す
          result.errors.push(`${d.name}: ${e.message}`);
        }
      }
      const { books, results } = await parseFiles(inputs);
      for (const r of results) if (r.error) result.errors.push(`${r.name}: ${r.error}`);
      // 読めなかったドキュメントは、中身が変わって読めるようになるまで記録に残す（画面に出し続けるため。読み直しはしない）
      // parseFiles は名前によって結果を飛ばすことがある（._ で始まる名前など）ので、数が合うときだけ文書と結果を並びで対応づける
      if (results.length === inputs.length) {
        results.forEach((r, i) => {
          const d = inputs[i].doc;
          if (r.error) synced.problems[d.id] = { name: d.name, error: r.error, modifiedTime: d.modifiedTime };
          else delete synced.problems[d.id];
        });
      }
      if (books.length) {
        const st = await store.lock(async () => {
          const lib = await store.library();
          // 自動取り込みなので、アプリで削除した本は戻さない（戻したいときは手動で取り込む）
          const s = mergeParsed(lib, books, { reviveDeleted: false });
          if (s.added || s.updated || s.booksAdded || s.booksUpdated) await store.saveLibrary(lib);
          return s;
        });
        Object.assign(result, { added: st.added, updated: st.updated, booksAdded: st.booksAdded });
      }
      // 読めなかったドキュメントも、中身が変わるまでは試し直さない（毎回同じエラーを出さないため）
      for (const { doc } of inputs) synced.files[doc.id] = doc.modifiedTime;
      for (const id of Object.keys(synced.files)) if (!present.has(id)) delete synced.files[id];
      for (const id of Object.keys(synced.problems)) if (!present.has(id)) delete synced.problems[id];
      result.problems = problemList(synced.problems, present);
      // 読み直しで書き出せなかったドキュメントがあれば、次の確認でもう一度全部を読み直す
      if (inputs.length === changed.length) synced.version = SYNC_VERSION;
      await store.saveGoogleSync(synced);
      return result;
    },
  };
}

/** 取り込めないドキュメントの一覧（ドライブに今あるものだけ。書名の順） */
function problemList(problems, present) {
  return Object.entries(problems)
    .filter(([id, p]) => present.has(id) && p && typeof p === 'object')
    .map(([, p]) => ({ name: String(p.name || ''), error: String(p.error || ''), modifiedTime: String(p.modifiedTime || '') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export function describeSync(r) {
  return r.changed ? `更新されたドキュメント ${r.changed} 件 → 新しい点 ${r.added} 件・更新 ${r.updated} 件${r.booksAdded ? `（新しい本 ${r.booksAdded} 冊）` : ''}` : `変更なし（ドキュメント ${r.checked} 件）`;
}

/**
 * bh serve の中で定期的にドライブを確認する。
 * 未ログインでも止めずに見張り続けるので、別のターミナルで bh google login すれば次の確認から取り込みが始まる。
 */
export function startDriveWatcher({ store, client, log = console.log }) {
  // problems: 取り込めないドキュメント（読めるようになるまで残る。error は直近の確認で出たものだけ）
  // configured: Google を使う設定が済んでいるか（済んでいて error があるときだけ、ホームに警告を出す）
  const status = { active: false, configured: false, checking: false, lastCheck: null, lastImport: null, lastResult: null, error: '', problems: [] };
  let timer = null;
  let stopped = false;
  let lastLogged = '';

  const logOnce = (msg) => {
    if (msg !== lastLogged) log(msg);
    lastLogged = msg;
  };

  // 最後に新しい点が届いた時刻・件数は、bh serve を起動し直しても出せるよう state.json に残す（残せなくても見張りは止めない）
  async function saveLastNew(lastNew) {
    try {
      // state.json はほかの記録（Kindle・自動の分析）と共有なので、読んでから書くまでを順番待ちにする
      await store.lock(async () => {
        const st = await store.state();
        await store.saveState({ ...st, playbooksSync: { ...(st.playbooksSync || {}), lastNew } });
      });
    } catch (e) {
      log(`[google] ! 最後に新しい点の記録を残せませんでした: ${e.message}`);
    }
  }

  async function tick() {
    status.checking = true;
    try {
      const r = await client.sync();
      Object.assign(status, { active: true, configured: true, lastCheck: new Date().toISOString(), lastResult: r, error: r.errors.join(' / '), problems: r.problems || [] });
      if (r.added || r.updated) {
        status.lastImport = status.lastCheck;
        await saveLastNew({ at: status.lastCheck, added: r.added, updated: r.updated });
      }
      if (r.changed) log(`[google] ${describeSync(r)}`);
      // 書き出しに失敗したドキュメントは毎回試し直すので、同じエラーは 1 回だけ出す
      if (r.errors.length) logOnce(`[google] ! ${r.errors.join(' / ')}`);
      else lastLogged = '';
    } catch (e) {
      Object.assign(status, { active: !e.needsLogin, configured: !e.notSetUp, error: e.message });
      logOnce(`[google] ${e.message}`);
    } finally {
      status.checking = false;
      if (!stopped) {
        const { google } = await store.config().catch(() => ({ google: {} }));
        // 設定を読んでいる間に stop されたら予約しない
        if (!stopped) timer = setTimeout(tick, Math.max(MIN_INTERVAL_SEC, Number(google.intervalSec) || 60) * 1000);
      }
    }
  }

  tick();
  return {
    status,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // 開けなくても URL は表示してある
  }
}

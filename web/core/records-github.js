// 読書記録の保存先: このサイトのリポジトリの records ブランチにある records.json。
// GitHub Contents API で丸ごと読み書きする（件数は数百程度なので差分同期は作らない）。
// トークンは Authorization ヘッダでだけ送り、URL・エラーメッセージ・console には出さない。
import { applyChange, assertRecordsShape, decodeBase64Utf8, emptyRecordsFile, encodeBase64Utf8, parseRecordsFile } from './records.js';

export const OWNER = 'nihi566';
export const REPO = 'bookshelf';
export const BRANCH = 'records';
export const PATH = 'records.json';

const CONTENTS_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

function githubError(kind, status) {
  return Object.assign(new Error(recordsErrorMessage({ kind })), { kind, status });
}

function errorKind(res) {
  if (res.status === 401) return 'auth';
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'ratelimit';
  if (res.status === 403) return 'forbidden';
  if (res.status === 404) return 'notfound';
  // sha が古い（他の端末が先に保存した）ときは 409 か 422 が返る
  if (res.status === 409 || res.status === 422) return 'conflict';
  return 'http';
}

function headers(token) {
  const result = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function request(fetchImpl, url, options) {
  let res;
  try {
    // 古い sha を掴むと保存が必ず競合するため、ブラウザのキャッシュを使わない
    res = await fetchImpl(url, { cache: 'no-store', ...options });
  } catch {
    throw githubError('network');
  }
  if (!res.ok) throw githubError(errorKind(res), res.status);
  try {
    return await res.json();
  } catch {
    throw githubError('parse');
  }
}

/** 生の records.json（未知のキーを含む）と sha。まだ無ければ空のファイル（sha なし = 最初の保存で作る） */
async function fetchRaw(token, fetchImpl) {
  let body;
  try {
    body = await request(fetchImpl, `${CONTENTS_URL}?ref=${BRANCH}`, { headers: headers(token) });
  } catch (err) {
    // ブランチはあるがファイルがまだ無い → 最初の保存で作る。ブランチが無いときは保存も 404 になる
    if (err.kind === 'notfound' && token) return { json: emptyRecordsFile(), sha: undefined };
    throw err;
  }
  let json;
  try {
    json = JSON.parse(decodeBase64Utf8(String(body.content ?? '')));
    assertRecordsShape(json);
  } catch {
    throw githubError('parse');
  }
  return { json, sha: body.sha };
}

/** 記録を読む。トークンが無ければ未認証で読む（公開リポジトリなので閲覧はできる） */
export async function fetchRecords(token, { fetchImpl = globalThis.fetch } = {}) {
  const { json } = await fetchRaw(token, fetchImpl);
  return parseRecordsFile(json);
}

/**
 * 最新を取得 → 変更を当てる → sha 付きで保存。他の端末が先に保存して競合したら、
 * 取り直して同じ変更を当て直し 1 回だけ再送する（それでも失敗したら呼び出し側へ失敗を返す）
 */
export async function saveChange(token, change, { fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  if (!token) throw githubError('auth');
  for (let attempt = 0; ; attempt += 1) {
    const { json, sha } = await fetchRaw(token, fetchImpl);
    const next = applyChange(json, change, now());
    try {
      await request(fetchImpl, CONTENTS_URL, {
        method: 'PUT',
        headers: { ...headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `record: ${change.type} ${change.book_id}`,
          content: encodeBase64Utf8(`${JSON.stringify(next, null, 2)}\n`),
          ...(sha ? { sha } : {}),
          branch: BRANCH,
        }),
      });
      return parseRecordsFile(next);
    } catch (err) {
      if (err.kind === 'conflict' && attempt === 0) continue;
      throw err;
    }
  }
}

export function recordsErrorMessage(err) {
  switch (err?.kind) {
    case 'auth':
      return 'GitHub トークンが無効か期限切れです。読書記録の画面でトークンを入れ直してください。';
    case 'forbidden':
      return 'このトークンには記録の保存先リポジトリへの権限がありません。発行時の対象リポジトリと Contents の権限を確認してください。';
    case 'ratelimit':
      return 'GitHub への問い合わせ回数の上限に達しました。しばらく待つか、トークンを保存してください。';
    case 'notfound':
      return `記録の保存先（${OWNER}/${REPO} の ${BRANCH} ブランチ）が見つかりません。`;
    case 'conflict':
      return '他の端末の保存と重なったため保存できませんでした。もう一度お試しください。';
    case 'network':
      return 'GitHub に接続できませんでした。インターネット接続を確認してください。';
    case 'parse':
      return '記録ファイルを読み取れませんでした。';
    default:
      return '記録の読み書きに失敗しました。時間をおいて再試行してください。';
  }
}

// 文字列まわりの小さなユーティリティ（ブラウザと Node の両方で動く純粋関数）

/** 比較・重複判定用の正規化（NFKC・空白の統一・小文字化） */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 表示用の整形（前後の空白と BOM を除き、行末の空白を落とし、連続する空行を詰める） */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(trimSpacesEnd)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 行末の半角空白とタブを落とす。正規表現（/[ \t]+\n/）で落とすと、改行の無い長い空白の並びで
 * 処理時間が長さの 2 乗に増え、同期で届いた文 1 つでサーバが止まる
 */
function trimSpacesEnd(line) {
  let i = line.length;
  while (i > 0 && (line[i - 1] === ' ' || line[i - 1] === '\t')) i--;
  return i === line.length ? line : line.slice(0, i);
}

/**
 * エラー文などから、URL に書いた利用者名・パスワード（http://user:pass@host）を伏せる
 * （画面・分析結果・履歴・バックアップに残る文に入れないため）
 */
export function maskSecrets(s) {
  return String(s || '').replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');
}

/** 本の同一性判定用キー。記号・空白を落として表記ゆれに強くする */
export function bookKey(title) {
  return normalizeText(title).replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 53bit の高速ハッシュ (cyrb53)。ID 生成に使う。暗号用途ではない */
export function hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 利用者が作る項目（思いつきなど）の ID。本文から決まる点の ID と違い、本文を直しても変わらない。
 * crypto.randomUUID は http の LAN アドレスなど安全でない画面では使えないので getRandomValues を使う
 */
export function randomId(prefix) {
  const bytes = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + Date.now().toString(36) + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ISO 日付文字列 → YYYY-MM-DD（不正な値は空文字） */
export function isoDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO-8859-1 の名前付き文字参照（&nbsp; = U+00A0 から &yuml; = U+00FF まで順番どおり）
const LATIN1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');

/** HTML エンティティのデコード（DOM 非依存） */
export function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', deg: '°', ensp: ' ', emsp: ' ', thinsp: ' ' };
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    if (named[e] ?? named[e.toLowerCase()]) return named[e] ?? named[e.toLowerCase()];
    const latin = LATIN1.indexOf(e);
    return latin >= 0 ? String.fromCharCode(160 + latin) : m;
  });
}

/** HTML 断片 → プレーンテキスト（改行タグは改行にする） */
export function htmlToText(html) {
  const s = String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return cleanText(decodeEntities(s));
}

/** 和暦ではない「2023年1月2日 午後3:04:05」や英語の日付を ISO 文字列にする */
export function parseLooseDate(str) {
  if (!str) return null;
  const s = String(str).normalize('NFKC').trim();
  const ja = s.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:[^\d]*?(午前|午後|上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ja) {
    let hour = ja[5] ? Number(ja[5]) : 0;
    const pm = ja[4] === '午後' || ja[4] === '下午';
    const am = ja[4] === '午前' || ja[4] === '上午';
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    return toIso(Number(ja[1]), Number(ja[2]), Number(ja[3]), hour, Number(ja[6] ?? 0), Number(ja[7] ?? 0));
  }
  const ymd = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (ymd) return toIso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]), Number(ymd[4] ?? 0), Number(ymd[5] ?? 0), Number(ymd[6] ?? 0));
  // 英語: "Sunday, January 1, 2023 12:34:56 PM" / "1 January 2023 12:34:56"
  const cleaned = s.replace(/^[A-Za-z]+,\s*/, '');
  const t = Date.parse(cleaned);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return null;
}

function toIso(y, mo, d, h, mi, se) {
  const date = new Date(y, mo - 1, d, h, mi, se);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 決定的な乱数（シード付き mulberry32）。クラスタリングの再現性のため */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n 文字（絵文字や一部の漢字のように 2 つの単位でできた文字も 1 文字と数える）を超えたら、末尾を「…」にして切る */
export function truncate(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  const chars = Array.from(str);
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : str;
}

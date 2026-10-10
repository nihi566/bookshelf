// 思いつき（フリートノート）: 本に属さないメモ。書いたらそのまま分析の点になり、あとで受け箱で整理する
//
// 「メモ」と呼ぶものは他にもある（読書メモ = source 'memo' の点 / 取り込んだメモ = 点の note /
// 自分のメモ = 点の userNote）。混ざらないよう、コードではこれを thought（思いつき）と呼ぶ。
//
// Thought = { id: 't…', text, status: 'inbox' | 'done' | 'discarded', statusAt, answerTo?, createdAt, updatedAt }
//   statusAt: 状態を変えた時刻（本文の書き直しと状態の変更が別の端末で重なっても、両方を残すため）
// 消したものは墓標 { id, deleted: true, createdAt, updatedAt } だけを残す（同期で戻らないように）

import { newerItem } from './collections.js';
import { cleanText, isoStamp, normalizeText, randomId, truncate } from './text.js';

export const THOUGHT_LABEL = '思いつき';
export const THOUGHT_STATUS = { inbox: '未整理', done: '整理済み', discarded: '捨てた' };

// 本文の長さの上限（1 つの思いつき = 1 つの考え。長文の貼り付けで同期を重くしない）
export const THOUGHT_MAX_LENGTH = 4000;

/** 思いつきの ID か（点の ID は 'h'、思いつきは 't' + 英小文字・数字。randomId('t') の形） */
export function isThoughtId(id) {
  return typeof id === 'string' && /^t[0-9a-z]{1,40}$/.test(id);
}

export function thoughtsOf(library) {
  return library?.thoughts || {};
}

const isStatus = (s) => typeof s === 'string' && Object.hasOwn(THOUGHT_STATUS, s);

/** 外から来た思いつきの形を整える（同期・バックアップ用）。壊れていれば null */
export function normalizeThought(t, now = new Date().toISOString()) {
  if (!isThoughtId(t.id)) return null;
  if (t.deleted) return { id: t.id, deleted: true, createdAt: isoStamp(t.createdAt, now), updatedAt: isoStamp(t.updatedAt, now) };
  if (typeof t.text !== 'string') return null;
  const text = cleanText(t.text).slice(0, THOUGHT_MAX_LENGTH);
  if (!text) return null;
  const createdAt = isoStamp(t.createdAt, now);
  const out = { id: t.id, text, status: isStatus(t.status) ? t.status : 'inbox', statusAt: isoStamp(t.statusAt, now) || createdAt, createdAt, updatedAt: isoStamp(t.updatedAt, now) };
  const answerTo = normalizeAnswerTo(t.answerTo);
  if (answerTo) out.answerTo = answerTo;
  return out;
}

/**
 * 両方の端末にある思いつきの統合。本文などは updatedAt が新しい方、状態は statusAt が新しい方
 * （PC で捨てたあと、未同期のスマホで本文を直しても、捨てたままにする）
 */
export function mergeThought(a, b) {
  const base = newerItem(a, b);
  const sa = a.statusAt || a.createdAt || '';
  const sb = b.statusAt || b.createdAt || '';
  const src = sa === sb ? base : sa > sb ? a : b;
  return { ...base, status: src.status, statusAt: src.statusAt || src.createdAt || '' };
}

/** どの問いへの答えか（立体・線の問い、問いかけの質問）。形が違えば持たない */
function normalizeAnswerTo(a) {
  if (!a || typeof a !== 'object' || typeof a.question !== 'string') return null;
  const question = truncate(cleanText(a.question).replace(/\s+/g, ' '), 300);
  if (!question || !['solid', 'line', 'ask'].includes(a.kind)) return null;
  return { kind: a.kind, question, ...(typeof a.id === 'string' && a.id ? { id: a.id.slice(0, 40) } : {}) };
}

function checkText(text) {
  const t = cleanText(text);
  if (!t) throw new Error('メモを入力してください');
  if (t.length > THOUGHT_MAX_LENGTH) throw new Error(`メモは ${THOUGHT_MAX_LENGTH} 字までにしてください`);
  return t;
}

/**
 * 思いつきを書く（受け箱に入る）。
 * id は書くシートを開いたときに 1 回だけ作って渡す（保存に失敗して押し直しても、同じメモが 2 件にならないように）
 */
export function addThought(library, { text, answerTo } = {}, now = new Date().toISOString(), id = randomId('t')) {
  if (!isThoughtId(id)) throw new Error('メモの ID の形が違います');
  const t = { id, text: checkText(text), status: 'inbox', statusAt: now, createdAt: now, updatedAt: now };
  const a = normalizeAnswerTo(answerTo);
  if (a) t.answerTo = a;
  library.thoughts = { ...thoughtsOf(library), [id]: t };
  library.updatedAt = now;
  return t;
}

/** 本文・状態を変える。何も変わらなければ時刻も進めない（別の端末の新しい編集を負かさない） */
export function updateThought(library, id, patch, now = new Date().toISOString()) {
  const cur = Object.hasOwn(thoughtsOf(library), id) ? thoughtsOf(library)[id] : null;
  if (!cur || cur.deleted) throw new Error('メモが見つかりません');
  const next = { ...cur };
  if ('text' in patch) next.text = checkText(patch.text);
  if ('status' in patch) {
    if (!isStatus(patch.status)) throw new Error(`不明な状態: ${patch.status}`);
    if (patch.status !== cur.status) next.statusAt = now;
    next.status = patch.status;
  }
  if (next.text === cur.text && next.status === cur.status) return cur;
  next.updatedAt = now;
  library.thoughts = { ...thoughtsOf(library), [id]: next };
  library.updatedAt = now;
  return next;
}

/** 消す。本文は残さず、墓標だけを残す */
export function deleteThought(library, id, now = new Date().toISOString()) {
  const cur = Object.hasOwn(thoughtsOf(library), id) ? thoughtsOf(library)[id] : null;
  if (!cur) return null;
  const tomb = { id, deleted: true, createdAt: cur.createdAt || now, updatedAt: now };
  library.thoughts = { ...thoughtsOf(library), [id]: tomb };
  library.updatedAt = now;
  return tomb;
}

/**
 * 最後の PC との同期より後に書いた・直したメモか（PC にまだ届いていない）。
 * 一度も同期していない・最後の同期の時刻が読めないときは、届いたとは言えないので未同期とする。
 * updatedAt は書いた端末の時計なので、時計の進んだ別の端末で書いたメモは、届いていても次の同期まで未同期と出ることがある
 */
export function isThoughtUnsynced(t, lastSync) {
  const synced = Date.parse(lastSync ?? '');
  if (Number.isNaN(synced)) return true;
  return Date.parse(t.updatedAt) > synced;
}

const newestFirst = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id);

/** 消していない思いつき（捨てたものも含む） */
export function liveThoughts(library) {
  return Object.values(thoughtsOf(library)).filter((t) => !t.deleted);
}

/** PC にまだ届いていないメモの数（消したメモは数えない。整理済み・捨てたへの変更も届いていなければ数える） */
export function countUnsyncedThoughts(library, lastSync) {
  return liveThoughts(library).filter((t) => isThoughtUnsynced(t, lastSync)).length;
}

/** 分析・今日の点・検索に使う思いつき（捨てたものを除く） */
export function pointThoughts(library) {
  return liveThoughts(library).filter((t) => t.status !== 'discarded');
}

/** 受け箱（まだ整理していない思いつき）。新しい順 */
export function inboxThoughts(library) {
  return liveThoughts(library)
    .filter((t) => t.status === 'inbox')
    .sort(newestFirst);
}

/** 状態ごとの件数 */
export function thoughtCounts(library) {
  const out = { inbox: 0, done: 0, discarded: 0 };
  for (const t of liveThoughts(library)) out[t.status]++;
  return out;
}

/**
 * 思いつきを探す（空白区切りの AND）。新しい順。
 * status を指定しなければ捨てたものは出さない（捨てたものは「捨てた」の一覧でだけ見られる）
 */
export function searchThoughts(library, query = '', { status = '' } = {}) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  return liveThoughts(library)
    .filter((t) => (status ? t.status === status : t.status !== 'discarded'))
    .filter((t) => {
      if (!terms.length) return true;
      const hay = normalizeText(`${t.text} ${THOUGHT_LABEL} ${t.answerTo?.question || ''}`);
      return terms.every((w) => hay.includes(w));
    })
    .sort(newestFirst);
}

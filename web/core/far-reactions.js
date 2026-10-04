// 遠いつながりへの反応（面白い・ちがう）。端末の間で同期する
//
// library.farReactions = { [遠いつながりの ID]: { id, a, b, idea, explanation, status: 'interesting'|'wrong'|'', updatedAt } }
// - 面白い: 分析し直しても残り続ける（分析の結果から消えても、ここに持っている点の組と説明で出す）
// - ちがう: 二度と出さない（その組を候補からも外す）
// 反応は、候補を選ぶ分野を狭めるのには使わない（好みに閉じないため。外すのは「ちがう」とした組そのものだけ）

import { mergeCollections } from './collections.js';
import { isoStamp } from './text.js';
import { EXPLANATION_MAX, IDEA_MAX, farConnectionOf, farId, farText, isFarConnection, isFarId, isPointId } from './analysis/far.js';

export const FAR_REACTIONS = Object.freeze({ interesting: '面白い', wrong: 'ちがう' });

export function farReactionsOf(library) {
  const r = library?.farReactions;
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
}

const isStatus = (s) => typeof s === 'string' && Object.hasOwn(FAR_REACTIONS, s);

/**
 * 外から来た反応の形を整える（同期・バックアップ用）。壊れていれば null。
 * 付けた時刻は isoStamp で整える（壊れた時刻は ''、時計の進んだ端末の時刻は now に直す）
 */
export function normalizeFarReaction(r, now = new Date().toISOString()) {
  if (!r || typeof r !== 'object' || !isFarId(r.id) || !isPointId(r.a) || !isPointId(r.b) || r.id !== farId(r.a, r.b)) return null;
  return { id: r.id, a: r.a, b: r.b, idea: farText(r.idea, IDEA_MAX), explanation: farText(r.explanation, EXPLANATION_MAX), status: isStatus(r.status) ? r.status : '', updatedAt: isoStamp(r.updatedAt, now) };
}

/** 反応を付ける。同じ反応をもう一度付けると外す（status: ''） */
export function reactFar(library, far, status, now = new Date().toISOString()) {
  if (!isStatus(status)) throw new Error(`不明な反応: ${status}`);
  if (!isFarConnection(far)) throw new Error('遠いつながりが見つかりません');
  const reactions = farReactionsOf(library);
  const cur = Object.hasOwn(reactions, far.id) ? reactions[far.id] : null;
  const next = { id: far.id, a: far.a, b: far.b, idea: farText(far.idea, IDEA_MAX), explanation: farText(far.explanation, EXPLANATION_MAX), status: cur?.status === status ? '' : status, updatedAt: now };
  library.farReactions = { ...reactions, [far.id]: next };
  library.updatedAt = now;
  return next;
}

/** 2 つの端末の反応をまとめる（付けた時刻が新しい方。向きに依らない。未来すぎる時刻は両側とも同じ今の時刻に直す） */
export function mergeFarReactions(a, b, now = new Date().toISOString()) {
  return mergeCollections(a, b, { normalize: (r) => normalizeFarReaction(r, now) });
}

/** 「ちがう」とした組の ID */
export function wrongFarIds(library) {
  return new Set(Object.values(farReactionsOf(library)).filter((r) => r?.status === 'wrong').map((r) => r.id));
}

/** 発見（discoveries.js）が指す遠いつながりの ID（遠いつながりの発見でなければ ''） */
export function farIdOfDiscovery(d) {
  return d?.kind === 'far' && Array.isArray(d.pointIds) && d.pointIds.length === 2 ? farId(d.pointIds[0], d.pointIds[1]) : '';
}

/**
 * 反応を付ける相手の遠いつながり（画面に出ているもの。「ちがう」とした組は画面に無いので、反応の記録から探す）。無ければ null
 */
export function farConnectionById(analysis, library, id) {
  const shown = visibleFarConnections(analysis, library).find((x) => x.id === id);
  if (shown) return shown;
  const reactions = farReactionsOf(library);
  return Object.hasOwn(reactions, id) && isFarConnection(reactions[id]) ? farConnectionOf(reactions[id]) : null;
}

/**
 * 画面に出す遠いつながり: 分析の結果（新しい順）と、分析の結果から消えても「面白い」とした組。「ちがう」とした組は出さない
 * @returns {object[]} FarConnection に status（反応）を足したもの（決まった欄だけの新しい物）
 */
export function visibleFarConnections(analysis, library) {
  const reactions = farReactionsOf(library);
  const statusOf = (id) => (Object.hasOwn(reactions, id) && isStatus(reactions[id]?.status) ? reactions[id].status : '');
  const seen = new Set();
  const out = [];
  const fromAnalysis = Array.isArray(analysis?.farConnections) ? analysis.farConnections : [];
  const kept = Object.values(reactions).filter((r) => r?.status === 'interesting');
  for (const f of [...fromAnalysis, ...kept]) {
    if (!isFarConnection(f) || seen.has(f.id) || statusOf(f.id) === 'wrong') continue;
    seen.add(f.id);
    out.push({ ...farConnectionOf(f), status: statusOf(f.id) });
  }
  return out;
}

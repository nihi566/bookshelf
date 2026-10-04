// 文章の骨組みを作る（G9）: 材料（面・線・永久ノート）を集め、PC のローカル LLM への依頼文を作り、答えを骨組みにする。
// 引用は点の番号で AI に選ばせ、点の ID で持つ（AI に引用の文を書かせない。画面と Markdown では点の今の文をそのまま出す）

import { analysisPointById, isThought, pointArrived, pointById, pointLabel } from './points.js';
import { currentPointId } from './point-ids.js';
import { isUneditedLineDraft, notesOf } from './notes.js';
import { truncate } from './text.js';
import { farText } from './analysis/far.js';
import { asNumber, isAskAnswer, placeText } from './ask.js';
import { HEADING_MAX, OUTLINE_TITLE_MAX, SECTION_POINTS_MAX, SECTION_POINT_MAX, SECTION_QUOTES_MAX } from './outlines.js';

// 1 回に選べる材料の数と、依頼文に入れる点の数・長さ（小さなモデルが一度に読める長さに収める。上限の材料でも 6,000 字まで）
export const PICKS_MAX = 8;
export const OUTLINE_POINTS_MAX = 20;
const POINT_TEXT_MAX = 100;
// 材料 1 つの説明の長さ（面・線は AI がまとめた説明、永久ノートは読者の本文）と、面の説明に添える線の名前の数
const SUMMARY_MAX = 120;
const NOTE_BODY_MAX = 200;
const LINE_NAMES_MAX = 6;
// AI が作る節の数
const DRAFT_SECTIONS_MAX = 8;
// 文中の引用の番号（[3] など）。直前の空白 1 つも一緒に消す（「整える [1]。」を「整える。」に。長い空白の列でも遅くならない）
const CITE = /[ \t]?\[(\d{1,2})\]/g;

/** いくつかの並びから 1 件ずつ順に取る（どの並びのものも先の方に入るように） */
function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/** 選んだ材料（{ kind, id } の並び）を整える。形の違うものは捨て、最大 8 件 */
export function cleanPicks(v) {
  return (Array.isArray(v) ? v.slice(0, PICKS_MAX * 4) : [])
    .filter((s) => s && ['plane', 'line', 'note'].includes(s.kind) && typeof s.id === 'string' && /^[a-z0-9]{1,80}$/i.test(s.id))
    .map((s) => ({ kind: s.kind, id: s.id }))
    .slice(0, PICKS_MAX);
}

/**
 * 材料を集める（材料 1 つにつき説明 1 つ）。面: 説明と線の名前、点は線ごとに交互に / 線: 名前・説明と点（中心に近い順）/
 * 永久ノート: 題・本文と根拠の点。点は材料どうしも交互に取り（どの材料の点も入るように）、重ねず最大 20 件。
 * 前に問いかけた答えのメモは入れない（AI が書いた文を引用にしない）。見つからない材料は missing に分ける
 * @param {{ kind: 'plane'|'line'|'note', id: string }[]} picks
 */
export function outlineMaterials(library, analysis, picks) {
  const lines = new Map((analysis?.lines || []).map((l) => [l.id, l]));
  const planes = new Map((analysis?.planes || []).map((p) => [p.id, p]));
  const notes = notesOf(library);
  const sources = [];
  const contexts = [];
  const perSource = [];
  const missing = [];
  const picked = new Set();
  for (const s of picks.slice(0, PICKS_MAX)) {
    const key = `${s.kind}:${s.id}`;
    if (picked.has(key)) continue;
    picked.add(key);
    if (s.kind === 'plane' && planes.has(s.id)) {
      const p = planes.get(s.id);
      const ls = (p.lineIds || []).map((id) => lines.get(id)).filter(Boolean);
      sources.push({ kind: 'plane', id: p.id, name: p.name });
      contexts.push({ kind: '面', author: 'ai', name: p.name, text: p.summary || '', lineNames: ls.slice(0, LINE_NAMES_MAX).map((l) => l.name) });
      perSource.push(interleave(ls.map((l) => l.highlightIds || [])));
    } else if (s.kind === 'line' && lines.has(s.id)) {
      const l = lines.get(s.id);
      sources.push({ kind: 'line', id: l.id, name: l.name });
      contexts.push({ kind: '線', author: 'ai', name: l.name, text: l.summary || '' });
      perSource.push(l.highlightIds || []);
    } else if (s.kind === 'note' && Object.hasOwn(notes, s.id) && !notes[s.id].deleted) {
      const n = notes[s.id];
      sources.push({ kind: 'note', id: n.id, name: n.title || '（題なし）' });
      // 線から作って一度も直していないノートは、中身が AI の線のまま（読者の言葉として重く見させない）
      contexts.push({ kind: '永久ノート', author: isUneditedLineDraft(n) ? 'ai' : 'reader', name: n.title || '（題なし）', text: n.body || '' });
      perSource.push(n.pointIds || []);
    } else missing.push({ kind: s.kind, id: s.id });
  }
  const points = [];
  const taken = new Set();
  for (const id of interleave(perSource)) {
    if (points.length >= OUTLINE_POINTS_MAX) break;
    const p = analysisPointById(library, currentPointId(library, id));
    if (!p || taken.has(p.id) || isAskAnswer(library, p.id)) continue;
    taken.add(p.id);
    points.push(p);
  }
  return { sources, contexts, points, missing };
}

/** 骨組みを作る依頼文。点は [1] から番号を付ける（引用は番号で選ばせ、文は書かせない） */
export function outlinePrompt(library, materials) {
  const ctx = materials.contexts
    .map((c) => {
      const reader = c.author === 'reader';
      const text = c.text ? `: ${truncate(c.text.replace(/\s+/g, ' '), reader ? NOTE_BODY_MAX : SUMMARY_MAX)}` : '';
      const names = c.lineNames?.length ? `（線: ${c.lineNames.map((n) => farText(n, 20)).join('・')}）` : '';
      return `- ${c.kind}「${farText(c.name, 40)}」（${reader ? '読者の言葉' : 'AI がまとめたもの'}）${text}${names}`;
    })
    .join('\n');
  const pts = materials.points.map((p, i) => `[${i + 1}] ${truncate(p.text.replace(/\s+/g, ' '), POINT_TEXT_MAX)}（${farText(pointLabel(library, p), 30)}）`).join('\n');
  const few = materials.points.length <= 6;
  return {
    name: 'outline',
    system:
      'あなたは、読者の読書の記録から、人に読ませる文章の骨組みを作る編集者です。必ず日本語で書きます。' +
      '材料（AI がまとめた面・線と、読者の言葉の永久ノート）と点（読者が本に引いた線とメモ）だけを使い、材料に無いことは足しません。読者の言葉は重く見ます。' +
      '引用は点の番号で選ぶだけにし、引用の文そのものは書きません。本文の全文は書かず、見出しと、各節で言うことの要点だけを書きます。',
    user: `材料:\n${ctx || '（なし）'}\n\n点（引用に使える。番号で選ぶ）:\n${pts || '（なし）'}\n\n次の JSON だけを出力してください: {"title": "文章の題（30 字以内）", "sections": [{"heading": "節の見出し", "points": ["その節で言うこと（1 文）", "続けて言うこと（1 文）"], "quotes": [使う点の番号]}]}\n節は ${few ? '2〜3' : '3〜6'} つ。各節の要点は 2〜4 つ、引用は 0〜3 つ。`,
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: { heading: { type: 'string' }, points: { type: 'array', items: { type: 'string' } }, quotes: { type: 'array', items: { type: 'integer' } } },
            required: ['heading', 'points', 'quotes'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'sections'],
      additionalProperties: false,
    },
  };
}

/**
 * AI の答えを骨組みにする。引用は渡した点の番号だけを点の ID に直す（文は持たない）。
 * 見出し・要点の中の [n] も引用に移して文から消す（番号は依頼文の中だけのもの）。節が 1 つも無ければ失敗
 * @returns {{ title: string, sources: object[], sections: { heading: string, points: string[], quotes: string[] }[] }}
 */
export function readOutline(r, materials) {
  const n = materials.points.length;
  const sections = (Array.isArray(r?.sections) ? r.sections.slice(0, DRAFT_SECTIONS_MAX * 4) : [])
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const rawPoints = (Array.isArray(s.points) ? s.points.slice(0, SECTION_POINTS_MAX * 4) : []).filter((p) => typeof p === 'string');
      const rawHeading = typeof s.heading === 'string' ? s.heading : '';
      const cited = [rawHeading, ...rawPoints].flatMap((t) => [...t.slice(0, 2000).matchAll(CITE)].map((m) => m[1]));
      const uncite = (t) => t.slice(0, 2000).replace(CITE, '');
      const heading = farText(uncite(rawHeading), HEADING_MAX);
      const points = rawPoints.map((p) => farText(uncite(p), SECTION_POINT_MAX)).filter(Boolean).slice(0, SECTION_POINTS_MAX);
      const nums = [...(Array.isArray(s.quotes) ? s.quotes.slice(0, SECTION_QUOTES_MAX * 4) : []), ...cited].map(asNumber).filter((k) => Number.isInteger(k) && k >= 1 && k <= n);
      const quotes = [...new Set(nums)].slice(0, SECTION_QUOTES_MAX).map((k) => materials.points[k - 1].id);
      return heading || points.length ? { heading, points, quotes } : null;
    })
    .filter(Boolean)
    .slice(0, DRAFT_SECTIONS_MAX);
  if (!sections.length) throw Object.assign(new Error('骨組みを作れませんでした（AI の答えに節がありませんでした）。もう一度押してください'), { code: 'empty-outline' });
  // 題の [n] は引用にせず消す（題に番号は要らない）
  const title = farText(typeof r?.title === 'string' ? r.title.slice(0, 2000).replace(CITE, '') : '', OUTLINE_TITLE_MAX) || farText(materials.sources.map((s) => s.name).join('・'), 60) || '文章の骨組み';
  return { title, sources: materials.sources, sections };
}

/**
 * 引用の見え方: 点の今の文をそのまま（Kindle で伸ばしたハイライトは置き換わった先）と、書名・位置。
 * 引けない点は gone（notYet: この端末にまだ届いていない。PC で取り込んだ直後など。同期すると出る）
 * @returns {{ id: string, text: string, source: string, gone: boolean, notYet: boolean }}
 */
export function quoteOf(library, id) {
  const cur = currentPointId(library, id);
  const p = pointById(library, cur);
  if (!p) return { id: cur, text: '', source: '', gone: true, notYet: !pointArrived(library, cur) };
  // 書名・位置は 1 行に（同期で届いた書名の改行で、引用のあとに別の行を作らせない）
  const source = isThought(p) ? '思いつき（メモ）' : `『${farText(pointLabel(library, p), 100)}』${farText(placeText(p), 20)}`;
  return { id: cur, text: p.text, source, gone: false, notYet: false };
}

/** Markdown に出せない引用（消えた点・この端末にまだ無い点）の数 */
export function unavailableQuotes(library, outline) {
  return outline.sections.reduce((n, s) => n + s.quotes.filter((id) => quoteOf(library, id).gone).length, 0);
}

// 引用の文の行の区切り（Unicode の行区切り・段落区切り・NEL も改行として扱う。引用の外に行を作らせない）
const LINE_BREAK = new RegExp(`\\r\\n|[\\r\\n${String.fromCharCode(0x2028, 0x2029, 0x85)}]`);

/**
 * Markdown の記号を打ち消す（題・見出し・要点・書名は AI の文や同期で届いた文なので、画像・リンク・HTML・引用・見出しとして働かせない）。
 * 表示は同じ文になる。行頭の - + や「1.」も、箇条書きにしない
 */
export function escapeMarkdown(s) {
  return String(s ?? '')
    .replace(/[\\`*_[\]()<>#!|~{}]/g, '\\$&')
    .replace(/^([-+])/, '\\$1')
    .replace(/^(\d+)\./, '$1\\.');
}

/**
 * Markdown（# 題 / ## 見出し / - 要点 / > 引用の文 と — 書名・位置）。引用は点の文そのまま（行ごとに > を付ける）。
 * 題・見出し・要点・書名は記号を打ち消す。出せない引用は書かない
 */
export function outlineMarkdown(library, outline) {
  const out = [`# ${escapeMarkdown(outline.title || '文章の骨組み')}`];
  for (const s of outline.sections) {
    out.push('', `## ${escapeMarkdown(s.heading || '（見出しなし）')}`);
    if (s.points.length) out.push('', ...s.points.map((p) => `- ${escapeMarkdown(p)}`));
    for (const id of s.quotes) {
      const q = quoteOf(library, id);
      if (!q.gone) out.push('', ...q.text.split(LINE_BREAK).map((l) => `> ${l}`), `> — ${escapeMarkdown(q.source)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

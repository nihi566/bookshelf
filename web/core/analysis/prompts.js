// 「点 → 線 → 面 → 立体」とおすすめの本のためのプロンプトと JSON スキーマ
// 小さなローカルモデルでも崩れにくいよう、1 回の依頼は小さく・出力形式は固定にしている。

import { truncate } from '../text.js';

export const PROMPT_VERSION = 4;

const SYSTEM = `あなたは読書の知識を構造化する編集者です。
ユーザーが本に引いた線（ハイライト）と、本に関係なく書き留めた思いつきを「点」と呼びます。点どうしの共通項を抽象化して「線（概念）」を作り、線を束ねて「面（テーマ）」を作り、面の関係から知識の全体像「立体」を組み立てます。
- 必ず日本語で書く
- 引用文をそのまま繰り返さず、一段抽象化した言葉で表す
- 「読者自身の言葉」は、読者がその点をどう受け取ったかを表すので重く見る
- 指定された JSON だけを出力する（説明文やコードフェンスは付けない）`;

const str = { type: 'string' };
const strArray = { type: 'array', items: str };

/**
 * 線を作るときの点 1 つの書き方。書名（思いつきは「思いつき」）・線を引いた文・取り込んだメモと、
 * 読者が自分で付けたメモ・タグ（「読者自身の言葉」として取り込んだメモと分ける）
 * p = { text, label, thought?, note?, userNote?, tags? }
 */
export function pointLine(p, i) {
  const head = p.thought ? `[${i + 1}]（${truncate(p.label, 20)}・読者自身の言葉）` : `[${i + 1}]『${truncate(p.label, 40)}』`;
  const own = [p.userNote ? `メモ: ${truncate(p.userNote.replace(/\s+/g, ' '), 160)}` : '', p.tags?.length ? `タグ: ${p.tags.slice(0, 8).map((t) => '#' + t).join(' ')}` : ''].filter(Boolean).join(' ／ ');
  return `${head} ${truncate(p.text.replace(/\s+/g, ' '), 280)}${p.note ? `（取り込んだメモ: ${truncate(p.note.replace(/\s+/g, ' '), 120)}）` : ''}${own ? `（読者自身の言葉: ${own}）` : ''}`;
}

export function linePrompt(points) {
  const list = points.map(pointLine).join('\n');
  return {
    system: SYSTEM,
    name: 'line',
    user: `次の点（本に引いた線と思いつき）は、意味が近いものとして集まりました。これらをつなぐ「線」を作ってください。

${list}

書名を並べるのではなく、点に共通する考えの中身を自分の言葉で書いてください。「読者自身の言葉」があれば、その受け取り方を生かしてください。

出力する JSON:
{"name": "線の名前（15字以内の概念名）", "summary": "点に共通する考えを抽象化した説明（2〜3文）", "insight": "この線から生まれる問いや実践への示唆（1文）", "keywords": ["キーワード", "3〜5個"]}`,
    schema: {
      type: 'object',
      properties: { name: str, summary: str, insight: str, keywords: strArray },
      required: ['name', 'summary', 'insight', 'keywords'],
      additionalProperties: false,
    },
  };
}

/**
 * 読者が自分でまとめた線（永久ノート）を、面・立体を作る AI に見せる段落（G3-5）。無ければ空（前と同じ依頼文になる）
 * notes = [{ title, body }]
 */
export function humanLines(notes) {
  if (!notes?.length) return '';
  const list = notes.map((n, i) => `[N${i + 1}] ${humanLine(n)}`).join('\n');
  return `\n\n読者が自分の言葉でまとめた「人間がまとめた線」（永久ノート）。AI が作った線より重く見て、その考えを中心に組み立ててください:\n${list}`;
}

/** AI に見せる永久ノート 1 件（題 40 字・本文 200 字。面・立体の指紋もこの文で作る） */
export function humanLine(n) {
  const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  return `${truncate(oneLine(n.title) || '（題なし）', 40)}: ${truncate(oneLine(n.body), 200)}`;
}

/** 面を作る依頼。lines は面の中心に近い線から（最大 12 本）、more は見せていない線の数、notes はこの面の点を根拠にした永久ノート */
export function planePrompt(lines, { more = 0, notes = [] } = {}) {
  const list = lines.map((l, i) => `[${i + 1}] ${l.name}: ${truncate(l.summary, 200)}`).join('\n');
  return {
    system: SYSTEM,
    name: 'plane',
    user: `次の線（概念）は近いものとして集まりました。これらを束ねる「面（テーマ）」を作ってください。

${list}${more > 0 ? `\n（ほかに近い線が ${more} 本あります）` : ''}${humanLines(notes)}

線の名前や本の名前を並べるのではなく、線に共通する考えの中身を自分の言葉で書いてください。

出力する JSON:
{"name": "面の名前（15字以内のテーマ名）", "summary": "線どうしがどう関わり合い、全体として何を語っているか（2〜4文）"}`,
    schema: {
      type: 'object',
      properties: { name: str, summary: str },
      required: ['name', 'summary'],
      additionalProperties: false,
    },
  };
}

/**
 * 遠いつながりの判定: 別の本・別のテーマにある 2 つの点に、根っこで共通する考えがあるか。
 * a・b = { text, label, thought?, note?, userNote?, tags? }（pointLine と同じ形）
 */
export function farPrompt(a, b) {
  const one = (p, mark) => pointLine(p, 0).replace(/^\[1\]/, `[${mark}]`);
  return {
    system: SYSTEM,
    name: 'far',
    user: `次の 2 つの点は、別の本・別のテーマにあり、ふつうは結びつけて読まないものです。

${one(a, 'A')}
${one(b, 'B')}

2 つの根っこに、共通する考え（同じことを別の言葉で言っている、同じ原理の別の現れ、など）があるかを判定してください。
- 言葉が似ているだけ・こじつけになるなら shared は false にする
- shared が true なら、共通する考えを短く名付け、なぜつながるかを 1〜2 文で書く（点の文をそのまま繰り返さない。「A」「B」と書かず、それぞれの中身で指す）

出力する JSON:
{"shared": true, "idea": "共通する考え（20字以内）", "explanation": "なぜつながるか（1〜2文）"}`,
    schema: {
      type: 'object',
      properties: { shared: { type: 'boolean' }, idea: str, explanation: str },
      required: ['shared', 'idea', 'explanation'],
      additionalProperties: false,
    },
  };
}

export const RELATION_TYPES = ['支える', '対立する', '具体化する', '補完する'];

/** 立体を作る依頼。notes は永久ノート（人間がまとめた線。新しく直したものから最大 12 件） */
export function solidPrompt(planes, { notes = [] } = {}) {
  const refs = planes.map((_, i) => `P${i + 1}`);
  // 面ごとに線の名前は 12 本まで（線が多いと小さなモデルの読める長さを超える）
  const names = (ls) => `${ls.slice(0, 12).map((l) => l.name).join('、')}${ls.length > 12 ? ` ほか ${ls.length - 12} 本` : ''}`;
  const list = planes
    .map((p, i) => `P${i + 1}「${p.name}」: ${truncate(p.summary, 220)}\n  線: ${names(p.lines)}`)
    .join('\n');
  return {
    system: SYSTEM,
    name: 'solid',
    user: `読者の知識は次の面（テーマ）でできています。面どうしの関係を見て、知識を「立体」として組み立ててください。

${list}${humanLines(notes)}

- relations の type は「支える」「対立する」「具体化する」「補完する」のどれか 1 つ
- principles は「〜する」で終わる、明日から実践できる行動の原則
- questions は「〜か？」で終わる、まだ答えの無い問い

出力する JSON:
{"title": "この知識全体に付ける名前（20字以内）",
 "core": "全ての面を貫く中心的な考え（3〜5文）",
 "relations": [{"from": "P1", "to": "P2", "type": "支える", "description": "関係の説明（1文）"}],
 "principles": ["行動の原則（3〜5個）"],
 "questions": ["まだ答えが無い問い（2〜4個）"]}`,
    schema: {
      type: 'object',
      properties: {
        title: str,
        core: str,
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { from: { type: 'string', enum: refs }, to: { type: 'string', enum: refs }, type: { type: 'string', enum: RELATION_TYPES }, description: str },
            required: ['from', 'to', 'type', 'description'],
            additionalProperties: false,
          },
        },
        principles: strArray,
        questions: strArray,
      },
      required: ['title', 'core', 'relations', 'principles', 'questions'],
      additionalProperties: false,
    },
  };
}

export const RECOMMEND_KINDS = Object.freeze(['deepen', 'broaden', 'challenge']);
const KIND_TEXT = { deepen: '「deepen」（既存の面を掘り下げる）', broaden: '「broaden」（隣の分野へつなぐ）', challenge: '「challenge」（反対の立場・盲点を突く）' };
const CHALLENGE_NOTE = '「challenge」は、興味なしとした方向に近くても入れる';

/** 頼む種類（知らない種類は除く。空ならすべての種類） */
function kindsOf(kinds) {
  const ks = RECOMMEND_KINDS.filter((k) => kinds.includes(k));
  return ks.length ? ks : RECOMMEND_KINDS;
}

/**
 * おすすめの種類の指示。すべての種類なら、広げる・揺さぶるを必ず入れるよう頼む（好みに閉じないため）。
 * 一部なら、その種類だけを頼む（AI が選ばなかった種類を足すとき）
 */
function kindLine(ks) {
  const note = ks.includes('challenge') ? `（${CHALLENGE_NOTE}）` : '';
  if (ks.length < RECOMMEND_KINDS.length) return `- kind はすべて${ks.map((k) => KIND_TEXT[k]).join('か')}にする${note}`;
  return `- kind は${ks.map((k) => KIND_TEXT[k]).join('、')}をバランスよく。「broaden」と「challenge」を 1 つ以上ずつ入れる${note}`;
}

/** 種類を絞った依頼は別の名前にする（ログ・テストで、最初の依頼と見分けるため） */
const kindName = (name, ks) => (ks.length < RECOMMEND_KINDS.length ? `${name}-kind` : name);

/** おすすめへの反応から「好み」を伝える行（無ければ空） */
export function preferenceLines(prefs = {}) {
  const names = (list) => (list || []).slice(0, 20).map((f) => f.title).join('、');
  const lines = [];
  if (prefs.want?.length) lines.push(`- 読みたいと言った本: ${names(prefs.want)}（このような本を好む）`);
  if (prefs.no?.length) lines.push(`- 興味なしとした本: ${names(prefs.no)}（このような方向は避ける）`);
  return lines.join('\n');
}

export function recommendPrompt({ solid, planes, readTitles, count = 6, avoid = [], prefs = {}, kinds: wanted = RECOMMEND_KINDS }) {
  const kinds = kindsOf(wanted);
  const refs = planes.map((_, i) => `P${i + 1}`);
  const list = planes.map((p, i) => `P${i + 1}「${p.name}」: ${truncate(p.summary, 160)}`).join('\n');
  return {
    system: SYSTEM,
    name: kindName('recommendations', kinds),
    user: `読者の知識の全体像は次のとおりです。

核: ${solid?.core || '(なし)'}
面:
${list}
まだ答えが無い問い: ${(solid?.questions || []).join(' / ') || '(なし)'}

この読者に「次に」読んでほしい本を ${count} 冊選んでください。
- 読者がまだ読んでいない、実在する本だけを挙げる（書名と著者名は正確に。自信が無い本は挙げない）
- 読者が既に読んだ本（挙げてはいけない）: ${readTitles.slice(0, 60).join('、')}${avoid.length ? `\n- 次の本も挙げてはいけない: ${avoid.join('、')}` : ''}${preferenceLines(prefs) ? `\n${preferenceLines(prefs)}` : ''}
- 日本語で読める本を優先する
${kindLine(kinds)}

出力する JSON:
{"books": [{"title": "書名", "author": "著者名", "plane": "P1", "kind": "${kinds[0]}", "reason": "この読者の知識に照らした推薦理由（1〜2文）"}]}`,
    schema: {
      type: 'object',
      properties: {
        books: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: str, author: str, plane: { type: 'string', enum: refs }, kind: { type: 'string', enum: kinds }, reason: str },
            required: ['title', 'author', 'plane', 'kind', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['books'],
      additionalProperties: false,
    },
  };
}

/** おすすめ（書誌 DB を使う版）1: 本を探すための検索語を決める */
export function searchPrompt({ solid, planes, count = 5, prefs = {}, kinds: wanted = RECOMMEND_KINDS }) {
  const kinds = kindsOf(wanted);
  const refs = planes.map((_, i) => `P${i + 1}`);
  const list = planes.map((p, i) => `P${i + 1}「${p.name}」: ${truncate(p.summary, 160)}`).join('\n');
  return {
    system: SYSTEM,
    name: kindName('searches', kinds),
    user: `読者の知識の全体像は次のとおりです。

核: ${solid?.core || '(なし)'}
面:
${list}
まだ答えが無い問い: ${(solid?.questions || []).join(' / ') || '(なし)'}

この読者が次に読む本を書店で探すための検索語を ${count} 個考えてください。
- query は本のテーマを表す短い日本語（1〜3 語。例: 「習慣 行動科学」「ストア哲学」）${preferenceLines(prefs) ? `\n${preferenceLines(prefs)}` : ''}
${kindLine(kinds)}

出力する JSON:
{"searches": [{"query": "検索語", "plane": "P1", "kind": "${kinds[0]}"}]}`,
    schema: {
      type: 'object',
      properties: {
        searches: {
          type: 'array',
          items: {
            type: 'object',
            properties: { query: str, plane: { type: 'string', enum: refs }, kind: { type: 'string', enum: kinds } },
            required: ['query', 'plane', 'kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['searches'],
      additionalProperties: false,
    },
  };
}

/** おすすめ（書誌 DB を使う版）2: 実在する候補の中から選ばせる */
export function pickPrompt({ solid, planes, candidates, count = 6, prefs = {}, kinds: wanted = RECOMMEND_KINDS }) {
  const kinds = kindsOf(wanted);
  const refs = planes.map((_, i) => `P${i + 1}`);
  const list = planes.map((p, i) => `P${i + 1}「${p.name}」: ${truncate(p.summary, 120)}`).join('\n');
  const books = candidates.map((c, i) => `[${i + 1}] 『${truncate(c.title, 60)}』${c.authors ? ` ${truncate(c.authors, 40)}` : ''}${c.publishedDate ? `（${String(c.publishedDate).slice(0, 4)}）` : ''}${c.description ? ` — ${truncate(c.description, 100)}` : ''}`).join('\n');
  return {
    system: SYSTEM,
    name: kindName('picks', kinds),
    user: `読者の知識の全体像:
核: ${solid?.core || '(なし)'}
面:
${list}

書店で見つけた本の候補:
${books}

候補の中から、この読者に次に読んでほしい本を最大 ${count} 冊選び、読者の知識に照らした理由を書いてください。
- candidate は候補の番号${preferenceLines(prefs) ? `\n${preferenceLines(prefs)}` : ''}
${kindLine(kinds)}

出力する JSON:
{"picks": [{"candidate": 1, "plane": "P1", "kind": "${kinds[0]}", "reason": "推薦理由（1〜2文）"}]}`,
    schema: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { candidate: { type: 'integer' }, plane: { type: 'string', enum: refs }, kind: { type: 'string', enum: kinds }, reason: str },
            required: ['candidate', 'plane', 'kind', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['picks'],
      additionalProperties: false,
    },
  };
}

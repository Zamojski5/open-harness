// Reading a spending cap out of the user's own words. A cap counts only when the user stated it:
// a quote of whole sentences they wrote, or the label of a card option they picked. Plain "yes",
// unit prices ("$3 per clip"), prices of things, two different sums, and figures they rejected
// state no cap. English, Polish and a few other languages are understood; amounts are in USD.

export interface UserWords {
  at: number;
  source: "prompt" | "card";
  text: string;
  /** card answers: the question that was asked */
  question?: string;
  /** card answers: the answer is one of the offered option labels (not typed text) */
  picked?: boolean;
}

/** Answers to an approval card are decisions about one batch, never statements of a cap. */
export const isApprovalAnswer = (w: UserWords) =>
  w.source === "card" && /\(approval ap-[\w-]+[ )]/.test(w.question ?? "");

/** Lower-case, unify quotes/space/compatibility forms, drop trailing punctuation. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?,;:…]+$/u, "");
}

/** The user's own text: pasted quotes (> lines) and code are not their words. */
export function ownText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

export function sentences(text: string): string[] {
  return ownText(text)
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map(normalize)
    .filter(Boolean);
}

/** The quote is the whole message, or each of its sentences is a whole sentence of the message. */
export function quotesOwnSentences(quote: string, message: string): boolean {
  const q = normalize(ownText(quote));
  if (!q) return false;
  if (q === normalize(ownText(message))) return true;
  const mine = new Set(sentences(message));
  const parts = sentences(quote);
  return parts.length > 0 && parts.every((s) => mine.has(s));
}

const MONEY_BEFORE = /(\$|usd|us\$|€|eur|£|gbp)\s?$/;
const MONEY_AFTER = /^\s?(dollars?|dolar(?:y|ów|a)?|usd|bucks|credits|euros?|eur)\b/;
// "make it $10 instead", "lower it to $10", "zmniejsz do 10": a new (usually lower) cap.
const CHANGE_TO =
  "make it|lower(?: it| the cap| the budget)? to|reduce(?: it)? to|cut(?: it)? to|drop(?: it)? to|change(?: it)? to|set(?: it| the cap)? to|zmniejsz(?: go| to| limit| budżet)?(?: do)?|obniż(?: go| to| limit| budżet)?(?: do)?|zmień(?: go| to)? na|zejdź do|niech będzie";
const CAP_BEFORE = new RegExp(
  `(up to|upto|under|below|max(?:imum)?|budget|limit|at most|no more than|not more than|less than|within|ceiling|tops|cap(?:ped)?(?: at| of)?|spend(?:ing)?|pay|do|maks(?:ymalnie)?|budżet(?:em)?|limit(?:em)?|nie więcej niż|więcej niż|ponad|poniżej|wydaj|wydać|wydawaj|bis zu|hasta|jusqu'à|fino a|até|${CHANGE_TO})\\b[^.!?$]{0,24}$`,
);
const CAP_AFTER = /^\s?(max|maximum|tops|total|or less|łącznie|maks(?:ymalnie)?|razem)\b/;
const PER_ITEM =
  /^\s?(\/|per\b|each\b|apiece\b|a (clip|shot|video|image|take|month|second|minute|year)\b|monthly|za (klip|ujęcie|sztukę|zdjęcie|sekundę|miesiąc)|na (klip|ujęcie|sztukę|miesiąc)|miesięcznie)/;
const DESCRIBED = /\b(costs?|priced|paid|sells|charged|kosztuje|kosztował|zapłaciłem|płacę)\b/;
const NON_SPEND =
  /\b(off|discount|revenue|sales|plan|tier|save|saved|starts?|prices?|earn(?:ed|s)?|rabat|zniżk\w*|przychód|sprzedaż)\b/;
const REJECTED = /^[^.!?]{0,12}\b(too much|not ok|no way|za dużo|za drogo|nie zgadzam)/;
const NEGATED =
  /\b(can'?t|cannot|won'?t|will not|nie mogę|nie możemy)\s+(spend|pay|wydać|zapłacić)\s*$/;
const SPEND_WORD = new RegExp(
  `\\b(spend|pay|budget|cap|limit|wydaj|wydać|budżet|limit|${CHANGE_TO})\\b[^.!?\\d]{0,20}$`,
);

interface Figure {
  value: number;
}

function parseAmount(raw: string, k: string | undefined): number {
  let s = raw;
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(",", ".");
  return Number(s) * (k ? 1000 : 1);
}

/** Every sum of money a sentence names (with a currency), whatever it is about. */
function namedSums(sentence: string): number[] {
  const text = sentence.replace(/"[^"]*"/g, " ");
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)*)(k)?/g)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index! + m[0].length);
    if (MONEY_BEFORE.test(before) || MONEY_AFTER.test(after)) out.push(parseAmount(m[1]!, m[2]));
  }
  return out;
}

/** Money figures in one sentence that state a cap (others are dropped with the rules above). */
function capFigures(sentence: string): Figure[] {
  const text = sentence.replace(/"[^"]*"/g, " ");
  const out: Figure[] = [];
  const re = /(\d+(?:[.,]\d+)*)(k)?/g;
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    // 1080p, 30-second, 4k-resolution and similar are not money
    if (/^(p\b|-|x\d|\s?(s|sec|seconds?|sekund\w*|min\w*|fps|px|%))/.test(after)) continue;
    const money = MONEY_BEFORE.test(before) || MONEY_AFTER.test(after);
    const clause = before.split(/[,;:]/).at(-1) ?? before;
    const lead = clause.replace(MONEY_BEFORE, "");
    const capWording = CAP_BEFORE.test(lead) || CAP_AFTER.test(after.replace(MONEY_AFTER, ""));
    const onlyMoney = money && normalize(text).replace(/[$€£\s]|usd|dollars?/g, "") === m[0];
    const spendFigure = !money && !m[2] && SPEND_WORD.test(clause);
    if (!((money && (capWording || onlyMoney)) || spendFigure)) continue;
    const tail = after.replace(MONEY_AFTER, "");
    if (PER_ITEM.test(tail)) continue;
    if (DESCRIBED.test(clause) && !CAP_BEFORE.test(lead)) continue;
    if (NON_SPEND.test(clause.slice(-30)) || /^\s?(off|discount|rabatu?)\b/.test(tail)) continue;
    if (NEGATED.test(clause.replace(MONEY_BEFORE, "").trimEnd())) continue;
    if (REJECTED.test(tail)) continue;
    out.push({ value: parseAmount(m[1]!, m[2]) });
  }
  return out;
}

const ZERO_SPEND =
  /(no paid\b|don'?t spend(?! more| over| above)|do not spend(?! more| over| above)|spend nothing|zero budget|\$0 budget|only free tools|free tools only|free only|keep it free|for free|nothing paid|bez płatnych|nic nie wydawaj|nie wydawaj(?! więcej| ponad| powyżej)|za darmo|tylko darmowe|tylko za darmo|zero złotych|zerowy budżet)/;
const ALLOWS_PAYING =
  /(otherwise|unless|if needed|if necessary|up to|can pay|no limit|not only|chyba że|w razie potrzeby|jeśli trzeba|do kwoty|nie tylko)/;
const PAYING_WORD = /(\$\s?[1-9]|\bpaid\b|\bpay\b|zapłać|płatn)/;

/** "free tools only" and the like: a $0 cap, unless the sentence also allows paying. */
export function saysNothingPaid(text: string): boolean {
  const t = normalize(ownText(text));
  if (!ZERO_SPEND.test(t) || ALLOWS_PAYING.test(t)) return false;
  return !PAYING_WORD.test(t.replace(ZERO_SPEND, " "));
}

/**
 * Caps a text states (USD). A text that names two different sums of money states none, even when
 * only one of them is cap-shaped ("up to $20, I paid $200 last time").
 */
export function statedCaps(text: string): number[] {
  const values = new Set<number>();
  const named = new Set<number>();
  for (const s of sentences(text)) {
    for (const f of capFigures(s)) values.add(f.value);
    for (const n of namedSums(s)) named.add(n);
  }
  if (saysNothingPaid(text)) values.add(0);
  for (const v of values) named.add(v);
  return values.size === 1 && named.size === 1 ? [...values] : [];
}

/** Does a sentence talk about money at all (any sum, a spend figure, or a no-spend phrase)? */
export function mayGiveCap(sentence: string): boolean {
  return (
    namedSums(sentence).length > 0 || capFigures(sentence).length > 0 || saysNothingPaid(sentence)
  );
}

/** The user's latest words about money and the cap they state (undefined = none stated there). */
export function latestMoneyWords(
  words: UserWords[],
): { words: UserWords; sentence: string; cap: number | undefined } | undefined {
  const latest = [...words]
    .filter((w) => !isApprovalAnswer(w) && sentences(w.text).some(mayGiveCap))
    .sort((a, b) => b.at - a.at)[0];
  if (!latest) return undefined;
  const sentence = sentences(latest.text).filter(mayGiveCap).at(-1)!;
  const pick = latest.source === "card" && latest.picked !== false;
  const caps = pick ? statedCaps(latest.text) : statedCaps(sentence);
  return { words: latest, sentence, cap: caps.length === 1 ? caps[0] : undefined };
}

const FREE_WORD = /(free|gratis|kostenlos|darmo|darmowe|бесплатн|無料|免费|무료)/;

/** A picked option label states this cap. */
export function pickNamesCap(limit: number, label: string): boolean {
  const caps = statedCaps(label);
  if (caps.includes(limit)) return true;
  const sums = [...normalize(label).matchAll(/\$?\s?(\d+(?:[.,]\d+)?)/g)].map((m) =>
    parseAmount(m[1]!, undefined),
  );
  if (limit === 0)
    return sums.every((s) => s === 0) && (/\b0\b/.test(label) || FREE_WORD.test(normalize(label)));
  return sums.length === 1 && sums[0] === limit && /\$|usd|dollar/i.test(label);
}

export type CapCheck =
  | { ok: true; via: "quote" | "card"; words: UserWords }
  | { ok: false; reason: string };

/**
 * Accept `limit` only when `quote` is the user's own words (whole sentences of one of their
 * messages, or a card option they picked) that state exactly this cap, and the user's latest words
 * about money don't state anything else. Answers to approval cards never count.
 */
export function checkCapQuote(limit: number, quote: string, words: UserWords[]): CapCheck {
  const own = words.filter((w) => !isApprovalAnswer(w));
  // A picked option is matched by its label; anything typed (prompt or card free text) by sentences.
  const isPick = (w: UserWords) => w.source === "card" && w.picked !== false;
  const matches = own.filter((w) =>
    isPick(w) ? normalize(w.text) === normalize(quote) : quotesOwnSentences(quote, w.text),
  );
  if (!matches.length)
    return {
      ok: false,
      reason:
        "The quote is not something the user wrote in this chat. Quote whole sentences of their message (or the card option they picked), or ask them for a cap.",
    };
  const latestMatch = matches.sort((a, b) => b.at - a.at)[0]!;
  const states = isPick(latestMatch)
    ? pickNamesCap(limit, quote)
    : statedCaps(quote).includes(limit);
  if (!states)
    return {
      ok: false,
      reason:
        limit === 0
          ? 'The quote does not rule out paying. A $0 cap needs words like "free tools only" or "don\'t spend anything", with no "unless"/"up to".'
          : `The quote does not state a cap of $${limit}. Unit prices ("$3 per clip"), prices of things, two different sums and a plain "yes" are not caps.`,
    };
  const latest = latestMoneyWords(own);
  if (latest && latest.cap !== limit)
    return {
      ok: false,
      reason: `The user's latest words about money ("${latest.sentence}") don't state $${limit}. Use what they said last, or ask.`,
    };
  return { ok: true, via: isPick(latestMatch) ? "card" : "quote", words: latestMatch };
}

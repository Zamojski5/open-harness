import { describe, expect, it } from "vite-plus/test";
import {
  checkCapQuote,
  latestMoneyWords,
  pickNamesCap,
  quotesOwnSentences,
  saysNothingPaid,
  statedCaps,
  type UserWords,
} from "../src/media/capwords.ts";

const said = (text: string, at = 1, source: UserWords["source"] = "prompt"): UserWords => ({
  at,
  source,
  text,
});

describe("statedCaps", () => {
  it.each([
    ["Spend up to $20 on this.", [20]],
    ["Budget is $7.50", [7.5]],
    ["max 15 dollars", [15]],
    ["$20.", [20]],
    ["don't spend more than 20", [20]],
    ["Możesz wydać do 30 USD.", [30]],
    ["budżet 12,50 $", [12.5]],
    ["no more than $1k total", [1000]],
  ])("%s → %j", (text, caps) => expect(statedCaps(text)).toEqual(caps));

  it.each([
    "yes",
    "ok, go",
    "$3 per clip is fine",
    "each take is $2",
    "$3/clip",
    "the plan costs $49",
    "we spend $200 a month",
    "use 1080p and 30-second clips",
    "3",
    "from $20 to $5",
    "$20, actually keep it free",
    "$50 is too much",
    "I cannot spend $50",
    "20% off",
  ])("%s states no cap", (text) => expect(statedCaps(text)).toEqual([]));

  it("$0 from no-spend wording, unless paying is still allowed", () => {
    expect(saysNothingPaid("Free tools only, please.")).toBe(true);
    expect(saysNothingPaid("Nic nie wydawaj.")).toBe(true);
    expect(statedCaps("keep it free")).toEqual([0]);
    expect(saysNothingPaid("keep it free unless you really need to")).toBe(false);
    expect(saysNothingPaid("free tools only, up to $5 if needed")).toBe(false);
    expect(saysNothingPaid("no budget")).toBe(false);
  });
});

describe("quotes and picks", () => {
  it("a quote must be whole sentences of one user message", () => {
    const msg = "Make the ad. Spend up to $20. Thanks!";
    expect(quotesOwnSentences("Spend up to $20.", msg)).toBe(true);
    expect(quotesOwnSentences("spend up to $20", msg)).toBe(true);
    expect(quotesOwnSentences("up to $20", msg)).toBe(false);
    expect(quotesOwnSentences("Spend up to $20.", "> Spend up to $20.\nok")).toBe(false);
  });

  it("card labels name the cap", () => {
    expect(pickNamesCap(5, "Up to $5")).toBe(true);
    expect(pickNamesCap(0, "Free only ($0 cap)")).toBe(true);
    expect(pickNamesCap(20, "Up to $5")).toBe(false);
  });
});

describe("checkCapQuote", () => {
  it("accepts the user's sentence that states the cap", () => {
    expect(checkCapQuote(20, "Spend up to $20.", [said("Ok. Spend up to $20.")])).toMatchObject({
      ok: true,
      via: "quote",
    });
  });

  it("accepts a picked card label", () => {
    expect(checkCapQuote(5, "Up to $5", [said("Up to $5", 2, "card")])).toMatchObject({
      ok: true,
      via: "card",
    });
  });

  it("refuses words the user never wrote, a plain yes, and a mismatching sum", () => {
    expect(checkCapQuote(20, "Spend up to $20.", [said("make a video")]).ok).toBe(false);
    expect(checkCapQuote(20, "yes", [said("yes")]).ok).toBe(false);
    expect(checkCapQuote(30, "Spend up to $20.", [said("Spend up to $20.")]).ok).toBe(false);
  });

  it("the latest words about money win", () => {
    const words = [said("Spend up to $20.", 1), said("Actually, make it $10 max.", 2)];
    const r = checkCapQuote(20, "Spend up to $20.", words);
    expect(r.ok).toBe(false);
    expect(checkCapQuote(10, "Actually, make it $10 max.", words).ok).toBe(true);
  });
});

describe("review findings: natural phrasings and edge cases", () => {
  it.each([
    ["Actually, make it $10 instead.", [10]],
    ["Lower it to $10.", [10]],
    ["Nie wydawaj więcej niż 20 USD.", [20]],
    ["max 5 dolarów", [5]],
    ["zmniejsz do 10", [10]],
    ["Obniż budżet do 8 dolarów.", [8]],
  ])("M1: %s → %j", (text, caps) => expect(statedCaps(text)).toEqual(caps));

  it("M1: a later lowering wins over the earlier cap", () => {
    const words = [said("Spend up to $20.", 1), said("Actually, make it $10 instead.", 2)];
    expect(checkCapQuote(20, "Spend up to $20.", words).ok).toBe(false);
    expect(checkCapQuote(10, "Actually, make it $10 instead.", words).ok).toBe(true);
    expect(latestMoneyWords(words)?.cap).toBe(10);
  });

  it("M1: any later sum counts as the latest money words", () => {
    const words = [said("Spend up to $20.", 1), said("The logo cost me $50 last year.", 2)];
    expect(checkCapQuote(20, "Spend up to $20.", words).ok).toBe(false);
  });

  it("L6: a message naming two sums states no cap", () => {
    expect(statedCaps("Spend up to $20, I paid $200 for the last one.")).toEqual([]);
  });

  it("M3: an approval answer is never a cap", () => {
    const approval: UserWords = {
      at: 5,
      source: "card",
      question: "Estimated cost: $48.00\n(approval ap-12345678)",
      text: "Approve $48.00",
      picked: true,
    };
    expect(checkCapQuote(48, "Approve $48.00", [approval]).ok).toBe(false);
    expect(latestMoneyWords([said("Spend up to $20.", 1), approval])?.cap).toBe(20);
  });

  it("free text typed into a card counts as the user's own sentence, not as a picked label", () => {
    const typed: UserWords = { at: 1, source: "card", text: "Spend up to $5.", picked: false };
    expect(checkCapQuote(5, "Spend up to $5.", [typed])).toMatchObject({ ok: true, via: "quote" });
  });
});

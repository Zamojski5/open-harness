import { describe, expect, it } from "vite-plus/test";
import {
  computeCase,
  deliverableOf,
  maxConcurrency,
  NOT_RECORDED,
  unionMs,
  type CaseInputs,
  type JobRecord,
} from "../src/case/metrics.ts";
import {
  numberCards,
  redact,
  redactDeep,
  storyMoments,
  type PresentOptions,
} from "../src/case/present.ts";
import { fitDurations } from "../src/case/render.ts";
import type { LedgerLine } from "../src/media/ledger.ts";

const P = "/work/acme-launch";
const RW = "runware:bytedance:seedance@2.5";
const FAL = "bytedance/seedance-2.5/text-to-video";

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord => ({
  id,
  projectPath: P,
  threadId: "th-1",
  model: RW,
  kind: "video",
  state: "completed",
  request: { model: RW, prompt: "x", parameters: { duration: 5 } },
  served: { provider: "runware", model: RW, endpoint: "runware" },
  createdAt: 1_000,
  ...over,
});

const line = (
  key: string,
  state: LedgerLine["state"],
  charge?: number,
  max: number | null = 5,
): LedgerLine => ({
  v: 2,
  key,
  chatId: "th-1",
  day: "2026-11-09",
  at: 1,
  state,
  estimateUsd: max,
  maxUsd: max,
  ...(charge !== undefined ? { chargeUsd: charge, chargeSource: "provider" as const } : {}),
});

const draftReq = { model: RW, prompt: "x", parameters: { duration: 5, draft: true } };

function inputs(over: Partial<CaseInputs> = {}): CaseInputs {
  const jobs: JobRecord[] = [
    job("d1", {
      request: draftReq,
      draft: { id: "dr1", provider: "runware", model: RW, seconds: 5 },
    }),
    job("d2", {
      request: draftReq,
      draft: { id: "dr2", provider: "runware", model: RW, seconds: 5 },
    }),
    job("d3", {
      request: draftReq,
      draft: { id: "dr3", provider: "runware", model: RW, seconds: 5 },
    }),
    job("f1", {
      request: {
        model: RW,
        prompt: "x",
        finishDraft: { draftId: "dr2", provider: "runware", seconds: 5, ofJob: "d2" },
      },
    }),
    // asked for fal, served by runware (cheapest route)
    job("s1", {
      model: FAL,
      request: { model: FAL, prompt: "x", parameters: { duration: 5, resolution: "720p" } },
    }),
    job("x1", {
      model: "fal-ai/flux/dev",
      request: { model: "fal-ai/flux/dev", prompt: "y" },
      served: { provider: "fal", model: "fal-ai/flux/dev", endpoint: "f" },
    }),
    job("r1", { model: "fal-ai/flux/dev", request: { model: "fal-ai/flux/dev", prompt: "z" } }),
    // other project: never counted
    job("o1", { projectPath: "/work/other" }),
  ];
  return {
    project: P,
    jobs: { file: "/oh/media/jobs", records: jobs },
    ledger: {
      file: "/oh/media/ledger.jsonl",
      lines: [
        line("d1", "reserved"),
        line("d1", "spent", 0.5),
        line("d2", "spent", 0.5),
        line("d3", "spent", 0.5),
        line("f1", "spent", 3),
        line("s1", "spent", 1.15),
        line("r1", "released"),
        line("o1", "spent", 99),
        // x1 has no ledger line → not recorded
      ],
    },
    threads: {
      file: "/t3/userdata/statev2.sqlite",
      threads: [
        {
          threadId: "th-1",
          title: "Acme hero film",
          turns: [
            { turnId: "a", startedAt: 0, endedAt: 600_000 },
            { turnId: "b", startedAt: 3_600_000, endedAt: 4_200_000 },
            { turnId: "open", startedAt: 5_000_000 },
          ],
          userMessages: [
            { id: "m1", at: 0, text: "Make a 15 s Acme launch film" },
            { id: "m2", at: 3_600_000 },
          ],
          approvals: [
            { id: "ap1", requestedAt: 100_000, resolvedAt: 160_000, decision: "accept" },
            { id: "ap2", requestedAt: 200_000 },
          ],
        },
        {
          threadId: "th-2",
          title: "Acme stills",
          turns: [{ turnId: "c", startedAt: 300_000, endedAt: 900_000 }],
          userMessages: [{ id: "m3", at: 300_000 }],
          approvals: [],
        },
      ],
    },
    takes: {
      file: `${P}/takes/ledger.json`,
      picked: "t3",
      takes: [
        { id: "t1", file: "takes/hero-take-01.mp4", score: 5, added: "2026-11-01T10:00:00Z" },
        { id: "t2", file: "takes/hero-take-02.mp4", score: 6.5, added: "2026-11-01T11:00:00Z" },
        { id: "t3", file: "takes/hero-take-03.mp4", score: 8, added: "2026-11-01T12:00:00Z" },
        { id: "t4", file: "takes/poster_v1.png", added: "2026-11-01T12:30:00Z" },
      ],
    },
    goals: {
      dir: "/oh/quality-goals",
      records: [
        {
          file: "/oh/quality-goals/th-1.json",
          threadId: "th-1",
          objective: "Acme hero film at 8/10",
          target: 8,
          startedAt: 0,
          status: "met",
          reviews: [
            { at: 10, score: 6, meetsBar: false, work: [] },
            { at: 20, score: 7, meetsBar: false, work: [] },
            { at: 30, score: 8.5, meetsBar: true, work: [] },
          ],
        },
      ],
    },
    moments: { file: `${P}/.open-herness/key-moments.jsonl`, records: [] },
    deliverables: {
      dir: `${P}/delivery`,
      records: [
        {
          file: "delivery/hero.mp4",
          format: "mp4",
          width: 1080,
          height: 1920,
          durationSeconds: 15,
        },
      ],
    },
    ...over,
  };
}

describe("case-study spend", () => {
  const n = computeCase(inputs(), 0);
  it("totals only this project's ledger charges; missing lines are not recorded, released are $0", () => {
    expect(n.spend.total.value).toEqual({
      usd: 5.65,
      jobsCounted: 6,
      jobsNotRecorded: 1,
      jobsWorstCase: 0,
    });
    expect(n.spend.jobs.find((j) => j.jobId === "x1")?.usd).toBe(NOT_RECORDED);
    expect(n.spend.jobs.find((j) => j.jobId === "r1")?.usd).toBe(0);
    expect(n.spend.jobs.some((j) => j.jobId === "o1")).toBe(false);
    expect(n.spend.total.sources[1]?.file).toBe("/oh/media/ledger.jsonl");
  });
  it("splits by role and by route", () => {
    const role = Object.fromEntries(n.spend.byRole.map((b) => [b.key, b.usd]));
    expect(role).toEqual({ draft: 1.5, finish: 3, standard: 1.15 });
    const fal = n.spend.byRoute.find((b) => b.key === "fal:fal-ai/flux/dev");
    expect(fal).toMatchObject({ jobs: 1, notRecorded: 1, usd: 0 });
  });
  it("counterfactual: every draft take at 1080p list price on its route vs drafts + finishes paid", () => {
    const v = n.spend.withoutDrafts.value;
    if (v === NOT_RECORDED) throw new Error("expected a counterfactual");
    // runware 1080p list price $0.61354/s × 5 s × 3 drafts
    expect(v.counterfactualUsd).toBeCloseTo(3 * 0.61354 * 5, 2);
    expect(v.actualUsd).toBe(4.5);
    expect(v.savedUsd).toBeCloseTo(9.203 - 4.5, 2);
    expect(v.rows).toHaveLength(3);
    expect(n.spend.withoutDrafts.method).toMatch(/1080p/);
  });
  it("counterfactual is not recorded when a draft has no charge", () => {
    const i = inputs();
    i.ledger.lines = i.ledger.lines.filter((l) => l.key !== "d3");
    const v = computeCase(i).spend.withoutDrafts;
    expect(v.value).toBe(NOT_RECORDED);
    expect(v.sources[0]?.note).toMatch(/no recorded charge/);
  });
  it("cheapest route: list price on the asked route vs the served one", () => {
    const v = n.spend.cheapestRoute.value;
    if (v === NOT_RECORDED) throw new Error("expected route savings");
    const s1 = v.rows.find((r) => r.jobId === "s1")!;
    expect(s1.defaultRoute.startsWith("fal:")).toBe(true);
    expect(s1.defaultUsd).toBeCloseTo(0.473 * 5, 3);
    expect(s1.servedUsd).toBeCloseTo(0.2304 * 5, 3);
  });
});

describe("case-study time and iterations", () => {
  const n = computeCase(inputs(), 0);
  it("active time sums closed turns, skips open ones; concurrency from overlaps", () => {
    expect(n.time.activeAgent.value).toEqual({ ms: 1_800_000, turns: 3, unionMs: 1_500_000 });
    expect(n.time.openTurnsSkipped).toBe(1);
    expect(n.time.maxConcurrency.value).toMatchObject({ threads: 2 });
    expect(n.time.wallClock.value).toMatchObject({ startAt: 0, endAt: 4_200_000 });
    expect(n.human.userMessages.value).toBe(3);
    expect(n.human.approvalWait.value).toEqual({ ms: 60_000, approvals: 1, unresolved: 1 });
  });
  it("back-to-back turns do not overlap; union counts overlap once", () => {
    expect(
      maxConcurrency([
        { threadId: "a", start: 0, end: 10 },
        { threadId: "b", start: 10, end: 20 },
      ]).max,
    ).toBe(1);
    expect(
      unionMs([
        { start: 0, end: 10 },
        { start: 5, end: 20 },
        { start: 30, end: 40 },
      ]),
    ).toBe(30);
  });
  it("takes per deliverable and goal scores first → last", () => {
    const t = n.iterations.takes.value;
    if (t === NOT_RECORDED) throw new Error("takes");
    expect(t.total).toBe(4);
    expect(t.perDeliverable.find((d) => d.group === "takes/hero")).toMatchObject({
      takes: 3,
      picked: true,
      firstScore: 5,
      lastScore: 8,
    });
    expect(deliverableOf("renders/poster_v12.png")).toBe("renders/poster");
    const g = n.iterations.goals.value;
    if (g === NOT_RECORDED) throw new Error("goals");
    expect(g[0]).toMatchObject({ first: 6, last: 8.5, best: 8.5, reviews: 3 });
  });
  it("range filters turns, messages and takes", () => {
    const n2 = computeCase(inputs({ range: { from: 3_000_000 } }));
    expect(n2.time.activeAgent.value).toMatchObject({ turns: 1, ms: 600_000 });
    expect(n2.human.userMessages.value).toBe(1);
  });
  it("without thread data every time/human number is 'not recorded' with the reason", () => {
    const n2 = computeCase(
      inputs({ threads: { unavailable: "server database not found", threads: [] } }),
    );
    expect(n2.time.activeAgent.value).toBe(NOT_RECORDED);
    expect(n2.time.wallClock.sources[0]?.note).toBe("server database not found");
    expect(n2.human.userMessages.value).toBe(NOT_RECORDED);
    const cards = numberCards(n2, { title: "", brief: "", briefSource: "" });
    expect(cards[0]).toMatchObject({ big: NOT_RECORDED, recorded: false });
  });
  it("no jobs / no takes / no goals → not recorded, nothing invented", () => {
    const n2 = computeCase(
      inputs({
        jobs: { file: "/j", records: [] },
        takes: { file: "/t", takes: [] },
        goals: { dir: "/g", records: [] },
        deliverables: { dir: "/d", records: [] },
      }),
    );
    expect(n2.spend.total.value).toBe(NOT_RECORDED);
    expect(n2.spend.withoutDrafts.value).toBe(NOT_RECORDED);
    expect(n2.iterations.takes.value).toBe(NOT_RECORDED);
    expect(n2.iterations.goals.value).toBe(NOT_RECORDED);
    expect(n2.deliverables.value).toBe(NOT_RECORDED);
    expect(n2.agencyEstimate).toBeUndefined();
  });
});

describe("case-study presentation flags", () => {
  const base: PresentOptions = {
    title: "Acme launch",
    brief: "Acme wants a film",
    briefSource: "",
  };
  it("redacts client names, inflected forms included, only when confidential", () => {
    expect(
      redact("Acme film for ACME Corp; Acmeville goes; MyAcme stays", {
        confidential: true,
        clientNames: ["Acme"],
      }),
    ).toBe("Client film for Client Corp; Client goes; MyAcme stays");
    // Polish inflection, file names, decomposed (NFD) letters as macOS file names carry them
    expect(
      redact("Spot dla Orlenu, orlen-spot.mp4, Żabką".normalize("NFD"), {
        confidential: true,
        clientNames: ["Orlen", "Żabka"],
      }),
    ).toBe("Spot dla Client, Client-spot.mp4, Client");
    expect(redact("Acme film", { clientNames: ["Acme"] })).toBe("Acme film");
  });
  it("redactDeep replaces names and the project path in numbers.json", () => {
    const n = computeCase(inputs(), 0);
    const out = JSON.stringify(
      redactDeep(n, { ...base, confidential: true, clientNames: ["Acme"] }, P),
    );
    expect(out).not.toMatch(/Acme/);
    expect(out).not.toContain(P);
    expect(out).toContain("<project>");
  });
  it("relative-only cards carry no $ or absolute hours", () => {
    const n = computeCase({ ...inputs(), agencyEstimateHours: 40 }, 0);
    const cards = numberCards(n, {
      ...base,
      confidential: true,
      relativeOnly: true,
      clientNames: ["Acme"],
    });
    const text = cards.map((c) => `${c.big} ${c.label} ${c.note}`).join("\n");
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/\d+ (min|h)\b/);
    expect(text).toMatch(/%/);
    expect(text).toMatch(/user's estimate/);
  });
  it("agency comparison appears only with the user's estimate, labelled as theirs", () => {
    const without = numberCards(computeCase(inputs(), 0), base);
    expect(without.some((c) => /agency/.test(c.label))).toBe(false);
    const n = computeCase({ ...inputs(), agencyEstimateHours: 40 }, 0);
    expect(n.agencyEstimate).toEqual({ hours: 40, label: "user's estimate" });
    expect(numberCards(n, base).find((c) => /agency/.test(c.label))?.label).toMatch(
      /user's estimate/,
    );
  });
  it("story moments prefer score changes, keep time order", () => {
    const m = storyMoments(
      [
        { at: 5, kind: "approval_accepted", label: "a" },
        { at: 3, kind: "score_change", label: "s", data: { from: 6, to: 8 } },
        { at: 1, kind: "take_picked", label: "p" },
      ],
      2,
    );
    expect(m.map((x) => x.kind)).toEqual(["take_picked", "score_change"]);
  });
  it("video segment lengths are fitted into 45-60 s", () => {
    const short = fitDurations([4, 3, 3]);
    expect(short.reduce((s, x) => s + x, 0)).toBeCloseTo(45, 5);
    const long = fitDurations(Array.from({ length: 30 }, () => 3));
    expect(long.reduce((s, x) => s + x, 0)).toBeCloseTo(60, 5);
    expect(fitDurations([20, 30])).toEqual([20, 30]);
  });
});

describe("case-study review fixes", () => {
  it("counts a spent line without a reported charge as worst case and says so", () => {
    const base = inputs();
    const n = computeCase(
      {
        ...base,
        ledger: {
          ...base.ledger,
          lines: base.ledger.lines.map((l) =>
            l.key === "s1"
              ? (({ chargeUsd: _drop, ...rest }) => ({
                  ...rest,
                  chargeSource: "worst_case" as const,
                }))(l)
              : l,
          ),
        },
      },
      0,
    );
    const total = n.spend.total.value;
    expect(total !== NOT_RECORDED && total.jobsWorstCase).toBe(1);
    const card = numberCards(n, { title: "", brief: "", briefSource: "" }).find(
      (c) => c.label === "total generation spend",
    );
    expect(card?.note).toMatch(/1 at their reserved worst case/);
  });

  it("never shows a negative saving as a headline card", () => {
    const base = inputs();
    const n = computeCase(
      {
        ...base,
        ledger: {
          ...base.ledger,
          lines: base.ledger.lines.map((l) => (l.key === "f1" ? { ...l, chargeUsd: 300 } : l)),
        },
      },
      0,
    );
    const wd = n.spend.withoutDrafts.value;
    expect(wd !== NOT_RECORDED && wd.savedUsd < 0).toBe(true);
    for (const relativeOnly of [false, true])
      expect(
        numberCards(n, { title: "", brief: "", briefSource: "", relativeOnly }).some((c) =>
          /saved by drafting|full quality/.test(c.label),
        ),
      ).toBe(false);
  });

  it("keeps a draft's finish made after the range end in the actual cost", () => {
    const base = inputs();
    const jobs = base.jobs.records.map((j) => (j.id === "f1" ? { ...j, createdAt: 9e12 } : j));
    const n = computeCase(
      { ...base, jobs: { ...base.jobs, records: jobs }, range: { to: 1e12 } },
      0,
    );
    const wd = n.spend.withoutDrafts.value;
    expect(wd !== NOT_RECORDED && wd.actualUsd).toBe(4.5);
  });

  it("does not stack the wall clock with spread (huge logs) and counts skipped turns in range", () => {
    const turns = Array.from({ length: 200_000 }, (_, i) => ({
      turnId: `t${i}`,
      startedAt: i * 10,
      endedAt: i * 10 + 5,
    }));
    const base = inputs();
    const n = computeCase(
      {
        ...base,
        threads: {
          file: "db",
          threads: [{ threadId: "big", turns, userMessages: [], approvals: [] }],
        },
      },
      0,
    );
    const w = n.time.wallClock.value;
    expect(w !== NOT_RECORDED && w.ms).toBe(1_999_995);
    const ranged = computeCase({ ...inputs(), range: { from: 0, to: 4_000_000 } }, 0);
    expect(ranged.time.openTurnsSkipped).toBe(0);
    expect(computeCase(inputs(), 0).time.openTurnsSkipped).toBe(1);
  });
});

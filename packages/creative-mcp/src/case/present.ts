// What the case study says: headline number cards, redaction, CASE.md. Pure (no IO), so the
// confidentiality rules and the "not recorded" wording are unit tested.

import * as NodeOS from "node:os";
import {
  fmtDuration,
  fmtUsd,
  NOT_RECORDED,
  type CaseNumbers,
  type DeliverableRecord,
  type GoalIteration,
  type KeyMoment,
} from "./metrics.ts";

export interface PresentOptions {
  title: string;
  brief: string;
  briefSource: string;
  confidential?: boolean | undefined;
  /** only relative numbers (ratios, percentages), no absolute $ or hours */
  relativeOnly?: boolean | undefined;
  /** names to redact in confidential mode (client, brand, product) */
  clientNames?: string[] | undefined;
  spec?: boolean | undefined;
}

export interface NumberCard {
  big: string;
  label: string;
  note: string;
  /** false = the underlying data is missing (card says "not recorded") */
  recorded: boolean;
}

export const SPEC_LINE = "Spec campaign. Not affiliated with or endorsed by the brand shown.";
export const END_LINE = "one person. one project.";

/**
 * Replace client names (any case) with "Client". A name of 3+ characters also takes the letters
 * that follow it (minus a final vowel), so inflected forms go too (Polish "Orlenu", "Żabką"); erring
 * towards over-redaction is the safe side in confidential mode. Text and names are compared in
 * NFC, since macOS file names often carry decomposed Polish letters.
 */
export function redact(text: string, opts: Pick<PresentOptions, "confidential" | "clientNames">) {
  if (!opts.confidential) return text;
  let out = text.normalize("NFC");
  const names = (opts.clientNames ?? [])
    .map((n) => n.trim().normalize("NFC"))
    .filter((n) => n.length > 1);
  for (const n of names.sort((a, b) => b.length - a.length)) {
    // a final vowel is the inflected part (Żabka → Żabki, Żabką); stem alternations (Żabce) are not caught
    const stem = n.length >= 4 && /[aeiouyąęó]$/i.test(n) ? n.slice(0, -1) : n;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tail = n.length >= 3 ? "\\p{L}*" : "";
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${esc}${tail}(?![\\p{L}\\p{N}])`, "giu"),
      "Client",
    );
  }
  return out;
}

/** Deep-redact every string in a JSON value (numbers.json in confidential mode). */
export function redactDeep<T>(
  value: T,
  opts: PresentOptions,
  project: string,
  home = NodeOS.homedir(),
): T {
  const names = [...(opts.clientNames ?? []), project, project.split("/").pop() ?? ""].filter(
    Boolean,
  );
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let s = v.split(project).join("<project>");
      // log paths under the user's home name the account, not the work
      if (home.length > 1) s = s.split(`${home}/`).join("~/");
      s = redact(s, { confidential: true, clientNames: names });
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return opts.confidential ? (walk(value) as T) : value;
}

const nr = (label: string, note: string): NumberCard => ({
  big: NOT_RECORDED,
  label,
  note,
  recorded: false,
});

/** Goals with at least one review in scope. */
const reviewedGoals = (n: CaseNumbers): GoalIteration[] =>
  n.iterations.goals.value === NOT_RECORDED
    ? []
    : n.iterations.goals.value.filter((g) => g.first !== undefined && g.last !== undefined);

/**
 * The goal shown on the score card: most reviews, then the earliest start (deterministic, not
 * the biggest rise, so the card does not cherry-pick). The card says "1 of N goals" when N > 1.
 */
export function storyGoal(n: CaseNumbers): GoalIteration | undefined {
  return [...reviewedGoals(n)].sort(
    (a, b) =>
      b.reviews - a.reviews || a.startedAt - b.startedAt || a.threadId.localeCompare(b.threadId),
  )[0];
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)} %`;

export function numberCards(n: CaseNumbers, opts: PresentOptions): NumberCard[] {
  const cards: NumberCard[] = [];
  const rel = !!opts.relativeOnly;
  const t = n.time;
  const skipped = t.openTurnsSkipped
    ? `; ${t.openTurnsSkipped} turn(s) without a recorded end not counted`
    : "";

  // Time
  if (t.activeAgent.value !== NOT_RECORDED && t.wallClock.value !== NOT_RECORDED) {
    const a = t.activeAgent.value;
    const w = t.wallClock.value;
    cards.push(
      rel
        ? {
            big: w.ms > 0 ? pct(a.unionMs, w.ms) : "0 %",
            label: "of the calendar span had an agent working",
            note: `agents' busy time (overlap counted once) ÷ first-to-last activity; ${a.turns} turns${skipped}`,
            recorded: true,
          }
        : {
            big: fmtDuration(a.ms),
            label: "agent working time",
            note: `sum of ${a.turns} turn durations (server log, parallel turns add up, approval waits inside turns included), over ${fmtDuration(w.ms)} from first to last activity${skipped}`,
            recorded: true,
          },
    );
  } else cards.push(nr("agent working time", "turn timestamps not recorded"));

  if (t.maxConcurrency.value !== NOT_RECORDED && t.threads.value !== NOT_RECORDED)
    cards.push({
      big: `${t.maxConcurrency.value.threads}×`,
      label: "threads running in parallel (peak)",
      note: `${t.threads.value.count} threads in the project (subagents not counted); peak from overlapping turn times`,
      recorded: true,
    });
  else cards.push(nr("threads in parallel", "turn timestamps not recorded"));

  // Spend
  const s = n.spend;
  if (
    s.withoutDrafts.value !== NOT_RECORDED &&
    s.withoutDrafts.value.counterfactualUsd > 0 &&
    s.withoutDrafts.value.savedUsd > 0
  ) {
    // only a real saving is a headline; a negative one stays in CASE.md and numbers.json
    const w = s.withoutDrafts.value;
    const wc = w.worstCaseJobs
      ? `; ${w.worstCaseJobs} job(s) at their reserved worst case (no reported charge)`
      : "";
    cards.push(
      rel
        ? {
            big: `−${pct(w.savedUsd, w.counterfactualUsd)}`,
            label: "generation cost vs rendering every take at full quality",
            note: `drafts + finishes (ledger) vs each draft take at 1080p list price on the same route${wc}`,
            recorded: true,
          }
        : {
            big: fmtUsd(w.savedUsd),
            label: "saved by drafting first",
            note: `${fmtUsd(w.actualUsd)} counted for drafts + finishes vs ${fmtUsd(w.counterfactualUsd)} at 1080p list price for every draft take${wc}`,
            recorded: true,
          },
    );
  }
  if (!rel) {
    if (s.total.value !== NOT_RECORDED) {
      const v = s.total.value;
      cards.push({
        big: fmtUsd(v.usd),
        label: "total generation spend",
        note: `${v.jobsCounted} job(s) in the spend ledger${v.jobsWorstCase ? `, ${v.jobsWorstCase} at their reserved worst case (no reported charge, an upper bound)` : ""}${v.jobsNotRecorded ? `; ${v.jobsNotRecorded} job(s) not recorded, not added` : ""}`,
        recorded: true,
      });
    } else cards.push(nr("generation spend", "no generation jobs logged for this project"));
  }

  // Quality
  const g = storyGoal(n);
  const goalCount = reviewedGoals(n).length;
  if (g)
    cards.push({
      big: `${g.first}/10 → ${g.last}/10`,
      label: "independent review score, first → last",
      note: `${g.reviews} reviews against a ${g.target}/10 bar; goal ${g.status}${goalCount > 1 ? ` (the most-reviewed of ${goalCount} goals)` : ""}`,
      recorded: true,
    });
  else cards.push(nr("review score", "no quality-goal reviews recorded"));

  const tk = n.iterations.takes.value;
  if (tk !== NOT_RECORDED)
    cards.push({
      big: String(tk.total),
      label: "takes iterated",
      note: `${tk.perDeliverable.length} deliverable(s) in the take ledger${n.iterations.reviews.value !== NOT_RECORDED ? `, ${n.iterations.reviews.value} reviews` : ""}`,
      recorded: true,
    });

  // Human
  const h = n.human.userMessages.value;
  if (h !== NOT_RECORDED)
    cards.push({
      big: String(h),
      label: "messages from the human",
      note: "user messages in the project's threads (server log)",
      recorded: true,
    });

  // Agency comparison (user's estimate only)
  if (n.agencyEstimate) {
    const est = n.agencyEstimate.hours * 3_600_000;
    const active = t.activeAgent.value !== NOT_RECORDED ? t.activeAgent.value.unionMs : undefined;
    if (rel) {
      if (active !== undefined)
        cards.push({
          big: pct(active, est),
          label: "agent busy time vs the user's estimate for an agency",
          note: "agents' busy time (server log) ÷ the user's own estimate of agency hours (not a measurement)",
          recorded: true,
        });
    } else
      cards.push({
        big: `${n.agencyEstimate.hours} h`,
        label: "agency time (user's estimate)",
        note:
          active !== undefined
            ? `the user's own estimate for a traditional team (not a measurement); this project's agents were busy ${fmtDuration(active)}`
            : "the user's own estimate for a traditional team (not a measurement)",
        recorded: true,
      });
  }
  return cards.map((c) => ({
    ...c,
    label: redact(c.label, opts),
    note: redact(c.note, opts),
  }));
}

/** Moments for the video: score changes first, then picks, approvals, presentations; max `limit`. */
export function storyMoments(moments: KeyMoment[], limit = 4): KeyMoment[] {
  const rank: Record<KeyMoment["kind"], number> = {
    score_change: 0,
    take_picked: 1,
    deliverable_presented: 2,
    approval_accepted: 3,
  };
  const picked = [...moments]
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at)
    .slice(0, limit);
  return picked.sort((a, b) => a.at - b.at);
}

export function momentText(m: KeyMoment): { big: string; label: string } {
  const d = m.data ?? {};
  if (m.kind === "score_change" && typeof d.from === "number" && typeof d.to === "number")
    return { big: `${d.from}/10 → ${d.to}/10`, label: m.label || "review score" };
  if (m.kind === "score_change" && typeof d.to === "number")
    return { big: `${d.to}/10`, label: m.label || "first review score" };
  if (m.kind === "take_picked")
    return {
      big: /^t\d+$/.test(String(d.take ?? "")) ? `take ${String(d.take).slice(1)}` : "take picked",
      label: m.label || "take picked",
    };
  if (m.kind === "approval_accepted")
    return { big: "approved", label: m.label || "approval accepted" };
  return { big: "presented", label: m.label || "deliverable presented" };
}

const fmtDims = (d: DeliverableRecord) =>
  [
    d.format.toUpperCase(),
    d.width && d.height ? `${d.width}×${d.height}` : undefined,
    d.durationSeconds ? `${d.durationSeconds} s` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function caseMarkdown(
  n: CaseNumbers,
  opts: PresentOptions,
  extra: { beforeAfter?: string; files: string[] },
): string {
  const r = (s: string) => redact(s, opts);
  const cards = numberCards(n, opts);
  const lines: string[] = [];
  lines.push(`# ${r(opts.title)}`, "");
  if (opts.spec) lines.push(`> ${SPEC_LINE}`, "");
  if (opts.confidential)
    lines.push(
      "> Confidential version: client names redacted" +
        (opts.relativeOnly ? ", relative numbers only." : "."),
      "",
    );
  lines.push(
    "## Brief",
    "",
    r(opts.brief) || "_not recorded_",
    "",
    `<sub>${opts.relativeOnly ? opts.briefSource.replace(/ ?\(\d{4}-\d{2}-\d{2}, /, " (") : opts.briefSource}</sub>`,
    "",
  );

  lines.push("## Process", "");
  const t = n.time;
  if (t.threads.value !== NOT_RECORDED) {
    lines.push(`- ${t.threads.value.count} thread(s):`);
    for (const title of t.threads.value.titles.slice(0, 12)) lines.push(`  - ${r(title)}`);
  } else lines.push(`- Threads: not recorded (${t.threads.sources[0]?.note ?? ""})`);
  if (t.openTurnsSkipped)
    lines.push(
      `- ${t.openTurnsSkipped} turn(s) without a recorded end (running or interrupted) are not counted in the time numbers.`,
    );
  const gs = n.iterations.goals.value;
  if (gs !== NOT_RECORDED)
    for (const g of gs)
      lines.push(
        `- Quality goal "${r(g.objective).slice(0, 160)}": ${g.reviews} review(s)${g.first !== undefined ? `, ${g.first} → ${g.last} (best ${g.best}) against ${g.target}/10` : ""}, ${g.status}`,
      );
  const moments = n.moments;
  if (moments.length) {
    lines.push("", "Key moments:");
    for (const m of moments.slice(0, 20)) {
      const mt = momentText(m);
      lines.push(`- ${opts.relativeOnly ? "" : `${iso(m.at)}: `}${r(mt.label)}: ${mt.big}`);
    }
  }
  lines.push("");

  lines.push("## Numbers", "");
  lines.push("| | Number | How it was measured |", "| --- | --- | --- |");
  for (const c of cards) lines.push(`| ${c.label} | **${c.big}** | ${c.note} |`);
  lines.push("");
  if (!opts.relativeOnly) {
    const s = n.spend;
    if (s.byRoute.length) {
      lines.push(
        "Spend by route:",
        "",
        "| Route | Jobs | USD | Not recorded |",
        "| --- | --- | --- | --- |",
      );
      for (const b of s.byRoute)
        lines.push(`| ${b.key} | ${b.jobs} | ${fmtUsd(b.usd)} | ${b.notRecorded} |`);
      lines.push("", "Drafts vs finishes:", "", "| Role | Jobs | USD |", "| --- | --- | --- |");
      for (const b of s.byRole) lines.push(`| ${b.key} | ${b.jobs} | ${fmtUsd(b.usd)} |`);
      lines.push("");
    }
    const wd = s.withoutDrafts;
    lines.push(
      `Without drafts: ${wd.value === NOT_RECORDED ? `not recorded (${wd.sources[0]?.note ?? ""})` : `${fmtUsd(wd.value.counterfactualUsd)} at full quality vs ${fmtUsd(wd.value.actualUsd)} counted (${wd.value.savedUsd >= 0 ? `saved ${fmtUsd(wd.value.savedUsd)}` : `drafting cost ${fmtUsd(-wd.value.savedUsd)} more`})`}.`,
    );
    const cr = s.cheapestRoute;
    lines.push(
      `Cheapest route: ${cr.value === NOT_RECORDED ? `not recorded (${cr.sources[0]?.note ?? ""})` : `${fmtUsd(cr.value.servedUsd)} on the served routes vs ${fmtUsd(cr.value.defaultUsd)} on the requested ones (saved ${fmtUsd(cr.value.savedUsd)}, list prices)`}.`,
      "",
    );
    const h = n.human;
    lines.push(
      `Human time: ${h.userMessages.value === NOT_RECORDED ? "user messages not recorded" : `${h.userMessages.value} user message(s)`}; approval wait ${h.approvalWait.value === NOT_RECORDED ? "not recorded" : `${fmtDuration(h.approvalWait.value.ms)} over ${h.approvalWait.value.approvals} approval(s)`}.`,
      "",
    );
  }
  if (n.agencyEstimate)
    lines.push(
      `Agency time is the **user's estimate** (${n.agencyEstimate.hours} h), not a measurement.`,
      "",
    );

  lines.push("## Before / after", "");
  lines.push(
    extra.beforeAfter
      ? `![before / after](${extra.beforeAfter})`
      : "_not recorded (needs a first and a picked take)_",
    "",
  );

  lines.push("## Deliverables", "");
  const ds = n.deliverables.value;
  if (ds === NOT_RECORDED) lines.push("_not recorded (no files in delivery/)_");
  else for (const d of ds) lines.push(`- \`${r(d.file)}\`: ${fmtDims(d)}`);
  lines.push("");

  lines.push("## Files", "");
  for (const f of extra.files) lines.push(`- ${f}`);
  lines.push("");
  lines.push("## Method", "");
  lines.push(
    'Every number comes from Open Herness\'s local logs (server thread log, spend ledger, media jobs, take ledger, quality goals); `numbers.json` lists the source file and entry ids of each. Missing data is shown as "not recorded", never estimated.',
  );
  if (n.spend.withoutDrafts.method)
    lines.push("", `- Without drafts: ${n.spend.withoutDrafts.method}`);
  if (n.spend.cheapestRoute.method) lines.push(`- Cheapest route: ${n.spend.cheapestRoute.method}`);
  if (n.time.activeAgent.method) lines.push(`- Agent time: ${n.time.activeAgent.method}`);
  if (opts.relativeOnly)
    lines.push(
      "",
      "_Relative-only version: no $, durations or dates. Counts (takes, messages, threads) and /10 scores stay. The audit copy with absolute values is `.open-herness/case-study/numbers.json`, outside `delivery/`; do not share it._",
    );
  lines.push(
    "",
    `_Generated ${opts.relativeOnly ? "" : `${iso(n.generatedAt)} `}by Open Herness case_study_build._`,
    "",
  );
  return lines.join("\n");
}

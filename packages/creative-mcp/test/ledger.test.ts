import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  current,
  readLines,
  reserveAll,
  settle,
  spentInChat,
  spentInChatTotal,
  spentToday,
  unapprovedInChat,
  type ReserveItem,
} from "../src/media/ledger.ts";
import { isolate } from "./isolate.ts";

const env = isolate();
const item = (key: string, usd: number | null, max = usd): ReserveItem => ({
  key,
  provider: "fal",
  estimateUsd: usd,
  maxUsd: max,
});

describe("ledger v2", () => {
  it("reserves the worst case, settles to the provider charge, releases free failures", () => {
    expect(reserveAll([item("a", 1, 1.5), item("b", 2, 2)], "chat-1", {})).toBeUndefined();
    expect(spentToday()).toBe(3.5);
    settle("a", "spent", { usd: 0.9, source: "provider" });
    settle("b", "released");
    expect(spentToday()).toBe(0.9);
    expect(current().get("a")).toMatchObject({
      state: "spent",
      chargeUsd: 0.9,
      chargeSource: "provider",
    });
    expect(current().get("b")).toMatchObject({ state: "released", chargeUsd: 0 });
    // append-only: history kept
    expect(readLines()).toHaveLength(4);
  });

  it("without a reported charge the worst case stays counted", () => {
    reserveAll([item("a", 1, 1.25)], "c", {});
    settle("a", "spent");
    expect(spentToday()).toBe(1.25);
    expect(current().get("a")?.chargeSource).toBe("worst_case");
  });

  it("a reported $0 charge frees the room", () => {
    reserveAll([item("a", 2)], "c", {});
    settle("a", "spent", { usd: 0, source: "provider" });
    expect(spentToday()).toBe(0);
  });

  it("batches are all-or-nothing and report how many takes fit", () => {
    reserveAll([item("x", 6)], "c", {});
    const refusal = reserveAll([item("a", 2), item("b", 2), item("c3", 2)], "c", { daily: 10 });
    expect(refusal).toMatchObject({ cap: "daily", capUsd: 10, spentUsd: 6, neededUsd: 6, fits: 2 });
    expect(current().has("a")).toBe(false);
  });

  it("re-reserving the same key reserves nothing new", () => {
    reserveAll([item("a", 4)], "c", { daily: 5 });
    expect(reserveAll([item("a", 4)], "c", { daily: 5 })).toBeUndefined();
    expect(spentToday()).toBe(4);
  });

  it("a slot's reservation is handed over to its job", () => {
    reserveAll([item("slot-1", 4)], "c", { daily: 5 });
    expect(
      reserveAll([item("job-1", 4)], "c", { daily: 5 }, { fromKeys: ["slot-1"] }),
    ).toBeUndefined();
    expect(current().get("slot-1")?.state).toBe("released");
    expect(spentToday()).toBe(4);
  });

  it("M5: under a cap an unknown price is refused, even with allow_unpriced (never $0)", () => {
    expect(reserveAll([item("a", null)], "c", { daily: 5 })).toMatchObject({
      neededUsd: null,
      fits: 0,
    });
    expect(reserveAll([item("a", null)], "c", { daily: 5 }, { allowUnpriced: true })).toMatchObject(
      { neededUsd: null },
    );
    // without a cap it is reserved and counted as unknown, not $0
    expect(reserveAll([item("u", null)], "c", {})).toBeUndefined();
    expect(spentInChatTotal("c")).toEqual({ usd: 0, unknown: true });
    // new spend under a cap after spend of unknown size has no known room
    expect(reserveAll([item("b", 1)], "c", { chat: { usd: 50, since: 0 } })).toMatchObject({
      cap: "chat",
    });
  });

  it("a $0 chat cap refuses any paid generation; spend counts per chat since the cap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    reserveAll([item("old", 3)], "c", {});
    vi.setSystemTime(2_000_000);
    const since = 1_500_000;
    expect(reserveAll([item("a", 0.04)], "c", { chat: { usd: 0, since } })).toMatchObject({
      cap: "chat",
      fits: 0,
    });
    expect(reserveAll([item("a", 4)], "c", { chat: { usd: 5, since } })).toBeUndefined();
    expect(spentInChat("c", since)).toBe(4);
    expect(spentInChat("other", since)).toBe(0);
  });

  it("two processes racing for the last room: only one batch gets in", async () => {
    const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    const script = NodePath.join(env.home, "race.ts");
    NodeFS.writeFileSync(
      script,
      `import { reserveAll } from ${JSON.stringify(NodePath.join(here, "../src/media/ledger.ts"))};
const r = reserveAll([{ key: process.argv[2], estimateUsd: 3, maxUsd: 3 }], "c", { daily: 5 });
console.log(r ? "refused" : "ok");`,
    );
    const run = (key: string) =>
      new Promise<string>((resolve) =>
        NodeChildProcess.execFile(
          process.execPath,
          [script, key],
          { env: { ...process.env } },
          (_e, out) => resolve(out.trim()),
        ),
      );
    const results = await Promise.all([run("p1"), run("p2"), run("p3")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(spentToday()).toBe(3);
  });
});

describe("unapproved spend (ask-before counting)", () => {
  it("counts only lines no approval paid for", () => {
    reserveAll([item("a", 2), { ...item("b", 3), approvalId: "ap-1" }], "c", {});
    expect(unapprovedInChat("c")).toEqual({ usd: 2, unknown: false });
  });
});

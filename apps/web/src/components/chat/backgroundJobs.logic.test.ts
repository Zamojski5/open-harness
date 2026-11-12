import { describe, expect, it } from "vite-plus/test";

import { advanceJobHistory, formatJobElapsed, lastOutputLine } from "./backgroundJobs.logic";

describe("lastOutputLine", () => {
  it("returns the last line, dropping one trailing empty line, without trimming", () => {
    expect(lastOutputLine("a\nb  \n")).toBe("b  ");
    expect(lastOutputLine("a\r\nprogress 50%\rprogress 90%")).toBe("progress 90%");
  });
  it("strips ANSI and control characters", () => {
    expect(lastOutputLine("\u001b[32mok\u001b[0m done\u0007\n")).toBe("ok done");
  });
  it("returns null for binary output, blank last lines or nothing", () => {
    expect(lastOutputLine("a\u0000b")).toBeNull();
    expect(lastOutputLine("a\n\n\n")).toBeNull();
    expect(lastOutputLine("")).toBeNull();
  });
  it("drops the partial first line when only the tail is read", () => {
    const long = `${"x".repeat(5000)}\nlast`;
    expect(lastOutputLine(long)).toBe("last");
  });
});

describe("formatJobElapsed", () => {
  it("uses s, m ss and h mm forms", () => {
    expect(formatJobElapsed(5_400)).toBe("5s");
    expect(formatJobElapsed(65_000)).toBe("1m 05s");
    expect(formatJobElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("advanceJobHistory", () => {
  const job = (taskId: string) => ({ taskId, label: taskId, kind: "command", startedAtMs: 0 });
  it("moves ended jobs into finished, newest first", () => {
    const first = advanceJobHistory([job("a"), job("b")], [job("b")], [], 10);
    expect(first.finished.map((entry) => entry.taskId)).toEqual(["a"]);
    const second = advanceJobHistory([job("b")], [], first.finished, 20);
    expect(second.finished.map((entry) => [entry.taskId, entry.finishedAtMs])).toEqual([
      ["b", 20],
      ["a", 10],
    ]);
  });
  it("keeps the same history when nothing ended", () => {
    const finished = [{ ...job("z"), finishedAtMs: 1 }];
    expect(advanceJobHistory([job("a")], [job("a")], finished, 5).finished).toBe(finished);
  });
});

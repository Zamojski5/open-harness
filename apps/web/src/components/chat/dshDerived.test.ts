import { describe, expect, it } from "vite-plus/test";

import {
  firstErrorLine,
  headTailCap,
  headTailText,
  latestCompletedParagraphFirstLine,
  reasoningPreviewLine,
  terminalExitLabel,
} from "./dshDerived";

describe("headTailCap", () => {
  it("does not cap at or under the limit", () => {
    expect(headTailCap(16, 16, false).capped).toBe(false);
    expect(headTailCap(3, 16, false).capped).toBe(false);
  });
  it("caps one line over and splits head/tail", () => {
    expect(headTailCap(17, 16, false)).toEqual({
      hidden: 1,
      capped: true,
      headLines: 8,
      tailLines: 8,
    });
    expect(headTailCap(20, 9, false)).toMatchObject({ headLines: 5, tailLines: 4, hidden: 11 });
  });
  it("uncaps when expanded", () => {
    expect(headTailCap(100, 16, true).capped).toBe(false);
  });
});

describe("headTailText", () => {
  it("ignores a trailing newline when counting", () => {
    expect(headTailText("a\nb\n", 2, false)).toEqual({
      head: "a\nb",
      hidden: 0,
      tail: "",
      omitted: 0,
    });
  });
  it("returns head, hidden count and tail", () => {
    const text = ["1", "2", "3", "4", "5", "6"].join("\n");
    expect(headTailText(text, 4, false)).toEqual({
      head: "1\n2",
      hidden: 2,
      tail: "5\n6",
      omitted: 0,
    });
  });
});

describe("reasoning preview", () => {
  it("stays on the previous paragraph while the newest first line is incomplete", () => {
    const base = "First idea.\nmore\n\nSecond";
    expect(latestCompletedParagraphFirstLine(base)).toBe("First idea.");
    expect(latestCompletedParagraphFirstLine(`${base} line grows`)).toBe("First idea.");
    expect(latestCompletedParagraphFirstLine(`${base} line done\n`)).toBe("Second line done");
  });
  it("strips markdown from the settled first line", () => {
    expect(reasoningPreviewLine("**Planning the render**\n\nbody", false)).toBe(
      "Planning the render",
    );
    expect(reasoningPreviewLine("## Check `foo` [link](x)\n", false)).toBe("Check foo link");
  });
  it("returns an empty preview before any line completes", () => {
    expect(reasoningPreviewLine("partial", true)).toBe("");
  });
});

describe("terminalExitLabel", () => {
  it("labels only non-zero codes", () => {
    expect(terminalExitLabel(0)).toBeNull();
    expect(terminalExitLabel(undefined)).toBeNull();
    expect(terminalExitLabel(2)).toBe("exit 2");
  });
});

describe("firstErrorLine", () => {
  it("prefers a line with an error marker", () => {
    expect(firstErrorLine("building\nError: boom\nmore")).toBe("Error: boom");
  });
  it("falls back to the last non-empty line", () => {
    expect(firstErrorLine("start\nend here\n\n")).toBe("end here");
    expect(firstErrorLine("")).toBeNull();
  });
});

describe("headTailText expanded ceiling (review L8)", () => {
  it("stops an expanded block at the limit and clips very long lines", () => {
    const text = Array.from({ length: 30 }, (_, index) => `l${index}`).join("\n");
    const result = headTailText(text, 16, true, 10);
    expect(result.omitted).toBe(20);
    expect(result.head.split("\n")).toHaveLength(10);
    const long = headTailText("x".repeat(5_000), 16, true);
    expect(long.head.length).toBeLessThan(2_100);
    expect(long.head).toContain("line clipped");
  });
});

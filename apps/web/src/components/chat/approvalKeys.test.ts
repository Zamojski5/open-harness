import { describe, expect, it } from "vite-plus/test";

import { approvalDecisionForKey, isRectInViewport, type ApprovalKeyEvent } from "./approvalKeys";

const key = (overrides: Partial<ApprovalKeyEvent>): ApprovalKeyEvent => ({
  key: "Enter",
  repeat: false,
  isComposing: false,
  keyCode: 13,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  focusInCard: true,
  msSinceCompositionEnd: Number.POSITIVE_INFINITY,
  ...overrides,
});

describe("approvalDecisionForKey", () => {
  it("maps Enter to accept and Escape to decline", () => {
    expect(approvalDecisionForKey(key({}))).toBe("accept");
    expect(approvalDecisionForKey(key({ key: "Escape", keyCode: 27 }))).toBe("decline");
    expect(approvalDecisionForKey(key({ key: "a" }))).toBeNull();
  });
  it("ignores repeat, IME composition and modifiers", () => {
    expect(approvalDecisionForKey(key({ repeat: true }))).toBeNull();
    expect(approvalDecisionForKey(key({ isComposing: true }))).toBeNull();
    expect(approvalDecisionForKey(key({ keyCode: 229 }))).toBeNull();
    expect(approvalDecisionForKey(key({ metaKey: true }))).toBeNull();
    expect(approvalDecisionForKey(key({ shiftKey: true }))).toBeNull();
  });
});

describe("review fixes (L1, L2)", () => {
  it("answers only with focus in the card and an untaken key", () => {
    expect(approvalDecisionForKey(key({ focusInCard: false }))).toBeNull();
    expect(approvalDecisionForKey(key({ defaultPrevented: true }))).toBeNull();
  });
  it("ignores Safari's IME Enter right after compositionend", () => {
    expect(approvalDecisionForKey(key({ msSinceCompositionEnd: 10 }))).toBeNull();
    expect(approvalDecisionForKey(key({ msSinceCompositionEnd: 500 }))).toBe("accept");
  });
  it("keeps Enter for a focused button but still declines on Escape", () => {
    // Stand-ins for DOM elements: `closest` answers like a <button> and an <input>.
    const button = {
      closest: (selector: string) => (selector.includes("button") ? {} : null),
    } as unknown as EventTarget;
    expect(approvalDecisionForKey(key({ target: button }))).toBeNull();
    expect(approvalDecisionForKey(key({ key: "Escape", keyCode: 27, target: button }))).toBe(
      "decline",
    );
    const input = {
      closest: (selector: string) => (selector.includes("input") ? {} : null),
    } as unknown as EventTarget;
    expect(approvalDecisionForKey(key({ key: "Escape", keyCode: 27, target: input }))).toBeNull();
  });
  it("takes focus only when the row is on screen", () => {
    expect(isRectInViewport({ top: 10, bottom: 80 }, 800)).toBe(true);
    expect(isRectInViewport({ top: 790, bottom: 860 }, 800)).toBe(false);
    expect(isRectInViewport({ top: -40, bottom: 20 }, 800)).toBe(false);
  });
});

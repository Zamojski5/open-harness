/*
 * Keyboard rules adapted from DeepSeek Harness ApprovalCard
 * (packages/client/ui-approval/src/client/ApprovalCard.tsx), MIT License,
 * Copyright (c) 2026 DeepSeek. See the "DeepSeek Harness" entry in third-party-licenses.config.json.
 */
import type { ProviderApprovalDecision } from "@t3tools/contracts";

export interface ApprovalKeyEvent {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly defaultPrevented: boolean;
  readonly target: EventTarget | null;
  /** Whether the focused element is inside the approval card. */
  readonly focusInCard: boolean;
  /** Milliseconds since the last compositionend in the card (Safari sends Enter right after). */
  readonly msSinceCompositionEnd: number;
}

/** Safari fires the IME-confirming Enter just after compositionend, with isComposing false. */
const COMPOSITION_ENTER_GRACE_MS = 50;

function closestInteractive(target: EventTarget | null, selector: string): boolean {
  const closest = (target as { closest?: unknown } | null)?.closest;
  if (typeof closest !== "function") return false;
  return closest.call(target, selector) !== null;
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const CONTROLS = "button, a[href]";

/**
 * Enter allows and Escape rejects while focus is inside the approval card. Text fields keep both
 * keys; buttons and links keep Enter (Escape still rejects, as in DSH). Modifiers, key repeat,
 * IME composition (including Safari's Enter right after compositionend) and keys another handler
 * already took are ignored.
 */
export function approvalDecisionForKey(event: ApprovalKeyEvent): ProviderApprovalDecision | null {
  if (!event.focusInCard || event.defaultPrevented) return null;
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (closestInteractive(event.target, TEXT_ENTRY)) return null;
  if (event.key === "Enter") {
    if (event.msSinceCompositionEnd < COMPOSITION_ENTER_GRACE_MS) return null;
    if (closestInteractive(event.target, CONTROLS)) return null;
    return "accept";
  }
  if (event.key === "Escape") return "decline";
  return null;
}

/** Take focus for keyboard answers only when the card is on screen. */
export function isRectInViewport(
  rect: { readonly top: number; readonly bottom: number },
  viewportHeight: number,
): boolean {
  return rect.top >= 0 && rect.bottom <= viewportHeight;
}

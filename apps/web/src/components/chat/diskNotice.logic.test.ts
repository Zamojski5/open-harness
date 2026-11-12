import { describe, expect, it } from "vite-plus/test";

import {
  diskNoticeLevel,
  diskNoticeVisible,
  formatFreeBytes,
  nextDismissal,
} from "./diskNotice.logic";

describe("disk notice", () => {
  it("derives the level", () => {
    expect(diskNoticeLevel({ lowDisk: true, cloudSync: "none" })).toBe("low-disk");
    expect(diskNoticeLevel({ lowDisk: false, cloudSync: "icloud" })).toBe("synced");
    expect(diskNoticeLevel({ lowDisk: false, cloudSync: "none" })).toBe("none");
  });
  it("hides by dismissed level; a dismissed low-disk hides all", () => {
    expect(diskNoticeVisible("low-disk", null)).toBe(true);
    expect(diskNoticeVisible("low-disk", "synced")).toBe(true);
    expect(diskNoticeVisible("synced", "synced")).toBe(false);
    expect(diskNoticeVisible("synced", "low-disk")).toBe(false);
    expect(diskNoticeVisible("none", null)).toBe(false);
  });
  it("re-arms the warning once space is back", () => {
    expect(nextDismissal("none", "low-disk")).toBe("synced");
    expect(nextDismissal("low-disk", "low-disk")).toBe("low-disk");
  });
  it("formats free space in decimal units", () => {
    expect(formatFreeBytes(4_321_000_000)).toBe("4.3 GB");
    expect(formatFreeBytes(123_000_000_000)).toBe("123 GB");
    expect(formatFreeBytes(512)).toBe("512 B");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { classifyStorage, isAllowedStoragePath, isICloudPath } from "./storageStatus.ts";

const GIB = 1024 ** 3;
const HOME = "/Users/a";

describe("classifyStorage", () => {
  it("warns a local folder under 5 GiB", () => {
    expect(classifyStorage(4 * GIB, "/Users/a/project", HOME)).toEqual({
      freeBytes: 4 * GIB,
      lowDisk: true,
      cloudSync: "none",
    });
    expect(classifyStorage(6 * GIB, "/Users/a/project", HOME).lowDisk).toBe(false);
  });
  it("warns an iCloud folder under 20 GiB", () => {
    const path = "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/film";
    expect(classifyStorage(10 * GIB, path, HOME)).toMatchObject({
      lowDisk: true,
      cloudSync: "icloud",
    });
  });
  it("is never low when the volume could not be read", () => {
    expect(classifyStorage(null, "/x", HOME)).toEqual({
      freeBytes: null,
      lowDisk: false,
      cloudSync: "none",
    });
  });
});

describe("isICloudPath", () => {
  it("accepts any Mobile Documents container and CloudStorage/iCloud, case-insensitively", () => {
    expect(isICloudPath("/Users/a/Library/Mobile Documents/iCloud~com~app/x", HOME)).toBe(true);
    expect(isICloudPath("/users/a/library/mobile documents/com~apple~CloudDocs", HOME)).toBe(true);
    expect(isICloudPath("/Users/a/Library/CloudStorage/iCloudDrive/x", HOME)).toBe(true);
  });
  it("is anchored to the home Library", () => {
    expect(isICloudPath("/tmp/Library/Mobile Documents/x", HOME)).toBe(false);
    expect(isICloudPath("/Users/a/Library/CloudStorage/Dropbox/x", HOME)).toBe(false);
  });
});

describe("isAllowedStoragePath", () => {
  it("allows home and mounted volumes only", () => {
    expect(isAllowedStoragePath("/Users/a/Dev/p", HOME)).toBe(true);
    expect(isAllowedStoragePath("/Volumes/Work/p", HOME)).toBe(true);
    expect(isAllowedStoragePath("/etc", HOME)).toBe(false);
    expect(isAllowedStoragePath("/Users/ab/p", HOME)).toBe(false);
  });
});

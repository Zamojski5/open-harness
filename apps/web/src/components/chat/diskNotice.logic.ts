/**
 * Low-disk notice: levels, per-project dismissal and the free-space format. Thresholds live on
 * the server (storageStatus.ts).
 */

export type DiskNoticeLevel = "none" | "synced" | "low-disk";

export function diskNoticeLevel(status: {
  readonly lowDisk: boolean;
  readonly cloudSync: "none" | "icloud";
}): DiskNoticeLevel {
  if (status.lowDisk) return "low-disk";
  return status.cloudSync === "icloud" ? "synced" : "none";
}

/**
 * Whether the notice shows, given the level dismissed for this project. A dismissed low-disk
 * notice hides every level; a dismissed "synced" notice still lets a low-disk warning through.
 */
export function diskNoticeVisible(level: DiskNoticeLevel, dismissed: DiskNoticeLevel | null) {
  if (level === "none") return false;
  if (dismissed === "low-disk") return false;
  return dismissed !== level;
}

/**
 * The stored dismissal once space is back: a dismissed low-disk notice is lowered to "synced",
 * so the next time the disk runs low it warns again.
 */
export function nextDismissal(
  level: DiskNoticeLevel,
  dismissed: DiskNoticeLevel | null,
): DiskNoticeLevel | null {
  return level !== "low-disk" && dismissed === "low-disk" ? "synced" : dismissed;
}

/** Decimal (1000-based) units, one decimal place, none from 100 up. */
export function formatFreeBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function diskNoticeStorageKey(environmentId: string, projectId: string): string {
  return `open-herness:disk-notice-dismissed:${environmentId}:${projectId}`;
}

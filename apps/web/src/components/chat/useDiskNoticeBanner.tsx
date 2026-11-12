import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CloudIcon, HardDriveIcon } from "lucide-react";
import { useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  diskNoticeLevel,
  diskNoticeStorageKey,
  diskNoticeVisible,
  formatFreeBytes,
  nextDismissal,
  type DiskNoticeLevel,
} from "./diskNotice.logic";

const DismissedLevel = Schema.NullOr(Schema.Literals(["none", "synced", "low-disk"]));

/**
 * The project's disk notice above the composer: a warning before the disk fills (under 5 GB free,
 * or 20 GB for an iCloud-synced folder), and a note that an iCloud project syncs. Checked every
 * minute; dismissal is remembered per project until space is back.
 */
export function useDiskNoticeBanner(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string | null;
  readonly path: string | null;
}): ComposerBannerStackItem | null {
  const { environmentId, projectId, path } = input;
  const { data } = useEnvironmentQuery(
    environmentId === null || path === null
      ? null
      : serverEnvironment.storageStatus({ environmentId, input: { path } }),
  );
  const storageKey =
    environmentId === null || projectId === null
      ? "open-herness:disk-notice-dismissed:none"
      : diskNoticeStorageKey(environmentId, projectId);
  const [dismissed, setDismissed] = useLocalStorage<DiskNoticeLevel | null, DiskNoticeLevel | null>(
    storageKey,
    null,
    DismissedLevel,
  );
  const level: DiskNoticeLevel = data ? diskNoticeLevel(data) : "none";
  const rearmed = data ? nextDismissal(level, dismissed) : dismissed;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lowers a stored low-disk dismissal once space is back, so the next shortage warns again
  useEffect(() => {
    if (rearmed !== dismissed) setDismissed(rearmed);
  }, [rearmed, dismissed, setDismissed]);
  if (!data || projectId === null || !diskNoticeVisible(level, dismissed)) return null;
  const free = data.freeBytes === null ? null : formatFreeBytes(data.freeBytes);
  const icloud = data.cloudSync === "icloud";
  const onDismiss = () => setDismissed(level);
  if (level === "synced") {
    return {
      id: `disk-notice:${storageKey}`,
      variant: "warning",
      group: "environment",
      icon: <CloudIcon />,
      title: "This project syncs with iCloud",
      description: "iCloud can move its files off this Mac; renders then wait while they download.",
      dismissLabel: "Dismiss iCloud notice",
      onDismiss,
    };
  }
  return {
    id: `disk-notice:${storageKey}`,
    variant: icloud ? "error" : "warning",
    group: "environment",
    icon: <HardDriveIcon />,
    title: free ? `Disk almost full · ${free} free` : "Disk almost full",
    description: icloud
      ? "iCloud may move this project's files off the Mac and renders stall while they download. Free up space or move the project out of iCloud."
      : "When the disk fills, renders and saving this chat stop.",
    dismissLabel: icloud ? "Dismiss iCloud notice" : "Dismiss disk space notice",
    onDismiss,
  };
}

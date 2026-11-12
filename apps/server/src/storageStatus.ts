// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no statfs; free space needs node:fs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerStorageStatus } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const GIB = 1024 ** 3;
/** A local folder warns under 5 GiB, an iCloud-synced one under 20 GiB. */
const DISK_ALMOST_FULL_BYTES = 5 * GIB;
const LOW_DISK_BYTES = 20 * GIB;
/** statfs gets 1.5 s. */
const STATFS_TIMEOUT = Duration.millis(1_500);

const NOT_READ: ServerStorageStatus = { freeBytes: null, lowDisk: false, cloudSync: "none" };

function isInside(child: string, parent: string): boolean {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/** iCloud Drive lives under ~/Library/Mobile Documents (any container) or ~/Library/CloudStorage/iCloud*. */
export function isICloudPath(realPath: string, home: string): boolean {
  const library = NodePath.join(home, "Library").toLowerCase();
  const path = realPath.toLowerCase();
  return (
    isInside(path, NodePath.join(library, "mobile documents")) ||
    /^icloud/.test(NodePath.relative(NodePath.join(library, "cloudstorage"), path))
  );
}

/**
 * Only folders a project can live in are measured: the user's home and mounted volumes. Anything
 * else answers "not read", so the endpoint can't probe arbitrary paths.
 */
export function isAllowedStoragePath(realPath: string, home: string): boolean {
  return isInside(realPath, home) || isInside(realPath, "/Volumes");
}

export function classifyStorage(
  freeBytes: number | null,
  realPath: string,
  home: string,
): ServerStorageStatus {
  const cloudSync = isICloudPath(realPath, home) ? "icloud" : "none";
  const threshold = cloudSync === "icloud" ? LOW_DISK_BYTES : DISK_ALMOST_FULL_BYTES;
  return {
    freeBytes: freeBytes === null ? null : Math.floor(freeBytes),
    lowDisk: freeBytes !== null && freeBytes < threshold,
    cloudSync,
  };
}

class StorageStatusReadError extends Schema.TaggedError<StorageStatusReadError>()(
  "StorageStatusReadError",
  { detail: Schema.String },
) {}

/** Free space on the volume holding `path`. Never fails: an unreadable volume is "not low". */
export const readStorageStatus = (path: string): Effect.Effect<ServerStorageStatus> =>
  Effect.tryPromise({
    try: async () => {
      const home = NodeOS.homedir();
      const realPath = await NodeFSP.realpath(path);
      if (!isAllowedStoragePath(realPath, home)) return NOT_READ;
      const stats = await NodeFSP.statfs(realPath);
      return classifyStorage(stats.bavail * stats.bsize, realPath, home);
    },
    catch: (cause) => new StorageStatusReadError({ detail: String(cause) }),
  }).pipe(
    Effect.timeout(STATFS_TIMEOUT),
    Effect.orElseSucceed(() => NOT_READ),
  );

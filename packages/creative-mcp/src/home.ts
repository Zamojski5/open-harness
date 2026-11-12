// Where Open Herness keeps its per-user state (keys, jobs, ledger, caches).
// OH_HOME moves all of it, so tests and a second app copy never touch the live ~/.open-herness.

import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const ohHome = (...parts: string[]) =>
  NodePath.join(process.env.OH_HOME || NodePath.join(NodeOS.homedir(), ".open-herness"), ...parts);

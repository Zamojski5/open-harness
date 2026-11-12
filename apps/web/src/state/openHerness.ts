import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type OpenHernessComposerContextResult,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

// Open Herness: the project's brand state (composer chip) and the "@" picker's apps.

const openHernessComposerContext = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:open-herness:composer-context",
  tag: WS_METHODS.openHernessComposerContext,
  staleTimeMs: 15_000,
  idleTtlMs: 5 * 60_000,
});

export const openHernessSetBrandContext = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:open-herness:set-brand-context",
  tag: WS_METHODS.openHernessSetBrandContext,
});

export function useOpenHernessComposerContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly threadId: ThreadId | null;
  readonly enabled?: boolean;
}): {
  readonly data: OpenHernessComposerContextResult | null;
  readonly refresh: () => void;
} {
  const query = useEnvironmentQuery(
    input.environmentId === null || input.enabled === false
      ? null
      : openHernessComposerContext({
          environmentId: input.environmentId,
          input: {
            cwd: input.cwd,
            ...(input.threadId === null ? {} : { threadId: input.threadId }),
          },
        }),
  );
  return { data: query.data, refresh: query.refresh };
}

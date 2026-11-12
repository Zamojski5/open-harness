import { OPEN_HERNESS_APP_CONTEXT_KIND } from "@t3tools/shared/openHernessApps";
import { AppWindowIcon } from "lucide-react";

import { ContextChipShell } from "./contextChipParts";

/** Open Herness: the chip an "@" app pick leaves, in the composer and in sent messages. */
export function AppContextChip(props: { label: string; copyMarkdown?: string }) {
  return (
    <ContextChipShell
      kind="skill"
      icon={<AppWindowIcon />}
      label={props.label}
      aria-label={`App, ${props.label}`}
      data-markdown-copy={props.copyMarkdown}
      tooltip={`The agent is asked to do this in ${props.label}, and to say so if it isn't available.`}
    />
  );
}

export const isAppContextKind = (kind: string) => kind === OPEN_HERNESS_APP_CONTEXT_KIND;

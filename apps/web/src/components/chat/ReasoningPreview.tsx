import { reasoningPreviewLine } from "./dshDerived";
import ChatMarkdown from "../ChatMarkdown";
import { THINKING_PREVIEW_PLUGINS, THOUGHT_PREVIEW_PLUGINS } from "./TimelineWorkEntryRow.logic";

/**
 * Collapsed reasoning preview. Works on one line instead of re-parsing the whole reasoning on
 * every chunk; markdown runs only for a line with inline math.
 */
export function ReasoningPreview(props: {
  readonly text: string;
  readonly running: boolean;
  readonly cwd: string | undefined;
}) {
  const line = reasoningPreviewLine(props.text, props.running);
  const fallback = props.running ? "Thinking" : "Thought";
  if (line === "") return fallback;
  if (!line.includes("$")) return line;
  return (
    <ChatMarkdown
      inline
      text={line}
      cwd={props.cwd}
      parseRawHtml={false}
      extraRemarkPlugins={props.running ? THINKING_PREVIEW_PLUGINS : THOUGHT_PREVIEW_PLUGINS}
    />
  );
}

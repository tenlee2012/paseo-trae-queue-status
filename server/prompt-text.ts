export const QUESTION_TOOL_GUIDANCE =
  "For questions that need the user's choice in Paseo, use the paseo_questions MCP server's AskUserQuestion tool. It displays selectable options and returns the answer in every mode, including Default and Full Access. Use this tool instead of the native request_user_input tool, whose non-blocking questions are not delivered over this TRAE ACP connection.";

// Older plugin versions appended this instruction as user text. TRAE also used
// that text for titles, sometimes truncating it in the middle of the instruction.
export function cleanTraePrompt(text: string): string {
  const start = text.indexOf("For questions that need the user's choice in Paseo,");
  if (start < 0) return text.trim();
  const tail = text
    .slice(start)
    .trimEnd()
    .replace(/(?:\.{3}|…)$/, "");
  if (QUESTION_TOOL_GUIDANCE.startsWith(tail)) return text.slice(0, start).trim();
  if (text.trimEnd().endsWith(QUESTION_TOOL_GUIDANCE))
    return text.trimEnd().slice(0, -QUESTION_TOOL_GUIDANCE.length).trim();
  return text.trim();
}

export function isInternalTraeSession(text: string): boolean {
  return /^(?:Generate metadata for a coding agent based on the user prompt\.|Generate a title and git branch name for a coding agent\b)/.test(
    text.trimStart(),
  );
}

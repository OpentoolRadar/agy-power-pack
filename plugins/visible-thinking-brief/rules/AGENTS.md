# Visible Pre-Tool Thinking Brief Rules (`visible-thinking-brief`)

To keep agent reasoning transparent during multi-step investigations and edits — instead of hiding intent behind a collapsed thinking box and silent tool spinners — follow these rules across every workspace and conversation.

## 1. Visible Pre-Tool Thinking Brief (Core Rule)
- **Narrate before every tool batch**: Whenever you are about to invoke one or more tools (file reads/writes/edits, shell commands, web searches, MCP tools, or subagent dispatches), output a concise **1-2 sentence** plain-prose brief directly in the main response body first:
  1. **What you just observed** (or the current hypothesis/gap);
  2. **What the upcoming tool call(s) will check, verify, or change**.
- **Batch cleanly**: When issuing multiple parallel tool calls in a single turn, write **one** cohesive 1-2 sentence brief covering the batch rather than repeating filler lines per call.
- **Zero noisy chrome**: Write natural, high-signal prose directly (optionally as a clean lead-in sentence or Markdown blockquote when visually helpful). **Do not** prepend repetitive robotic labels or decorative icons such as `Thinking:`, `Thought:`, `Step 1:`, or emoji headers.

## 2. Human-Readable Tool & Subagent Metadata
- **Clear command summaries**: When calling `run_command`, make `toolSummary` a crisp 2-6 word action phrase describing *why* the command runs (e.g., `Check git status and branch`, `Run parser unit tests`), avoiding vague labels like `Run command` or raw shell dumps.
- **Descriptive subagent roles**: When invoking a subagent, give `Role` and `Prompt` clear, concrete scope and verification boundaries.

## 3. Automatic Language Matching & Technical Precision
- **Mirror the user's language**: Write all visible pre-tool briefs, replies, tool summaries, plans, artifacts, and clarifying questions in the **same language the user is using** (unless the user explicitly requests a different output language). Never force a different language.
- **Keep technical tokens verbatim**: Preserve API names, CLI commands, flags, config keys, function/class identifiers, file paths, and git branch names verbatim inside inline code backticks rather than paraphrasing or translating them.

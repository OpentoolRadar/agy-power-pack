---
name: codex-subagent
description: >-
  Run isolated code reviews, cross-model second-opinion debugging, or bounded coding subtasks via
  the host-installed OpenAI Codex CLI (codex exec / review / resume), with multi-account CODEX_HOME
  isolation and switching. Activate when the user asks Codex to review, compare designs, manage
  multiple Codex accounts, or collaborate as a subagent.
---

# Codex Subagent Playbook (with Multi-Account Management)

This skill invokes the host's local `codex` CLI (`codex-cli 0.163.0+`, verified on `0.171.0`) through lightweight cross-platform wrapper scripts with zero third-party MCP servers.

## 1. Platform Wrapper Selection

- **Linux / macOS**: Use [run-codex.sh](./scripts/run-codex.sh) (auto-detects `codex` on `PATH` and `~/.local/bin/codex`).
- **Windows**: Run [run-codex.ps1](./scripts/run-codex.ps1) via `pwsh -NoProfile -File`.
- If `codex` is missing or the requested account is not authenticated, **stop immediately and inform the user** — never fabricate output.

## 2. Multi-Account Isolation (`--account` / `-Account`)

Each account gets its own `CODEX_HOME` directory isolating configuration, `auth.json`, and session logs:

- `default` or `1` (default): Uses the standard `~/.codex` directory.
- Any other alias (e.g., `2`, `work`; allowed characters: letters, digits, `.`, `_`, `-`):
  - Reuses `~/.codex-<name>` if that directory already exists;
  - Otherwise uses `~/.codex-accounts/<name>` and ensures `cli_auth_credentials_store = "file"` is set in `config.toml` so credentials never collide in the OS keyring.
- You can also pass `--codex-home <dir>` / `-CodexHome <dir>` directly to override the directory path.

### Account Management Commands

1. **List all configured accounts and login status**:
   - Linux / macOS: `bash "<skill_dir>/scripts/run-codex.sh" --mode accounts`
   - Windows: `pwsh -NoProfile -File "<skill_dir>\scripts\run-codex.ps1" -Mode accounts`
2. **Initialize a new isolated account directory** (creates directory with `cli_auth_credentials_store = "file"` and prints the interactive login command):
   - Linux / macOS: `bash "<skill_dir>/scripts/run-codex.sh" --mode init-account --account 2`
   - Windows: `pwsh -NoProfile -File "<skill_dir>\scripts\run-codex.ps1" -Mode init-account -Account 2`

## 3. Execution Modes & Flag Rules

| Use Case | Recommended Mode | Key Behavior & Constraints |
|---|---|---|
| Code review (uncommitted diff / base branch / commit SHA) | `review` | Runs `codex exec --color never -C <cwd> ... review`. `--uncommitted`, `--base <branch>`, and `--commit <sha>` are **mutually exclusive** with each other and with a custom prompt (wrapper rejects conflicts with `exit 2`). `--image` is not supported in `review` mode. |
| Custom-prompt diff audit / second opinion / bug triage (read-only) | `exec` + `read-only` | Default mode. Passes `--sandbox read-only` so no files are modified. Supports custom prompts, `--image`, and `--output-schema`. |
| Delegating bounded code edits to Codex | `exec` + `workspace-write` | Use only when the user explicitly approves edits. Optionally pair with `--worktree` to isolate changes in a managed Git worktree. |
| Multi-turn follow-up on the same investigation | `exec --keep-session` -> `resume` | Pass `--keep-session` on the initial run, then follow up with `resume --last` or `--session-id <uuid>` (mutually exclusive; use the same `--account`). `resume` passes `--sandbox` and `-C` at the `exec` top level and omits `--ephemeral` to preserve continuity. |
| Inspect or bootstrap accounts | `accounts` / `init-account` | Checks login status across profiles or initializes an isolated `CODEX_HOME`. |

### Optional Enhancement Flags (Cross-Platform Parity)

| Linux / macOS (`run-codex.sh`) | Windows (`run-codex.ps1`) | Description |
|---|---|---|
| `--worktree` | `-Worktree` | Run inside an isolated managed Git worktree (placed at `exec` top level) |
| `--image <path>` (repeatable) | `-Image <string[]>` | Attach image files for `exec` or `resume` (rejected in `review` mode) |
| `--output-schema <file>` | `-OutputSchema <file>` | Constrain the final assistant response to a JSON Schema file |
| `--trust` | `-Trust` | Explicitly trust the working directory (off by default; use with care) |

## 4. Usage Examples

### Linux / macOS

```bash
# 1) Read-only second-opinion audit using account 2 via stdin
bash "<skill_dir>/scripts/run-codex.sh" \
  --account 2 \
  --mode exec \
  --sandbox read-only \
  --cwd "/path/to/repo" \
  --timeout 300 <<'EOF'
Inspect this repository in read-only mode for race conditions or missing error handling.
List findings by severity with file paths, line numbers, and concrete fixes.
EOF

# 2) Review uncommitted changes (without a custom prompt)
bash "<skill_dir>/scripts/run-codex.sh" \
  --mode review \
  --uncommitted \
  --cwd "/path/to/repo" \
  --timeout 180

# 3) Multi-turn session: keep initial session, then resume --last
bash "<skill_dir>/scripts/run-codex.sh" \
  --mode exec --keep-session --sandbox read-only --cwd "/path/to/repo" \
  --prompt "Map the authentication flow and note key entry points."
bash "<skill_dir>/scripts/run-codex.sh" \
  --mode resume --last --sandbox read-only --cwd "/path/to/repo" \
  --prompt "Based on your map, check whether token refresh has any concurrency race."
```

### Windows (`pwsh`)

```powershell
# Review uncommitted changes using account 2
pwsh -NoProfile -File "<skill_dir>\scripts\run-codex.ps1" `
  -Account 2 `
  -Mode review `
  -Uncommitted `
  -WorkingDir "C:\path\to\repo" `
  -TimeoutSeconds 300

# Read-only visual + structured-output analysis
pwsh -NoProfile -File "<skill_dir>\scripts\run-codex.ps1" `
  -Mode exec `
  -Sandbox read-only `
  -WorkingDir "C:\path\to\repo" `
  -Image @("C:\path\to\ui.png") `
  -OutputSchema "C:\path\to\schema.json" `
  -Prompt "Check layout regressions against the screenshot and emit JSON matching the schema."
```

## 5. Operational Notes

1. **Always bound execution time**: Both wrappers enforce a `300`s default hard timeout (adjustable via `--timeout` / `-TimeoutSeconds`). When dispatching asynchronously as a subagent, attach a conditional watchdog timer per your workspace watchdog rules.
2. **`review` conflict reminder**: To review uncommitted changes *with custom instructions*, use `--mode exec --sandbox read-only` and ask Codex to inspect `git diff` in your prompt instead of mixing `--uncommitted`/`--base`/`--commit` with a prompt.
3. **Quota failover across accounts**: If the primary account hits a rate limit or quota cap, inform the user and retry with `--account 2`. When resuming a session, always specify the same `--account` used to create it.
4. **Never leak credentials**: Never read, log, or print any `auth.json` file.
5. **Attribute clearly**: When relaying results to the user, clearly distinguish the Codex account used, Codex's independent findings, and what the main agent verified directly.

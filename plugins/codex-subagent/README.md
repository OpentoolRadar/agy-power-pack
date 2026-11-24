# Codex Subagent (`codex-subagent`)

Wrap the locally installed OpenAI `codex` CLI (`codex exec` / `codex exec review` / `codex exec resume`) as a native **Google Antigravity** skill and dedicated subagent, with zero external MCP dependencies and built-in multi-account isolation.

## Included Components

- `skills/codex-subagent/SKILL.md`: On-demand operational playbook for the main agent (read-only second opinions, code review, scoped edits, session resume, and multi-account routing).
- `agents/codex-worker.md`: Dedicated subagent definition dispatched via `invoke_subagent` for isolated cross-model checks or bounded coding subtasks.
- `skills/codex-subagent/scripts/run-codex.sh`: Linux / macOS wrapper script with hard process timeouts, `-o` final-message extraction, upfront mutual-exclusion flag checks, `--worktree` / `--image` / `--output-schema` / `--trust` support, and `--account` / `--codex-home` routing.
- `skills/codex-subagent/scripts/run-codex.ps1`: Windows PowerShell (`pwsh`) wrapper with full feature parity, `WaitForExit` + `taskkill /T` hard timeout enforcement, UTF-8 piping, and `-Account` / `-CodexHome` routing.

## Multi-Account Isolation (`CODEX_HOME`)

- **Default account (`default` or `1`)**: Uses the standard `~/.codex` directory (staying compatible with your existing local Codex CLI / desktop setup).
- **Additional accounts (e.g., `2`, `work`)**: Stored under `~/.codex-accounts/<name>` (and automatically reuses `~/.codex-<name>` if already present), with `cli_auth_credentials_store = "file"` written into `config.toml` so each account's `auth.json`, config, and session history stay isolated without colliding in the OS keyring.

## Prerequisites & Safety Defaults

- The OpenAI `codex` CLI (`0.163.0+`, verified on `0.171.0`) must be installed on the host and authenticated via `codex login`.
- Defaults to `read-only` sandbox or `review` mode so files are never modified unless explicitly requested. `resume` also passes `--sandbox` and `-C` at the top level of `exec` to prevent permission drift.
- `workspace-write` is only enabled when the user explicitly asks Codex to edit files; `--trust` / `-Trust` defaults to off.
- `exec` and `review` default to `--ephemeral`; pass `--keep-session` / `-KeepSession` when you intend to follow up with `resume`.

## Installation

Copy this directory into `~/.gemini/config/plugins/codex-subagent` (or run `./install.sh codex-subagent` / `.\install.ps1 codex-subagent` from the repository root), then enable **Codex Subagent** under **Customizations -> Plugins** in Antigravity.

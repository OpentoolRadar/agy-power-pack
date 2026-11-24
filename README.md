# Antigravity Power Pack (`agy-power-pack`)

> **If stock Google Antigravity feels clunky on real multi-hour engineering tasks, you are probably missing these 6 open-source plugins.**

A zero-bloat, production-tested collection of 6 native **Google Antigravity** plugins maintained by **OpenTool Radar Contributors** — built with **zero external npm dependencies** and designed to run seamlessly across **Linux, macOS, and Windows**.

---

## Why Stock Antigravity Breaks Down on Real Projects

Antigravity is fast on 5-minute toy prompts, yet real multi-hour sessions routinely hit six frustrating failure modes:

| Stock Pain Point | What Actually Happens | Plugin That Fixes It |
| :--- | :--- | :--- |
| **1. Black-box tool spinners** | Internal reasoning collapses into `Thought for Xs` while raw shell calls stream by with no clue *why*. | [`visible-thinking-brief`](plugins/visible-thinking-brief/) |
| **2. Compaction amnesia & Swarm rollbacks** | After 2-3 context compactions (or a parallel Swarm pass), the agent forgets locked decisions and silently reverts verified work. | [`anti-drift-guard`](plugins/anti-drift-guard/) |
| **3. Forever-hung background tasks** | One deadlocked test or wedged subagent leaves the whole session stuck on `waiting_for_dependents` indefinitely. | [`unattended-watchdog`](plugins/unattended-watchdog/) |
| **4. Documentation drift** | Code, CLI flags, and paths evolve while `README.md`, indexes, and reproduction guides rot out of sync. | [`doc-sync-guard`](plugins/doc-sync-guard/) |
| **5. Single-model echo chamber** | You want an independent second-model code review or isolated bug triage without copy-pasting diffs into another window. | [`codex-subagent`](plugins/codex-subagent/) |
| **6. Constant alt-tabbing for Office docs** | Reading PowerPoint speaker notes, Word threaded comments/revisions, or Excel sheets forces you out of Antigravity. | [`office-preview`](plugins/office-preview/) |

---

## Included Plugins (6)

| Plugin | Type | External Deps | What It Gives You |
| :--- | :--- | :--- | :--- |
| [`plugins/office-preview`](plugins/office-preview/) | UI Sidecar + MCP Server + Skill | Node 18+, Python 3 stdlib (optional: LibreOffice / Office COM, PyMuPDF) | High-fidelity sidecar viewer for `.pptx`, `.docx`, `.xlsx`, `.csv`, and `.pdf` with threaded comments, anchor quotes, slide speaker notes, Word Track Changes, interactive spreadsheets, and one-click **Cite to Chat**. |
| [`plugins/codex-subagent`](plugins/codex-subagent/) | Subagent (`codex-worker`) + Skill + Cross-Platform Wrappers | Local OpenAI `codex` CLI | Wraps `codex exec`, `codex exec review`, and `codex exec resume` as a safe, read-only-by-default subagent with hard timeouts, `--worktree` / `--image` / `--output-schema`, and multi-account `CODEX_HOME` isolation. |
| [`plugins/anti-drift-guard`](plugins/anti-drift-guard/) | Always-On Rules (`rules/AGENTS.md`) | None | Persists locked decisions to disk, passes explicit conflict boundaries to Swarms/subagents, enforces root-first `mtime`-sorted file discovery, and bans invented attribution or post-edit pass claims. |
| [`plugins/unattended-watchdog`](plugins/unattended-watchdog/) | Always-On Rules (`rules/AGENTS.md`) | None | Mandates conditional `schedule` + `TimerCondition` watchdogs on long async tasks/subagents, OS process-level test timeouts, and deadlock-free concurrency barrier testing patterns. |
| [`plugins/doc-sync-guard`](plugins/doc-sync-guard/) | Always-On Rules (`rules/AGENTS.md`) | None | Synchronizes `README.md`, indexes, CLI flags, and live-measured metrics in the same turn as code changes while preserving cross-platform parity across Windows, macOS, and Linux. |
| [`plugins/visible-thinking-brief`](plugins/visible-thinking-brief/) | Always-On Rules (`rules/AGENTS.md`) | None | Emits a crisp 1-2 sentence plain-prose brief before every tool batch (matching whatever language the user speaks, with zero boilerplate prefixes) so you always see what was observed and why the next tool is running. |

---

## Quick Start

### Linux / macOS

```bash
git clone https://github.com/OpentoolRadar/agy-power-pack.git
cd agy-power-pack

# Install all 6 plugins into ~/.gemini/config/plugins
./install.sh

# Or install only what you need
./install.sh office-preview codex-subagent visible-thinking-brief

# List available plugins or uninstall
./install.sh --list
./install.sh --uninstall office-preview
```

### Windows (PowerShell)

```powershell
git clone https://github.com/OpentoolRadar/agy-power-pack.git
Set-Location agy-power-pack

# Install all 6 plugins into %USERPROFILE%\.gemini\config\plugins
.\install.ps1

# Or install specific plugins
.\install.ps1 office-preview codex-subagent visible-thinking-brief

# List available plugins or uninstall
.\install.ps1 -List
.\install.ps1 -Uninstall office-preview
```

After installing, open **Google Antigravity -> Customizations -> Plugins** and toggle on the plugins you want.

---

## Plugin Deep Dives

### 1. `office-preview` - Native Sidecar Office & PDF Viewer + MCP
- **Zero npm install**: Pure Node.js ESM sidecar + MCP stdio server + Python 3 standard-library OOXML parser.
- **Built for real review cycles**: Pulls Word `commentsExtended.xml` reply threads, resolved flags, anchor text quotes, footnotes/endnotes, and Track Changes; extracts PowerPoint speaker notes into a live slide dock; renders interactive Excel/CSV tables with commented-cell badges.
- **Bidirectional chat workflow**: Ask Antigravity to preview a file (via `office_preview_open`), inspect comments directly (`office_preview_inspect`), or click **Cite to Chat** inside the panel to send a slide/comment straight into your prompt.
- Full runtime matrix and shortcuts: [`plugins/office-preview/README.md`](plugins/office-preview/README.md).

### 2. `codex-subagent` - Cross-Model Second Opinions via Local Codex CLI
- **No third-party MCP glue**: Calls your host's `codex` binary directly via symmetric Bash (`run-codex.sh`) and PowerShell (`run-codex.ps1`) wrappers.
- **Read-only by default**: Runs `codex exec --sandbox read-only` or `codex exec review` with upfront validation against conflicting review flags and hard process timeouts.
- **Multi-account `CODEX_HOME` isolation**: Route tasks across multiple accounts (`--account 2`, `--account work`) backed by file-based credential stores so profiles never clobber your default `~/.codex`.
- Full CLI reference and examples: [`plugins/codex-subagent/README.md`](plugins/codex-subagent/README.md).

### 3. `anti-drift-guard` - Compaction & Swarm Guardrails
- Writes locked user constraints into tracked files before context compaction erases them.
- Forces explicit conflict boundaries in every subagent/Swarm brief and forbids silent rollbacks of previously verified artifacts.
- Enforces root-inclusive, modification-time-ordered file discovery and evidence-backed explanations.
- Details: [`plugins/anti-drift-guard/README.md`](plugins/anti-drift-guard/README.md).

### 4. `unattended-watchdog` - Anti-Hang Watchdogs for Unattended Runs
- Pairs every background command and long-running subagent with a conditional `schedule` timer (`TimerCondition`) that self-cancels on normal exit and triggers structured diagnosis on stalls.
- Adds process-level hard timeouts around test runners and forbids barrier-deadlocking `unwrap()` calls in multi-threaded tests.
- Details: [`plugins/unattended-watchdog/README.md`](plugins/unattended-watchdog/README.md).

### 5. `doc-sync-guard` - Zero-Drift Docs & Cross-Platform Parity
- Audits impacted `README.md`, navigation indexes, CLI examples, and live-measured counts in the same turn as code edits.
- Preserves side-by-side Windows / macOS / Linux instructions instead of letting a single-host session overwrite another platform's guide.
- Details: [`plugins/doc-sync-guard/README.md`](plugins/doc-sync-guard/README.md).

### 6. `visible-thinking-brief` - Kill the Black-Box Spinner
- Instructs the agent to emit 1-2 sentences of clean, natural prose before each tool batch describing what it just observed and what the upcoming action will check or change.
- Adapts automatically to whatever language the user is writing in — zero forced language lock-in and zero robotic `Thinking:` prefixes.
- Details: [`plugins/visible-thinking-brief/README.md`](plugins/visible-thinking-brief/README.md).

---

## Level Up to the Full 7-Piece Stack: [`agy-super-agent`](https://github.com/OpentoolRadar/agy-super-agent)

These 6 plugins turn a single Antigravity window into a sharp, resilient workstation. When you are ready to orchestrate **many repositories continuously across desktop and remote/mobile workflows**, pair this pack with our companion architecture project **[`agy-super-agent`](https://github.com/OpentoolRadar/agy-super-agent)**:

- **Always-on Chief Router** that stays cleanly separated from implementation noise by dispatching isolated workspace sessions and subagents.
- **Multi-tier persistent memory & task board** with full-text search so cross-day decisions survive across workspaces.
- **Scoped autonomy, audit logs, and kill-switch circuit breakers** for safe unattended execution.
- **Remote companion hub & low-noise notifications** for checking long-running jobs away from your desk.

Together, **`agy-power-pack` (6 plugins) + [`agy-super-agent`](https://github.com/OpentoolRadar/agy-super-agent)** form a complete 7-piece power-user stack for Google Antigravity.

---

## Community Ecosystem Recommendation

Want real-time token usage, quota tracking, and speed telemetry right inside your Antigravity sidebar? Check out the independent open-source community project **[yuhuan-dev/antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)** (licensed separately under GPL-3.0; not bundled in this Apache-2.0 repository).

---

## Verification & Quality Gate

Run the repository checks locally at any time:

```bash
# JavaScript / ESM syntax check
find plugins scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

# Python bytecode compilation check
find plugins -type f -name '*.py' -print0 | xargs -0 -n1 python3 -m py_compile

# Bash syntax check
bash -n install.sh
find plugins -type f -name '*.sh' -print0 | xargs -0 -n1 bash -n

# Generic sanitization, English-purity, and manifest audit
node scripts/audit-sanitization.mjs
```

---

## License

Licensed under the [Apache License 2.0](LICENSE).
Copyright 2026 OpenTool Radar Contributors.

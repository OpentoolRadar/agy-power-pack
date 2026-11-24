# Anti-Drift Guard (`anti-drift-guard`)

An always-on rule plugin for **Google Antigravity** that eliminates the four failure modes that routinely break multi-hour agent sessions and multi-agent Swarms:

1. **Persist Locked Decisions (Anti-Compaction Amnesia)**: Hard user constraints, approved invariants, and phase sign-offs are written to workspace files (such as `AGENTS.md` or `docs/LOCKED_DECISIONS.md`) rather than left to decay across automatic context compactions.
2. **Prevent Multi-Agent / Swarm Reverse Rollbacks**: Subagent briefs must carry explicit conflict boundaries and protected baselines; downstream style or cleanup passes are forbidden from silently reverting previously verified work.
3. **Root-First, Timestamp-Ordered File Discovery**: When locating reports, exports, datasets, or drafts, agents must inspect the workspace root and candidate directories sorted by descending `mtime` instead of guessing from a narrow subdirectory or citing stale artifacts.
4. **Zero Invented Attribution & Zero Speculative Guarantees**: Discrepancies must be traced through actual file contents and `git log` before speaking; unverified external thresholds or post-edit pass claims are explicitly prohibited.

## Installation

Copy this directory into `~/.gemini/config/plugins/anti-drift-guard` (or run `./install.sh anti-drift-guard` / `.\install.ps1 anti-drift-guard` from the repository root), then enable **Anti-Drift Guard** under **Customizations -> Plugins** in Antigravity.

No external runtime dependencies are required.

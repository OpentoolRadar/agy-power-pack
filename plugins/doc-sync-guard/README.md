# Doc Sync Guard (`doc-sync-guard`)

An always-on documentation hygiene plugin for **Google Antigravity** that keeps `README.md`, architecture specs, data inventories, and reproduction guides in lockstep with evolving code and datasets:

1. **Same-Turn Synchronization**: Whenever code modules, CLI flags, configs, data paths, or workflow scripts change, affected docs are audited and updated in the same task turn.
2. **Zero Dead Links & Zero Stale Commands**: New assets are added to top-level indexes; renamed, moved, or removed paths trigger a workspace-wide link and command cleanup.
3. **Measured Facts Only**: File counts, sizes, checksums, CLI options, and benchmark metrics written into docs must come from live workspace measurements, never memory or guesswork.
4. **Minimal Surgical Diffs**: Update existing canonical documents in place while preserving headings, table formatting, and terminology — never spawn duplicate ad-hoc summary files at the root.
5. **Cross-Platform & Multi-Host Parity**: Use workspace-relative paths by default and document OS-specific commands or environment paths side-by-side (Windows / macOS / Linux) without overwriting another platform's instructions.

## Installation

Copy this directory into `~/.gemini/config/plugins/doc-sync-guard` (or run `./install.sh doc-sync-guard` / `.\install.ps1 doc-sync-guard` from the repository root), then enable **Doc Sync Guard** under **Customizations -> Plugins** in Antigravity.

No external runtime dependencies are required.

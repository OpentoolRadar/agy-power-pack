# Global Documentation Synchronization Rules (`doc-sync-guard`)

To guarantee that project documentation, navigation indexes, data inventories, and reproduction guides stay strictly aligned with the latest code, data, and directory layout, enforce these five rules across every workspace and task.

## 1. Synchronize on Every Change (Pre-Delivery Audit)
- **Trigger**: Whenever you add, modify, move, rename, or delete **code modules, CLI flags/APIs, configuration schemas, data/archive directories, experiment outputs, or workflow scripts**, inventory all impacted documentation before finishing (including `README.md`, project overviews, architecture/API specs, data dictionaries, and deployment or reproduction guides).
- **Same-turn alignment**: When behavior, input/output contracts, dependencies, or asset layouts change, update the corresponding documentation in the same turn. Never leave docs lagging behind code. If the user explicitly asks to defer doc edits, list the exact docs pending synchronization in your final summary.

## 2. Navigation Index & Cross-Reference Integrity (Zero Dead Links, Zero Broken Commands)
- **Index new assets**: When adding key scripts, modules, data directories, configs, or milestone reports, check top-level navigation docs (e.g., `README.md` or overview tables) and add them under the existing taxonomy.
- **Clean up moved/deleted references**: When moving, renaming, or deleting files or directories, search across workspace documentation for Markdown links, CLI examples, and configuration snippets referencing the old path and update them all so zero dead links or broken commands remain.

## 3. Grounded Facts & Metrics (No Estimates, No Stale Numbers)
- **Measure, never guess**: File counts, directory sizes, record counts, checksums (SHA-256/MD5), CLI flags, and experiment metrics written into documentation must match **current measured workspace state or verified manifests**. Never estimate from memory or copy stale pre-edit values.
- **Flag stale derived deliverables**: When derived outputs (such as generated `.docx`/`.pdf` reports, rendered charts, or release bundles) are built from Markdown or scripts, either rebuild them with the project's toolchain after editing the source or explicitly inform the user which derived artifacts still need regeneration.

## 4. Minimal Incremental Edits & Structural Preservation
- **Prefer canonical docs over new clutter**: Record updates in the appropriate section of the workspace's existing authoritative documents. Do not create scattered or redundant summary files in the repository root unless explicitly requested.
- **Surgical diffs only**: Preserve existing heading levels, terminology, table layouts, and tone. Edit only the sections impacted by the change; never rewrite unrelated paragraphs or disturb finalized prose.

## 5. Cross-Platform & Multi-Host Parity (Windows / macOS / Linux)
- **Default to workspace-relative paths**: File references and CLI snippets in shared docs (`README.md`, `AGENTS.md`, handoff and reproduction guides) must prefer workspace-relative paths. Avoid embedding machine-specific drive letters or user-specific absolute home paths in shared instructions.
- **Keep OS differences side-by-side (never overwrite another platform)**: When Windows, macOS, and Linux differ in **virtual-environment or interpreter paths** (e.g., `.venv\Scripts\python.exe` vs `.venv/bin/python`, `python` vs `python3`), **shell syntax** (PowerShell vs Bash/Zsh), or **platform-specific tools and packages**, document the variants side-by-side. **Never rewrite shared cross-platform instructions into one OS's shell syntax or delete another platform's guide while working on a single host.**
- **Ignore local environment and build artifacts**: Treat host-local dependency/build caches (`.venv`, `venv`, `node_modules`, `target`, `__pycache__`, `.cache`, etc.) and file-sync metadata folders as host-local infrastructure rather than missing source files or unexpected repository diffs.

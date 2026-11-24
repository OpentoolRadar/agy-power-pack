# Office Preview (`office-preview`)

A native-feeling **PowerPoint / Word / Excel / CSV / PDF** sidecar viewer and companion MCP server for **Google Antigravity**, built with **zero external npm dependencies**. Inspect rendered pages alongside threaded review comments (with anchor quotes and resolved states), PowerPoint speaker notes, Word footnotes/endnotes and Track Changes, and multi-sheet interactive spreadsheets without leaving the editor.

## Key Features

- **High-Fidelity Page Rendering (PPTX / DOCX / PDF / Excel Print Layout)**:
  - Fingerprint cache keyed by `(absolute path + mtime + file size)` automatically re-renders when a file is saved.
  - Switch between single-page presentation view and continuous scroll, with a bottom thumbnail strip (showing comment/note indicator dots), zoom controls, and fit-to-width.
- **Deep Review & Metadata Extraction**:
  - **PowerPoint (`.pptx`)**: Extracts **Speaker Notes** per slide and docks them live beneath the slide canvas; parses both legacy and Microsoft 365 threaded comments with one-click slide jump.
  - **Word (`.docx`)**: Extracts **comments**, **reply threads**, **resolved states**, and exact **anchor text quotes**, mapping comments back to rendered PDF page numbers; also extracts **footnotes / endnotes** and **Track Changes** (insertions/deletions).
  - **Excel / CSV (`.xlsx` / `.csv` / `.tsv`)**: Opens an instant multi-sheet interactive table with red corner badges on commented cells (click to jump directly to the comment) and on-demand PDF print-layout preview.
  - **PDF (`.pdf`)**: Renders pages and extracts bookmarks/outlines plus PDF annotations (highlights, sticky notes, comments).
- **Bidirectional Chat Integration**:
  - Click **Cite to Chat** on any page, comment, or speaker note to attach structured context directly into your next Antigravity message.
  - Bundled zero-dependency MCP server (`office-preview_viewer`) lets the agent list workspace documents, inspect comments/notes programmatically, or push any file directly into the sidecar pane.

## Cross-Platform Runtime Matrix (Linux / macOS / Windows)

| Capability | Linux / macOS | Windows |
| :--- | :--- | :--- |
| Sidecar UI & MCP Server | `node` (v18+, zero npm dependencies) | `node` (v18+, zero npm dependencies) |
| OOXML Comments / Notes / Sheets Parser | `python3` (standard library only) | `python` / `py -3` (standard library only) |
| Office-to-PDF Conversion | `soffice` / `libreoffice` (headless) | Prefers `soffice.exe` (LibreOffice); automatically falls back to PowerShell + local Microsoft Office COM |
| High-DPI Page Rendering | Python `PyMuPDF` (`fitz`, optional) | Python `PyMuPDF` (`fitz`, optional); gracefully falls back to embedded PDF viewer |
| Cache & Shared State Directory | `~/.gemini/antigravity/plugin_data/office-preview/` | `%USERPROFILE%\.gemini\antigravity\plugin_data\office-preview\` |

> Tip: Install this plugin on the host where your Antigravity session runs (local machine or remote SSH host).

## Installation

### Linux / macOS

```bash
mkdir -p ~/.gemini/config/plugins
cp -a plugins/office-preview ~/.gemini/config/plugins/
```

### Windows (PowerShell)

```powershell
$pluginsRoot = Join-Path $env:USERPROFILE ".gemini\config\plugins"
New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null
Remove-Item -Path (Join-Path $pluginsRoot "office-preview") -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -Path "plugins\office-preview" -Destination $pluginsRoot -Recurse -Force
```

Or run `./install.sh office-preview` / `.\install.ps1 office-preview` from the repository root. Then enable **Office Preview** under **Customizations -> Plugins** and open **Office Preview** from the right-hand Auxiliary Pane (`+`).

## Keyboard Shortcuts (When Canvas Is Focused)

- `Left Arrow` / `PageUp`: Previous page
- `Right Arrow` / `PageDown`: Next page
- `+` / `-`: Zoom in / zoom out
- `0`: Fit to width

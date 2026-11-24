---
name: office-preview
description: >-
  Activate when the user wants to preview PowerPoint, Word, Excel, CSV, or PDF files inside the
  Antigravity desktop sidecar, inspect slide speaker notes, extract document/spreadsheet comments,
  or review Word tracked changes.
---

# Office Document Preview & Review Inspector (`office-preview`)

This plugin renders a high-fidelity Office/PDF viewer in Antigravity's Auxiliary Pane and exposes the `office-preview_viewer` MCP server for bidirectional chat integration.

## Workflow

1. **Open a document in the sidecar viewer**:
   - Call the MCP tool `office_preview_open` with the target file's absolute path (plus optional `page` number or `tab`: `comments` / `notes` / `outline` / `revisions`).
   - Include the quick-open sidecar pill link in your response:
     `[Office Preview](sidecar://office-preview/panel/)`
2. **Inspect comments, speaker notes, revisions, or document structure directly**:
   - Call `office_preview_inspect` to retrieve structured JSON containing page counts, threaded comments (author, timestamp, anchor quote, resolved flag), PowerPoint speaker notes, Word footnotes/endnotes and tracked changes, and Excel sheet/cell comments — without writing ad-hoc parsing scripts.
3. **Discover Office and PDF files in a workspace**:
   - Call `office_preview_list` to scan a directory for `.pptx`, `.docx`, `.xlsx`, `.csv`, and `.pdf` documents ordered by most recent modification time.

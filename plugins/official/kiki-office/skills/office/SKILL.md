---
name: kiki-office
description: Create, inspect, edit, validate, and visually audit local .docx, .xlsx, and .pptx documents—including scientific papers, experimental spreadsheets, and research presentations—using Kiki Office tools (OfficeCLI 1.0.163).
---

# Kiki Office Suite

Use the `office_*` tools to create, inspect, edit, validate, and preview local `.docx`, `.xlsx`, and `.pptx` documents. The host arranges the pinned `OfficeCLI 1.0.163` executable with user consent; tools never download executables.

## Core Workflow

1. **Discover before writing**:
   - New file: `office_create`.
   - Existing file: `office_view(mode="outline")` → `office_query(compact=true)` or `office_get(depth=1..2)`.
   - Unfamiliar element or property name: call `office_help(format, verb?, element?)` before guessing. Do not invent property names.
2. **Edit atomically**:
   - Prefer `office_batch` (1–128 commands: `add`, `set`, `remove`, `move`, `swap`, `get`, `query`, `validate`; rollback on any error) over dozens of single edits.
   - Pass `props` as a flat primitive map (`{ "border.top": "single;12;000000" }`) or `["key=value"]` list; nested objects are invalid.
   - Use `office_add` placement (`before`, `after`, `index`) or `from` (internal DOM clone like `/slide[1]`) to preserve existing templates.
   - Use `office_import` to load `.csv`/`.tsv` tables (up to 16 MiB) into an existing `.xlsx` sheet without touching the source file.
3. **Delivery Gate (mandatory before finishing)**:
   - Run `office_validate(file)` → `count: 0`.
   - Run `office_view(file, mode="issues")` → resolve structural, formula, overflow, clipping, and contrast findings.
   - Run `office_preview(file, pages="1-12", grid="auto")` for multi-page `.docx`/`.pptx` contact sheets (or `range="Sheet1!A1:H25"` for `.xlsx`), then zoom in on any dense or flagged page with single-page `page=K` or element `range="/slide[K]/table[1]"`. If the model lacks image input, inspect the outline fallback and `office_view(mode="text")`.

## Domain References (Load Only What Matches the Format)

- **Word manuscripts, theses, grants (`.docx`)**: `references/word-academic.md`
- **Experimental data, statistics, scientific charts (`.xlsx`)**: `references/excel-data.md`
- **Lab group meetings, conference talks, defenses (`.pptx`)**: `references/pptx-research.md`

## Universal Discipline

- **Paths & safety**: Document and CSV paths are workspace-relative unless explicitly approved in Kiki. Every existing Office file is checked by a streaming OOXML guard (outer package + depth-1 chart workbooks) before OfficeCLI runs; macros, ActiveX, OLE objects, depth `>1` archives, and unsafe external relationships are rejected. External file paths are not admitted through `props.src` or `props.data`.
- **Exit-with-warnings**: A successful result that includes `warnings` means the edit landed on disk with a caveat—inspect and resolve warnings instead of blindly repeating the mutation (which duplicates content).
- **Windowed reads**: `office_view` caps at 500 rows / 2000 cells / 64 KiB and marks truncation with `> Truncated:`. Narrow with `range`, `cols`, `start`/`end`, or `office_query(compact=true)`.
- **Zero placeholders**: Never leave `{{...}}`, `TODO`, `TBD`, or `xxxx` in a delivered document; preserve existing template styles and numbering conventions when editing an existing file.
- **Error recovery**: Every error returns `{ code, message, suggestion }`. Act on `suggestion` (or check `office_help`) rather than retrying an unchanged call.

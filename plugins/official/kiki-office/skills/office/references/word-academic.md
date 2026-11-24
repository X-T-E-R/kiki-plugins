# Word Academic & Scientific Typesetting (`.docx`)

Load when authoring or revising journal manuscripts, theses, technical reports, or grant proposals in `.docx`. Always verify uncommon property names with `office_help(format="docx", element="...")`.

## 1. Three-Line Academic Table (三线表)

Standard specification: `1.5pt` top/bottom rules (`12` eighth-points), `0.75pt` header bottom rule (`6` eighth-points), zero vertical or interior horizontal borders, repeating header across page breaks.

- **Semicolon grammar only in `.docx`**: `single;12;000000` (colons fail with `invalid_value`).
- **Header divider goes on cells (`tc`), not `tr`**:

```json
[
  {
    "command": "add",
    "parent": "/body",
    "type": "table",
    "props": {
      "rows": 4,
      "cols": 4,
      "width": "100%",
      "align": "center",
      "border.all": "none",
      "border.top": "single;12;000000",
      "border.bottom": "single;12;000000"
    }
  },
  {
    "command": "set",
    "path": "/body/tbl[1]/tr[1]",
    "props": { "header": true, "cantSplit": true, "c1": "Method", "c2": "YS (MPa)", "c3": "EL (%)", "c4": "n" }
  },
  {
    "command": "set",
    "path": "/body/tbl[1]/tr[1]/tc[1]",
    "props": { "border.bottom": "single;6;000000", "bold": true, "align": "center", "valign": "center" }
  }
]
```

Apply `border.bottom: "single;6;000000"` to every header cell `tr[1]/tc[1..C]`. Set `cantSplit: true` on data rows so values never tear across page breaks. Put units in column headers and report `n=` and uncertainty (`mean ± SD` or `95% CI`) in the caption or table note.

## 2. Bilingual CJK–Latin Typography & Figure Clipping Guard

- Set document defaults up front: `set /` with `{ "docDefaults.font": "Times New Roman", "docDefaults.fontSize": "10.5pt" }`.
- Pair Latin and East Asian faces on paragraphs, runs, and table cells:
  `{ "font.ascii": "Times New Roman", "font.ea": "SimSun", "size": "10.5pt", "lineSpacing": "1.5x" }` (headings may use `SimHei`).
- **Critical thesis pitfall**: Fixed exact line spacing (e.g., `lineSpacing: "20pt"`) on a paragraph containing an inline figure clips the top of the image. Always set `lineSpacing: "1x"` on figure paragraphs and verify `office_view(mode="issues", issueType="picture_clipped_by_line_spacing")` returns zero findings.

## 3. Native OMML Equations & Flush-Right Numbering

- **Mandatory double-backslash rule**: OfficeCLI unescapes backslash sequences in property values before parsing LaTeX. Single-escaped `\beta` turns `\b` into invalid XML `0x08` and `\sigma` degrades to literal `"sigma"`. Always double-escape LaTeX commands in tool JSON (`"\\\\sigma_y = \\\\sigma_0 + k_y d^{-1/2}"` in raw JSON string → `\\sigma_y` in property value so `FormulaParser` receives `\sigma_y` and emits `<m:t>σ</m:t>`).
- Avoid `\left(...\right)` wrapping inner sub/superscripts; use plain `(...)` (OMML auto-scales delimiters).
- **Display block**: `add /body` `type: "equation"`, `props: { mode: "display", formula: "\\\\sigma_y = \\\\sigma_0 + k_y d^{-1/2}" }`.
- **Inline inside a table cell**: attach to `tc[C]/p[1]` with `mode: "inline"`, never directly to `tc[C]`.
- **Journal-standard single-line numbered equation** (`[tab] equation [tab] (1)`):
  1. Add paragraph under `/body`.
  2. Add center tab (`pos: 4150, val: "center"`) and right tab (`pos: 8300, val: "right"`) for A4 with 3.18 cm margins (recompute `(pageWidth - marginLeft - marginRight)` in twips for custom margins or 2-column sections).
  3. Add `run` `"\t"`, then `equation` (`mode: "inline"`), then `run` `"\t(1)"`.
- **Verification**: check `office_view(mode="text")` shows Unicode Greek (`σ`, `α`, `β`), not literal `sigma`.

## 4. Captions, Cross-References & Multi-Column Sections

- **Placement**: Table captions go **ABOVE** tables with `keepNext: true` (prevents orphan captions); figure captions go **BELOW** figures.
- **Auto-numbering (`SEQ`)**: build paragraph `"Table "` → `add` `type: "field"` `{ fieldType: "seq", identifier: "Table" }` → `add` `type: "run"` `{ text: ". Caption title" }` → optional `bookmark`. After all captions exist, run once: `set /` `{ recalcFields: "seq" }`. For TOC / `PAGE` / `PAGEREF`, also run `set /settings` `{ updateFields: true }`.
- **Two-column journal layout**: insert `add /body` `type: "section"` `{ type: "continuous" }` after the single-column title/abstract, then `set /section[last()]` `{ columns: 2, columnSpace: "1cm" }`. Revert to single column with another continuous section and `columns: 1`. Because section breaks shift positional `p[N]` indices by +1, address existing paragraphs via stable `@paraId=` from `office_get`.
- **Bibliography hanging indent**: `{ indent: 720, hangingIndent: 720 }` (0.5 in left indent with first line flush left; never use negative `ind.firstLine`). Keep heading numbering consistent with venue style (APA 7 unnumbered centered H1; IEEE Roman ALL-CAPS `I. INTRODUCTION`; Chicago/GB Arabic `1. Introduction`; References unnumbered).

## 5. Template Preservation, Tracked Changes & Gate

- Inspect an existing template with `office_view(mode="outline")`, `office_get(path="/styles", depth=1)`, and `office_query(selector="comment")` before editing. Do not invent `style: "Caption"` unless defined in `/styles`.
- Tracked revision: `office_set` with `find`, `replace`, and `props: { "revision.author": "Reviewer" }`. Bulk accept/reject: `set /revision[@author=Name]` `{ "revision.action": "accept" }`.
- **Word Delivery Gate**: `office_validate` (0 errors) → `office_view(mode="issues")` (0 `picture_clipped_by_line_spacing` / `field_not_evaluated`) → `office_preview(pages="1-12", grid="auto")` → zoom suspect pages with `page=K`.

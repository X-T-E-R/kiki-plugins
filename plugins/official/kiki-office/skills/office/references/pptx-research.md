# PowerPoint Research Presentations (`.pptx`)

Load when building or refining lab group-meeting updates, conference oral talks, or thesis defense decks in `.pptx`. Always verify uncommon property names with `office_help(format="pptx", element="...")`.

## 1. Occasion Routing (Two Distinct Academic Archetypes)

Match structure to the live room—never force one generic card grid on both:

- **Lab Group Meeting (`组会汇报`)**:
  - Skip ceremonial cover padding; Slide 1 opens directly on the active research question + raw unsmoothed experimental/anomaly data.
  - Show binary hypothesis/debug branches, honest failed attempts, a dense ablation table with bold/underlined winning metrics, concrete blockers, and 2 falsifiable next-week tests.
- **Conference Oral / Thesis Defense (`学术答辩`)**:
  - Narrative arc: Problem & Gap → Prior Work positioning → Method schematic → Evaluation slides with **Assertion-Evidence verb headlines** (state the finding as a full claim beside the evidence plot on the same slide) → dedicated Limitations slide → quantified Contributions close (never end on a bare `"Thank You"` slide).
  - Append hidden Q&A Backup Slides (`B1..Bn`) linked from main slides via `link: "slide[N]"` jump targets.

## 2. 16:9 Coordinate Grid & Projection Typography Floor

Standard widescreen canvas: **`33.87 cm × 19.05 cm`** (`13.33" × 7.5"`), margins `>= 1.27 cm` (0.5"), consistent gutter `0.76–1.0 cm`.

- **2-column split**: left `x=1.27cm, w=15.2cm`; right `x=17.4cm, w=15.2cm`.
- **3-column split**: `w=9.91cm`, `x ∈ {1.27, 11.98, 22.69} cm` (gutter `0.8cm`).
- **Projection typography ladder** (legible at `q960` / conference room back row):
  - Slide title: **`32–44pt`** bold (`height >= 1.8cm`)
  - Section / callout header: **`22–26pt`**
  - Body text: **`18–22pt`** (avoid `<18pt` body)
  - Table cells: **`14–16pt`**
  - Captions, axis labels, citations: **`12–14pt`** (never `<10pt`)
  - Height rule: `min shape height >= font_pt * 0.05 cm` per line to avoid text clipping.
- **Metric-safe fonts**: `Arial`, `Calibri`, `Cambria`, `Times New Roman`, plus `Microsoft YaHei` / `SimHei` for CJK. Avoid `Aptos` (causes cross-platform metric drift).
- Name key elements at creation (`name: "Title"`, `name: "AblationTbl"`) and address via `/slide[N]/shape[@name=Title]`. Preserve institutional templates by cloning layouts via `office_add(parent="/", from="/slide[K]")`.

## 3. High-Density Research Data Slides

- **Three-line slide ablation table**:
  `add /slide[N]` `type: "table"` with `rows`, `cols`, `x`, `y`, `width`, `height`, `colWidths`, `border.all: "none"`, `border.top: "1.5pt solid 1E293B"`, `border.bottom: "1.5pt solid 1E293B"`. Apply `border.bottom: "0.75pt solid 1E293B"` to header cells `tr[1]/tc[*]`, bold the winning row/cell, and state `n=` and uncertainty metric in a footnote.
- **Native charts & consistent palette**:
  Keep one fixed color-to-method/condition mapping across every slide in the deck (colorblind-safe and grayscale-distinguishable). Keep axes honest (zero-baseline for bar charts; explicit axis break marker if truncated).
- **Method schematics**:
  Use crisp `shape` blocks + `connector` (`from="/slide[N]/shape[@name=A]"`, `to="/slide[N]/shape[@name=B]"`, `shape="elbow"`, `tailEnd="triangle"`). Corner radius (`0px` sharp scientific instrumentation vs subtle radius) follows subject matter.
- **Speaker notes**: add `type: "notes"` on every content slide for timing and talking points.
- **Anti-AI-slop rules**:
  - Zero decorative accent bars/underlines beneath titles.
  - Zero rounded cards with colored left-edge stripes.
  - Zero emoji as UI or bullet icons.
  - One primary finding per slide; keep claim and supporting plot/table side by side.
  - Note: external local image paths are not read via `props.src` in `office_add`; only inline `data:image/*;base64,...` URIs are accepted without a separate host-admitted path.

## 4. Two-Stage Contact-Sheet Visual QA (`--grid` Loop)

1. **Whole-deck sweep in 1–2 calls**:
   `office_preview(file, pages="1-12", grid="auto")` (for `.pptx`, `pages` accepts a single slide `"2"` or contiguous range `"1-12"`, not comma-separated lists; for >12 slides, follow with `"13-24"`). Audit deck rhythm, title-height consistency, whitespace balance, dark-on-dark contrast, clipped text, and off-slide collisions at a glance.
2. **Targeted full-res zoom**:
   For any dense ablation table, chart, or flagged slide `K`, inspect `office_preview(file, page=K)` or element crop `office_preview(file, page=K, range="/slide[K]/table[1]")`.
3. **Objective gate**:
   - `office_validate(file)` → `count: 0`.
   - `office_view(file, mode="issues")` → verify zero `shape_off_slide`, `low_contrast`, `picture_aspect_distorted`, `preset_adjust_refused`, `notes_unresolved_rid`, and `broken_part_ref`.
   - `office_query(file, selector="*", compact=true, fields="x,y,width,height")` → quick coordinate audit across slides.

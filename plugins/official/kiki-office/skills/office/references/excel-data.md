# Excel Experimental Data, Statistics & Charts (`.xlsx`)

Load when building or auditing lab data workbooks, statistical analyses, or publication-ready tables and charts in `.xlsx`. Always verify uncommon property names with `office_help(format="xlsx", element="...")`.

## 1. Three-Sheet Scientific Architecture

Separate immutable source measurements from calculations and figures:

1. **`Raw_Data`**: untouched replicate measurements. Ingest `.csv`/`.tsv` in one call via `office_import(file, sheet="/Raw_Data", source="data/exp.csv", header=true)` (source file stays untouched; up to 16 MiB). Document physical units in column headers (`YS (MPa)`, `Elongation (%)`, `Temp (K)`).
2. **`Analysis`**: derived summary metrics (`Mean`, `SD`, `SEM`, `95% CI`, `p-value`, `R²`, slope) driven strictly by cross-sheet Excel formulas (`'Raw_Data'!B2:B11`). Never hardcode calculated statistics.
3. **`Summary_Charts`**: clean reporting tables and native OOXML charts referencing `Analysis` with sheet-prefixed ranges.

## 2. Live-Evaluated Scientific Formulas (OfficeCLI 1.0.163)

OfficeCLI evaluates core statistical formulas natively on write without LibreOffice:

- **Evaluated live (`evaluated: true`)**:
  `AVERAGE`, `STDEV.S`, `STDEV.P`, `VAR.S`, `MEDIAN`, `PERCENTILE.INC`, `QUARTILE.INC`, `SLOPE`, `INTERCEPT`, `RSQ`, `CORREL`, `INDEX(LINEST(...),1)`, `T.TEST`, `TTEST`, `T.INV.2T`, `TINV`, `CONFIDENCE.NORM`, `NORM.S.INV`, `IFERROR`, `SUMIFS`, `INDEX`/`MATCH`, `SQRT`, `COUNT`, `TEXT(E2,"0.00")&" ± "&TEXT(F2,"0.00")`.
- **Critical pitfall — `CONFIDENCE.T` does NOT evaluate natively** (`#OCLI_NOTEVAL!`):
  Replace `=CONFIDENCE.T(0.05, SD, n)` with the exact mathematical equivalent:
  `=T.INV.2T(0.05, n-1)*SD/SQRT(n)` (evaluates live cleanly).
- Guard every denominator against zero/blank cells: `=IFERROR(A2/B2, "N/A")` or `=IF(COUNT(B2:B10)<2, "", STDEV.S(B2:B10))`.
- Inside `office_batch` cell `props`, never use ambiguous `"color"`—use explicit `"font.color"` and `"fill"`.
- A green formula evaluation proves syntax, not scientific correctness: spot-check 2–3 key cells with `office_get` to confirm both `formula` and plausible `computedValue`.

## 3. Publication Number Formats, Column Widths & Print Layout

- Fixed precision: `numFmt: "0.00"` or `"0.000"`
- Scientific notation: `numFmt: "0.00E+00"`
- Percentages (stored as decimal fractions like `0.138`): `numFmt: "0.0%"`
- Sample IDs and years (prevent `2,026`): `numFmt: "@"`
- **Prevent `###` overflow**: default width `8.43` clips `0.00E+00` and `Mean ± SD` strings. Explicitly size columns (`set /Analysis/col[B]` `{ width: 16 }`), freeze headers (`freeze: "A2"`), and configure landscape print (`fitToPage: "1x0"` for tall tables, `"true"` for single-page summaries).
- **Publication three-line summary table**: `border.all: "none"` on data range, thick top/bottom border on table extents, thin bottom rule on header row, centered headers, right-aligned numeric columns with uniform decimal places.

## 4. Windowed Inspection for Large Datasets (>200 Rows)

Do not dump entire multi-thousand-row sheets at once:

1. `office_view(file, mode="outline")` — inspect sheet names and exact used dimensions.
2. `office_view(file, mode="text", range="Raw_Data!A1:H60", cols="A,B,C,D", json=true)` — windowed read with exact `totalRows` and truncation flags (up to 500 rows / 2000 cells per call).
3. `office_query(file, selector="cell:has(formula)")` or `'Raw_Data!row[YS>950]'` — targeted audit of formulas or outlier rows.

## 5. Native Scientific Charts

Add charts with explicit sheet-prefixed `dataRange` (or `seriesN.{name,values,categories}`) and crisp framing (`roundedCorners: false`):

```json
[
  {
    "command": "add",
    "parent": "/Summary_Charts",
    "type": "chart",
    "props": {
      "chartType": "scatter",
      "title": "Yield Strength vs Grain Size",
      "dataRange": "Analysis!A1:C8",
      "anchor": "E2:N22",
      "roundedCorners": false
    }
  },
  {
    "command": "set",
    "path": "/Summary_Charts/chart[1]/series[1]",
    "props": { "errBars": "stddev", "marker": "circle:6:1E2761", "smooth": false }
  },
  {
    "command": "set",
    "path": "/Summary_Charts/chart[1]/axis[@role=value]",
    "props": { "title": "YS (MPa)", "axisNumFmt": "0" }
  }
]
```

- Supported scientific chart types include `scatter`, `line`, `column`, `bar`, `boxWhisker`, `histogram`, `pareto`, `area`, `combo`.
- Error bar property is `errBars` (`stddev`, `stderr`, `fixed`, `percent`)—not `errorBars`.
- Series cannot be removed individually; rebuild the chart if series count changes.

## 6. Excel Delivery Gate

1. `office_validate(file)` → `count: 0`.
2. `office_view(file, mode="issues")` → verify zero `formula_eval_error`, `formula_not_evaluated`, `formula_cache_stale`, `formula_ref_missing_sheet`, `numeric_overflow`, `definedname_broken`, and `chart_series_ref_missing_sheet`.
3. `office_preview(file, range="Analysis!A1:J25")` (and `Summary_Charts` range) → visually check alignment, legends, axis labels, and zero `###` clipping.

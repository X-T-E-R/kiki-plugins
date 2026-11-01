# Kiki Work

Check office tables before a report: audit the keys of a CSV/TSV export and
reconcile two exports row by row. Both tools only read the files. They never
modify them and make no network requests.

## Install and use

Install the plugin from Kiki's plugin market (or this directory with
`/plugins install --trust ./plugins/official/kiki-work`) and enable it. It
needs no external program.

Ask Kiki to compare two exports, or load the `work-reconciliation` skill:

> Compare `sales.csv` and `payments.csv` by store ID and write the differences into a report.

| Tool | What it reports |
| --- | --- |
| `table_audit` | Row count, headers, rows with a blank key, duplicate keys, and whether the table is safe to compare |
| `table_compare` | Added, removed and changed rows between two tables, with the changed columns and their before/after values |

Keys are exact header names (one to eight columns used together). Values stay
strings, so leading zeroes (`0417`) and currency text (`1,200.00`) are compared
as written, with no numeric or fuzzy matching. Rows with blank or duplicate
keys are left out of the comparison and reported, and `complete: false` marks
a result that has such exclusions. Results are paged with `offset`, `limit`
and `next_offset`.

The tools tell you *where* two tables differ, not *why*. The skill writes the
report from the source rows and leaves causes to you. Excel workbooks are not
read directly: export the relevant sheets to CSV copies first (the Office
tools can do this) and keep the original workbook unchanged.

Inputs must be UTF-8, at most 16 MiB and 100,000 rows, with a unique,
non-empty header row.

## Tests

`node --test test/tables.test.mjs`

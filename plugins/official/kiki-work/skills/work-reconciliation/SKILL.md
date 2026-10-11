---
name: work-reconciliation
description: Reconcile office tables, invoices and reports by explicit keys, with source-linked differences and a previewable report. Use when the user asks to compare two CSV/TSV exports or check duplicate and missing keys; not for general prose, scheduling or modifying original records.
---

# Work Reconciliation

Produce a source-linked reconciliation report without changing the original records.

1. Read the material and identify its actual headers, units, date range and key fields. If two plausible keys would change which records match, ask the user to choose once. Preserve identifier strings, leading zeroes, currency and date text; do not infer numeric conversions or fuzzy matches.
2. For CSV/TSV, use `plugin__kiki_work__table_audit` on the selected keys, then `plugin__kiki_work__table_compare` on the two files. For Excel, use the available Office tools to inspect the relevant sheets and create CSV copies in the workspace before comparing; keep sheet names and original row references in the report. Do not overwrite the workbook or export every sheet without need.
3. Treat blank or duplicate keys as unresolved evidence, not a successful one-to-one join. Show the affected source rows. `complete:false` means the report must identify these exclusions. If the file is too large for the tool, process explicit chunks while preserving the same key policy, or return the size limit with a practical split; do not claim the first chunk represents the full table.
4. Read every result page needed for the report using `has_more` and `next_offset`. The table tools are exact read-only checks, not semantic judgment: decide from the source whether a change is expected, unresolved or erroneous. Never invent why a value changed.
5. Write the requested report as a new Markdown/CSV artifact, or create an editable Word/Excel deliverable using the enabled Office tools. Include input filenames and sheets, chosen keys, row counts, added/removed/changed counts, duplicate/blank-key exclusions and the concrete changed fields. Keep unchanged rows out of the summary, and preserve detailed row evidence in the artifact.
6. Preview the generated artifact with the available file preview or Office preview tool and inspect its headings, table readability and at least one known changed row. Report the output path and unresolved records. Missing Office tools do not prevent a Markdown/CSV report; use that result instead of claiming an Office file was created.

The workflow ends with the requested artifact and its inspected result. Sending invoices, updating systems of record and overwriting source files require separate explicit authorization. Scheduling and task tracking use Kiki's existing tasks and board; do not create a second task store for a table comparison.

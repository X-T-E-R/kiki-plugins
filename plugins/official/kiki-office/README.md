# Kiki Office Suite

Create, read, edit and preview local Word (`.docx`), Excel (`.xlsx`) and
PowerPoint (`.pptx`) files from a Kiki session. The plugin drives a pinned
copy of [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI); it does not
include the engine itself.

## Install and use

Install the plugin from Kiki's plugin market (or this directory with
`/plugins install --trust ./plugins/official/kiki-office`) and enable it.

The tools need **OfficeCLI 1.0.152**. After installation, Kiki shows a
prerequisite card, "Install officecli?". Choosing it downloads that exact
version from the official release, checks the release's SHA-256 manifest and
the binary checksum, and saves the binary in the plugin's data folder. Nothing
is downloaded without that explicit consent, and the tools never download
executables themselves. The pinned binary exists for Windows x64, macOS arm64
and Linux x64. To use a copy you installed yourself, set **OfficeCLI
executable** (`officecliPath`) in the plugin settings; a different version is
reported as `VERSION_MISMATCH`.

Then ask Kiki for the document you need, for example:

> Create `reports/october.docx` with a heading and a table of the changed rows.

## Tools

| Tool | What it does |
| --- | --- |
| `office_create` | Create a blank `.docx`, `.xlsx` or `.pptx`. Never overwrites an existing file |
| `office_view` | Bounded text, annotated, outline, stats or issues overview |
| `office_get` / `office_query` | Read one node by semantic path, or find nodes by selector |
| `office_add` / `office_set` / `office_remove` | Add, change or remove one element |
| `office_batch` | Apply 1–32 edits atomically; any failure rolls back the batch |
| `office_preview` | Render one page as PNG when the model accepts images; otherwise a text outline |

Paths are workspace-relative unless you approve an absolute path through Kiki.
Editing tools first check the package and refuse encrypted, oversized or
unknown embedded parts instead of risking a damaged document. Read results are
capped at 200 rows, 200 cells and 16 KiB and say when they are truncated.

## Tests

`node --test test/office.test.mjs` runs the manifest, consent, checksum, path
and package-safety tests. The Word, Excel and PowerPoint chains need
`OFFICECLI_TEST_BINARY` pointing to the pinned executable; without it those
tests are skipped.

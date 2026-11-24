# Kiki Office Suite

Create, inspect, edit, validate and preview local Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`) files from a Kiki session. The plugin drives a pinned copy of [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI); it does not bundle the executable itself.

## Install and use

Install the plugin from Kiki's plugin market (or this directory with `/plugins install --trust ./plugins/official/kiki-office`) and enable it.

The tools require **OfficeCLI 1.0.163**. After installation, Kiki prompts to install the pinned binary (`Install officecli?`). Approving downloads that exact release, verifies both the pinned `SHA256SUMS` manifest digest and the binary SHA-256, and stores it in the plugin's data folder. Nothing is downloaded without explicit consent, and tools never download executables themselves. Pinned binaries are available for Windows x64/arm64, macOS arm64/x64, and Linux x64/arm64. To use your own executable, set **OfficeCLI executable** (`officecliPath`) in plugin settings; a different version is reported as `VERSION_MISMATCH`.

## Tools

| Tool | What it does |
| --- | --- |
| `office_create` | Create a blank `.docx`, `.xlsx` or `.pptx`. Never overwrites an existing file |
| `office_view` | Bounded `text`, `annotated`, `outline`, `stats` or `issues` overview (`range`, `cols`, `issueType`, structured JSON up to 500 rows / 2000 cells) |
| `office_get` / `office_query` | Read one node by semantic path (`depth` 0–3), or find nodes by selector (JSON or `--compact` with `--fields`) |
| `office_add` / `office_set` / `office_remove` | Add or clone (`before`/`after`/`index`/`from`), modify properties or find/replace, or remove an element |
| `office_batch` | Apply 1–128 `add`, `set`, `remove`, `move`, `swap`, `get`, `query` or `validate` commands atomically; any failure rolls back |
| `office_preview` | Render a single page or a 1–12 page thumbnail contact sheet (`pages`, `grid`, `range`, `render`) as PNG when image input is supported; otherwise return an outline |
| `office_validate` | Validate an existing document against the OpenXML schema and return bounded structured findings |
| `office_help` | Query the pinned OfficeCLI schema reference for `docx`, `xlsx` or `pptx` elements without opening a file |
| `office_import` | Import a local `.csv` or `.tsv` file (up to 16 MiB) into an existing `.xlsx` sheet without modifying the source |

## Security & limits

Paths are workspace-relative unless explicitly approved through Kiki. Every tool that opens an existing Office document (reads, validation, preview, import target, and edits) first runs a streaming OOXML package guard across the outer archive and depth-1 chart workbooks (`word/embeddings/*.xlsx`, `ppt/embeddings/*.xlsx`) under one shared budget (256 MiB input/expansion, 64 MiB per part, 10,000 entries, 2 MiB central directory per archive, 200:1 expansion ratio). Encrypted entries, ZIP64, path traversal, local/central header mismatches, CRC mismatches, DTD/XXE XML, VBA macros, ActiveX, OLE objects, depth `>1` archives, and unsafe external relationships are rejected before invoking OfficeCLI.

## Tests

`node --test test/office.test.mjs` runs the manifest, consent, checksum, path, schema, and package-guard tests. Setting `OFFICECLI_TEST_BINARY` to a verified OfficeCLI 1.0.163 executable additionally runs the live Word, Excel, PowerPoint, import, validation, help, and contact-sheet integration suites.

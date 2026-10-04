# Kiki Extract

Convert a local PDF, Office, HTML, or text file into Markdown that Kiki can
read and search. It gives you the extracted text; it does not replace Kiki's
`Read` tool or build a document index of its own.

## Install and use

Install this directory through Kiki's plugin installer, then enable
`kiki-extract`. In the TUI:

```sh
/plugins install --trust ./plugins/official/kiki-extract
/plugins enable kiki-extract
```

Kiki's Node.js host must be 24.15 or later. Everything the plugin needs is in
the package — there is no runtime `npm install` and no local skill path to
configure.

HTML, Markdown, and plain text work immediately. PDF and Office formats need a
Python 3.10+ environment you prepare yourself, with MarkItDown's matching
format extras; point the plugin at it with the `pythonPath` setting. See
[one-time setup](skills/documents/references/setup.md). The plugin installs no
system software and no pip packages.

Ask Kiki to extract or summarize a local file, or load the `documents` skill:

> Extract `reports/summary.pdf` into a new `materials/summary` folder, read the result and summarize its main findings.

The `documents_extract` tool takes a `file` and a **new** `outputDir`. It writes
`document.md`, `extraction.json`, and whatever assets the engine actually
produced, then returns the source, engine, warnings, and a preview. Read the
real text from the returned `markdownPath` with `Read` or `Grep`. Source files
and existing outputs are never overwritten. Paths inside the workspace work
directly; a path outside it needs Kiki's usual approval.

## Formats and engines

| Input | Default processing | What to expect |
| --- | --- | --- |
| `.md`, `.markdown`, `.txt` | Direct, local | Text preserved |
| `.html`, `.htm` | Defuddle, local | Readable article Markdown; linked images are not downloaded |
| `.pdf`, `.docx`, `.xlsx`, `.xls`, `.pptx` | MarkItDown, local | Matching Python format extras required; Markdown only, no exported images |
| Scanned PDF; JPEG/PNG | Explicit MinerU | Upload authorization and account required; real assets come from its result archive |

The automatic engine never uploads a file and never runs OCR, so a scanned PDF
comes back nearly empty — ask for MinerU explicitly in that case. An extraction
that finds nothing is an error, not an empty document; a partly scanned PDF
returns text from whichever pages have it, so check what you got. Legacy
`.doc`/`.ppt`, arbitrary binaries, URLs, directories, and web search are not
inputs. This is extraction, not Office editing, so complex layout fidelity is
whatever the engine produces.

**MinerU uploads your file to a third-party cloud service** and bills that
service's account. It runs only when you pass both `engine=mineru` and
`allowUpload=true` and supply credentials in settings or the standard
environment; there is no automatic fallback if it fails. Cancelling on your
side does not cancel the remote job. Set `nbExtractPath` to point at a separate
copy of the pinned official package if you need one; leaving it empty always
uses the copy bundled here.

Input is capped at 50 MiB and 600 seconds. The returned preview is 4,000
characters by default — raise it with `previewChars`, up to 16,000 — and is
marked when it truncates. The saved Markdown is always complete. Hitting the
byte limit fails rather than reporting a partial conversion as complete, so
inspect whatever landed in `outputDir` before retrying into a fresh directory.

## Rebuilding the bundled extractor

The checked-in `vendor/` unit is built from the pinned npm package and
lockfile; no engine logic is maintained in this repository. To regenerate it,
from this plugin directory:

```sh
npm --prefix runtime ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
node scripts/build-vendor.mjs
node scripts/sync-manifest.mjs
node --test test/documents.test.mjs
```

`runtime/node_modules` is development-only and is not needed in installed
packages. `build-vendor.mjs` bundles the public ESM API, keeps the original
Python bridge, and regenerates
[third-party notices](THIRD_PARTY_NOTICES.md). The standard nb-extract,
Defuddle, and most JavaScript dependencies are MIT; LinkeDOM is ISC and other
dependencies keep their listed licenses. Python/MarkItDown is installed
separately; MinerU is a service, not bundled software.

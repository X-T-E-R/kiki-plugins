---
name: everything-search
description: Use when asked to find local Windows files and folders across disks by name, path, extension, size or modification time, including large files and recent changes. Keep Glob for repository glob patterns and Grep for file contents.
---

# Everything Search

Use `plugin__kiki_everything__search` for indexed file/directory discovery on the local Windows machine. It uses the running Everything 1.5 client and official ES CLI; no HTTP service or Python is needed.

## Choose the search

- “Find my report anywhere on disk”: search the relevant drive root, such as `root="C:/"`, with `query="report ext:pdf"`.
- “Find the largest videos”: use `query="ext:mp4;mkv size:>1gb"`, `type="file"`, `sort="size-descending"`, and the requested `limit`.
- “What changed today?”: use `query="dm:today"`, `type="file"`, `sort="date-modified-descending"`.
- “Find a folder named 项目资料”: use `query="项目资料"`, `type="directory"`.
- Repository patterns such as `src/**/*.ts`: continue using **Glob**, including its ignore-file semantics.
- Text inside files, matching lines and context: continue using **Grep**. This tool rejects content and non-index property functions.

## Query and scope

`root` is required. It accepts a workspace-relative directory or an absolute directory/volume. Kiki admits that root before execution; results stay beneath its canonical target. To search multiple drives, call once per drive; independent searches can run in parallel. The plugin runs up to four ES processes per host and queues additional calls without returning `ES_BUSY`. Do not add broad permanent permissions to make a query succeed.

Spaces between terms mean AND. Quote a phrase (`"annual report"`) or the path part of an expression (`path:"C:\\My Documents"`). Supported functions include name, path, ext, size and dm; size examples: `size:>100mb`, `size:1gb..5gb`; dates: `dm:today`, `dm:2026-10-01..2026-10-31`. Filters and sorting use the Everything index. Returned size/time metadata is read from admitted local paths and can differ from a changing index.

## Continue and interpret

Use `pagination.next_offset` unchanged for the next page. The offset and limit apply to raw index rows **before** path, sensitive and VCS filtering; a short or empty filtered page may still have a next page. `pagination.total` is null because the final visible total is unknown. Pages are live queries, not a frozen snapshot.

An empty result only means this index query yielded no visible paths: excluded, offline, unindexed or newly changed items can be absent. Sensitive files and `.git/.svn/.hg/.bzr/.jj/.sl` paths are omitted. Normal repository ignore files are not applied; use Glob when those semantics matter. Use Read/Grep for subsequent file access under their own admission rules.

## Recover

- `ES_NOT_FOUND`: install `winget install --id voidtools.Everything.Cli -e`, or set the plugin's `esPath` to the official ES executable's absolute path. Discovery order is setting, PATH, current-user WinGet packages.
- Connection error: start the Everything **desktop client**, not just its service. Leave `instance` empty unless a named instance is actually used; the plugin never switches indexes automatically.
- Timeout: queue time counts toward the wait limit. If the search itself timed out, narrow the root, name or extension and retry. Cancellation and timeout stop only that call's ES process; other searches continue. Everything may still finish the abandoned query internally.

# kiki-error-pulse

Non-blocking incremental error telemetry and retry-streak radar for Kiki sessions.

## Capabilities

- **Zero-preemption background beat**: delays initial scan after startup (`setTimeout(...).unref()`), runs incremental ticks (`setInterval(...).unref()`), yields cooperatively via `setImmediate`, and enforces a single-flight lock plus per-tick byte budget.
- **O(1) unchanged skip & tail byte cursors**: skips unchanged `wire.jsonl` files with zero file reads, bounds cold large files (`> 4 MiB`) to their trailing `2 MiB`, and resumes strictly on newline boundaries across `256 KiB` chunks.
- **Normalized redacted signatures & retry streaks**: strips wrapper noise, extracts `Bash` exit codes and primary diagnostic lines, redacts credentials as `<REDACTED>`, tracks `CallTool:<name>` failure rates, and flags consecutive same-tool retry streaks (`>= 2`).
- **Workspace panel & native tool**: provides the `报错雷达` workspace panel (`panel.html`) and `error_pulse_report` tool (`summary`, `scan_now`, `top_signatures`, `streaks`, `samples`).

## Local install

```sh
/plugins install --trust ./plugins/kiki-error-pulse
/plugins enable kiki-error-pulse
```

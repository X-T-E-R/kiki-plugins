---
name: error-pulse
description: Inspect recurring tool failures, normalized error signatures, retry streaks, and lifecycle errors across Kiki sessions with error_pulse_report. Use when diagnosing repeated tool failures, checking recent error trends, auditing token-wasting retry loops, or triaging workspace stability.
---

# Error Pulse (`error_pulse_report`)

Use `plugin__kiki_error_pulse__error_pulse_report` to inspect recurring tool failures, retry streaks, and session lifecycle anomalies from the persisted incremental index without reading raw `wire.jsonl` logs by hand.

## Workflow

1. **Read cached telemetry first (`action: "summary"`)**:
   - Returns window totals, high-error tools, lifecycle anomalies (`provider.error`, `turn.failed`, `subagent.failed`, `task.failed`), top normalized signatures, and retry streaks (`windowHours` defaults to `168`; pass `24` or `720` as needed).
2. **Scan tail logs only when up-to-the-second counts matter (`action: "scan_now"`)**:
   - Runs a single-flight incremental byte-cursor scan over changed `wire.jsonl` files (unchanged files skip in O(1) with zero reads) and returns `scanDurationMs`, `filesScanned`, `filesSkippedUnchanged`, `bytesRead`, and `budgetPaused`.
3. **Drill into a specific cluster (`action: "samples"` or `action: "streaks"`)**:
   - Pass `signatureId` from `topSignatures` to `action: "samples"` to inspect up to 5 redacted samples (`workspace`, `sessionId`, `agentId`, `argsPreview`, `errorPreview`).
   - Pass `action: "streaks"` (with optional `toolFilter` such as `"Bash"` or `"CallTool:..."`) to locate consecutive same-tool retry walls (`>= 2` back-to-back errors in one session).

## Operating rules

- All signatures and sample previews redact API keys, bearer tokens, and JWTs as `<REDACTED>` and normalize OS paths, UUIDs, hex addresses, and timestamps. Never attempt to reconstruct redacted credentials.
- When `budgetPaused: true` is returned on `scan_now`, the per-tick byte budget paused cleanly on a newline cursor; repeat `scan_now` only when full historical catch-up is needed immediately.

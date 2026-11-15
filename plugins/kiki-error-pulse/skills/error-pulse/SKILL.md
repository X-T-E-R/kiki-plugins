---
name: error-pulse
description: Inspect recurring tool failures, normalized error signatures, retry streaks, and lifecycle errors across Kiki sessions with error_pulse_report. Use when diagnosing repeated tool failures, checking recent error trends, auditing token-wasting retry loops, or triaging workspace stability.
---

# Error Pulse (`error_pulse_report`)

Use `plugin__kiki_error_pulse__error_pulse_report` to inspect recurring tool failures, retry streaks, and session lifecycle anomalies without scanning raw `wire.jsonl` files by hand.

## When to call

- A tool, MCP server (`CallTool:<name>`), or shell workflow has been failing repeatedly and you want to see whether the issue is systemic or isolated.
- The user asks for recent workspace/session failure rates, flaky tools, provider retry spikes, or token-wasting retry loops.
- Before modifying shared tooling, hooks, or agent instructions to address recurring errors, check actual counts and sanitized samples first.

## Recommended sequence

1. **Read cached telemetry first (`action: "summary"`)**:
   - Returns totals, high-error-rate tools, lifecycle anomalies, top normalized signatures, and retry streaks in milliseconds from the persisted incremental index (`windowHours` defaults to `168` = 7 days; pass `24` for 24h or `720` for 30d).
2. **Refresh tail logs only when fresh up-to-the-second counts matter (`action: "scan_now"`)**:
   - Runs a single-flight incremental byte-cursor scan over changed `wire.jsonl` files (unchanged files are skipped in O(1) with zero bytes read) and returns `scanDurationMs`, `filesScanned`, `filesSkippedUnchanged`, and `bytesRead`.
3. **Drill into one cluster (`action: "samples"` or `action: "streaks"`)**:
   - Pass `signatureId` from `topSignatures` to `action: "samples"` to inspect up to 5 redacted recent samples (`workspace`, `sessionId`, `agentId`, `argsPreview`, `errorPreview`).
   - Pass `action: "streaks"` (optionally with `toolFilter`, e.g. `"Bash"` or `"CallTool:..."`) to locate consecutive same-tool retry walls (`>= 2` back-to-back errors in one session).

## Boundaries

- Signatures and previews automatically redact API keys, bearer tokens, and JWTs as `<REDACTED>` and normalize paths/UUIDs/IDs; do not attempt to reconstruct redacted credentials.
- `budgetPaused: true` on `scan_now` means the single-tick byte cap was reached cleanly; repeat `scan_now` only if complete catch-up is required immediately.

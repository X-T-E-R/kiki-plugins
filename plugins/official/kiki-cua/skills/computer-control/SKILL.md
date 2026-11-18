---
name: computer-control
description: Operate local desktop displays, windows, and cross-plugin remote computer-use targets through Kiki Computer Use (kiki-cua). Use when inspecting desktop applications, clicking or typing in native GUI software, operating secondary monitors, or controlling remote desktop targets registered via kiki.cua.provider.v1. Not for logged-in web tabs with native browser tools or Android/iOS phones.
---

# Computer Control (`kiki-cua`)

## 1. Tool Selection & Pre-Checks

| Task | Tool | Notes |
| --- | --- | --- |
| Discover/select monitor or remote target; toggle Takeover | `cua_targets` | `list` inspects `local:primary`, `local:monitor-*`, `local:window:<hwnd>`, and remote `kiki.cua.provider.v1` targets (e.g. `uu:*`). `select` persists `targetId`. |
| Screenshot, high-DPI zoom crop, grid/SoM overlay | `cua_observe` | Default coordinate space is `normalized_1000` (`0..1000`). Pass `zoom: { x, y, width, height }` to crop native full-res pixels before downscaling. |
| Mouse, keyboard, drag, scroll, wait, clipboard | `cua_act` | Batch `1..16` deterministic actions on one screen (`observeAfter: true` returns the settled screenshot). |
| Local window lookup, focus, restore, pin | `cua_windows` | `list` with `query` finds HWND/DPI/elevation; `focus`/`restore` with `pinTarget: true` registers `local:window:<hwnd>`. |

## 2. Precision & Batching Rules

1. **Zoom dense high-DPI controls before clicking**: On 4K / 150%+ DPI displays, toolbars, timeline scrubbers, or dense tables, call `cua_observe({ zoom: { x, y, width, height }, overlay: "grid" })` first, then run `cua_act` with `zoomRelative: true` (or full-screen `zoomRelative: false`).
2. **Coalesce predictable same-screen actions**: Combine click -> `Ctrl+A` -> `type` (`submit: true`) into one `cua_act` call (`settleMs: 180..250`). Stop the batch at dialog or page transitions and verify the returned screenshot before continuing.
3. **Text entry**: `mode: "auto"` injects short ASCII via UTF-16 `KEYEVENTF_UNICODE` and uses `Win+V`-excluded clipboard backup/paste for multiline or CJK text.

```json
{
  "actions": [
    { "kind": "click", "x": 420, "y": 310 },
    { "kind": "key", "key": "Ctrl+A" },
    { "kind": "type", "text": "quarterly_summary_v2", "submit": true }
  ],
  "observeAfter": true,
  "settleMs": 220
}
```

## 3. Failure Recovery

- **`human_takeover_active`**: Engaged when the user turns on **Takeover Control** in the `Computer Preview` workspace panel or moves the physical mouse beyond `takeoverThresholdPx` (`48px` default).
  - **Next step**: Stop immediately with `0` retries. Report what paused and wait for explicit user confirmation before calling `cua_targets({ action: "takeover", takeoverActive: false })` or setting `overrideHumanTakeover: true`.
- **`uipi_elevated_window`**: Windows UIPI blocks standard-integrity `SendInput` into elevated Administrator windows.
  - **Next step**: Do not retry clicks on that window. Report `window.title` / `processName` / `pid` and ask the user to complete the elevated prompt manually, relaunch the target app without elevation, or switch focus via `cua_windows`.
- **Unknown or offline remote target (`uu:*`)**: Run `cua_targets({ action: "list" })`; if the remote provider session closed or minimized, restore/reconnect it via its provider tool (`uu_sessions` / `uu_launch` / `uu_control({ action: "restore" })`) before resuming `cua_observe`.
- Never submit payments, destructive deletions, or external publications without explicit user confirmation.

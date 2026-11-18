---
name: computer-control
description: Operate local desktop displays, windows, and cross-plugin remote computer-use targets through Kiki Computer Use (kiki-cua). Use when inspecting desktop applications, clicking or typing in native GUI software, operating secondary monitors, or controlling remote desktop targets registered via kiki.cua.provider.v1. Not for logged-in web tabs with native browser tools or Android/iOS phones.
---

# Computer Control (`kiki-cua`)

Operate local displays (`local:primary`, `local:monitor-0`, `local:monitor-1`, ...), pinned windows (`local:window:<hwnd>`), and companion Remote Display/Input Target Providers (such as `uu:*` targets registered over `kiki.cua.provider.v1`) through four orthogonal tools: `cua_targets`, `cua_observe`, `cua_act`, and `cua_windows`.

## 1. Pick and Persist the Right Surface

1. Call `cua_targets({ action: "list" })` when starting a task involving multiple monitors or a remote desktop provider.
2. Call `cua_targets({ action: "select", targetId })` once to bind the intended surface (`local:primary` vs `local:monitor-1` vs `uu:<id>`). The selected `targetId` persists across subsequent `cua_observe` and `cua_act` calls.
3. For background or multi-window local desktop work, use `cua_windows({ action: "list", query: "..." })` to locate a window by title or process name, then `cua_windows({ action: "focus", hwnd, pinTarget: true })` to bring it forward or pin `local:window:<hwnd>` for window-scoped capture.

## 2. Observe First and Zoom Dense High-DPI Controls

- Default coordinate space is **`normalized_1000`** (`0..1000` along target width and height), independent of physical resolution, negative multi-monitor offsets, or downscaled PNG size.
- Start with `cua_observe({})` to inspect the full surface (`maxWidth: 1280` default).
- **High-DPI precision rule**: before clicking dense toolbar icons, timeline handles, table cells, or 4K/200%+ small controls, capture a native-resolution crop first:
  ```json
  {
    "zoom": { "x": 720, "y": 40, "width": 260, "height": 180 },
    "overlay": "grid"
  }
  ```
  `zoom` crops directly from the full-resolution native framebuffer *before* bicubic scaling.
- On the follow-up `cua_act`, either:
  - pass `zoomRelative: true` to address `(0..1000, 0..1000)` *inside* that zoomed crop, OR
  - keep `zoomRelative: false` (default) to address `(0..1000, 0..1000)` across the full target.
- Use `overlay: "som"` or `includeAccessibility: true` when standard native controls expose UI Automation bounds and exact `[1]`, `[2]` badges speed up targeting.

## 3. Batch Deterministic Micro-Actions

Coalesce predictable same-screen sequences into one `cua_act` call (`1..16` actions) with `observeAfter: true` (default, `settleMs: 180`) so click + type + submit + verification screenshot complete in a single model turn:

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

- `type` with `mode: "auto"` uses direct UTF-16 `KEYEVENTF_UNICODE` events for short ASCII strings and automatically switches to backup/restore clipboard paste (excluded from `Win+V` clipboard history and cloud sync) for multiline or CJK text.
- Never chain blind clicks across screen transitions or modal dialogs that have not rendered yet; stop the batch at the transition boundary and inspect the returned post-action screenshot.

## 4. Respect Human Takeover & UIPI Boundaries

- **`human_takeover_active`**: Triggered either when the user clicks **Takeover** / interacts directly inside the `Computer Preview` workspace panel, or when the physical OS mouse moves `> takeoverThresholdPx` (default `48px`) away from the last synthetic agent cursor position.
  - **Stop immediately with `0` blind retries.** Inform the user what paused and wait for their go-ahead before releasing takeover (`cua_targets({ action: "takeover", takeoverActive: false })`) or passing `overrideHumanTakeover: true`.
- **`uipi_elevated_window`**: On Windows, a standard-integrity process cannot inject `SendInput` into an elevated Administrator window (UIPI). Report the elevated window name/PID clearly rather than retrying clicks that the OS kernel will drop.
- Do not submit irreversible financial payments, destructive deletions, or external publications without explicit user confirmation.

---
name: uu-remote
description: Discover, connect, preview, and operate NetEase UU Remote (UU远程 / GameViewer) remote desktop sessions and paired uuyc-cli devices. Use when the user asks to view or control a remote PC/Mac over UU Remote, connect or disconnect a paired UU Remote workstation, rescue an off-screen GameViewer window, or inspect UU Remote sessions.
---

# UU Remote Control (`kiki-uu-remote`)

## Tool Selection

| Goal | Tool & Call |
| --- | --- |
| List open `uu:<hwnd>` windows & paired devices | `uu_sessions({ action: "list" })` (add `includeTerminals: true` only when inspecting `uuyc-cli term`) |
| Check client/CLI paths, URI registration, or CUA bus lease | `uu_status({ includeCliStatus: true })` |
| Connect / disconnect a paired workstation or rescue windows | `uu_launch({ action: "connect_device" \| "disconnect_device" \| "open_client" \| "recover_offscreen", deviceId })` |
| Screenshot, zoom crop, or inject mouse/keyboard/clipboard | `uu_control({ sessionId, action, actions, zoom, coordinateMode: "normalized_1000" })` |

## Pre-Flight & Execution Rules

1. **Inspect sessions first**: Call `uu_sessions()` before acting if you do not already have a live `uu:<hwnd>` ID. Never omit `deviceId` on `disconnect_device` (blocked to protect sibling sessions).
2. **Zero-focus 1:1 coordinates**: `uu_control({ action: "screenshot" })` captures the inner `GameViewer` render stage via `PrintWindow(PW_RENDERFULLCONTENT)` without stealing focus and trims symmetric letterbox/pillarbox black bars automatically. Keep `coordinateMode: "normalized_1000"` (`(0, 0)` top-left to `(1000, 1000)` bottom-right of the trimmed remote desktop).
3. **Zoom dense UI before clicking**: Pass `zoom: { x, y, width, height }` in `normalized_1000` to read small menus, table cells, or toolbar icons at native stream resolution.
4. **Batch clear steps**: Combine deterministic sequences in `actions: [...]` (e.g., click field -> `type` -> `submit: true`) with `observeAfter: true`, and verify the returned screenshot before repeating a state-changing action. Never submit payments, destructive deletions, or external publications without explicit user confirmation.

## Failure Recovery

- **No open session**: Call `uu_sessions({ action: "list" })` to find online `pairedDevices`, then call `uu_launch({ action: "connect_device", deviceId: "<id>" })` (or `action: "open_client"` if unpaired).
- **`state: "minimized"`**: Minimized Qt stages cannot render `PrintWindow` frames. Run `uu_control({ sessionId, action: "restore" })` before capturing or sending input.
- **`state: "offscreen"`**: Unplugged external monitors can leave `GameViewer` off-screen. Run `uu_launch({ action: "recover_offscreen" })` to move stranded windows onto the primary work area without stealing focus.
- **`Ctrl+Alt+*` shortcut rejected**: `Ctrl+Alt+{Enter,G,F,P,U,Left,Right}` triggers UU Remote's local overlay/fullscreen UI rather than the remote OS. Use remote OS equivalents or menus; pass `allowClientHotkey: true` only when intentionally toggling the local client.
- **`human_takeover_active` (HTTP 409)**: The user engaged **Takeover Control** in the UU Remote workspace panel or moved the physical mouse past `takeoverThresholdPx`. Stop immediately and yield to the user—never set `overrideHumanTakeover: true` unless the user explicitly asks you to resume.

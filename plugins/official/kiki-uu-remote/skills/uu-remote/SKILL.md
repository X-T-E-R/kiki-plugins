---
name: uu-remote
description: Discover, connect, preview, and operate NetEase UU Remote (UU远程 / GameViewer) remote desktop sessions and paired uuyc-cli devices. Use when the user asks to view or control a remote PC/Mac over UU Remote, connect or disconnect a paired UU Remote workstation, rescue an off-screen GameViewer window, or inspect UU Remote sessions.
---

# UU Remote Control (`kiki-uu-remote`)

Operate NetEase UU Remote (`GameViewer.exe` + official `uuyc-cli`) remote desktop sessions cleanly with zero-focus background observation, 1:1 black-bar-trimmed coordinates, and cooperative Human Takeover safety.

## 1. Discover Sessions & Paired Devices

1. Call `uu_sessions` (default `action: "list"`) to inspect:
   - Open streaming windows (`id: "uu:<hwnd>"`, `label`, `state: "active" | "minimized" | "offscreen"`, `canvasBounds`, `contentRect`, `dpi`, `takeoverActive`).
   - Paired online/offline workstations from `uuyc-cli device list --json` and `uuyc-cli device status --json`.
   - Pass `includeTerminals: true` when you also need `uuyc-cli term -d <deviceId> ls --json` remote terminal sessions.
2. Call `uu_status` when diagnosing local installation paths (`GameViewer.exe`, `uuyc-cli`), `uuremote://` URI registration, `uuyc-cli status --json`, or `kiki.cua.provider.v1` bus lease health.

## 2. Connect, Recover, or Restore Before Acting

- **Connect a paired device**: If no streaming window is open for the target machine (for example `"Remote Mac Studio"` or `"Office Workstation"`), call `uu_launch({ action: "connect_device", deviceId: "<device_id>" })`.
- **Disconnect a specific device**: Call `uu_launch({ action: "disconnect_device", deviceId: "<device_id>" })`. **Always** pass an explicit non-empty `deviceId`—disconnecting without an ID is blocked so sibling sessions are never dropped.
- **Off-screen window (`state: "offscreen"`)**: Multi-monitor unplugging can leave `GameViewer` outside connected displays. Run `uu_launch({ action: "recover_offscreen" })` to center stranded windows onto the primary monitor's work area without stealing focus.
- **Minimized window (`state: "minimized"`)**: Minimized `Qt` windows cannot render `PrintWindow` frames. Run `uu_control({ sessionId, action: "restore" })` before capturing or clicking.

## 3. Observe & Act with Precision

- **Zero-focus observation**: `uu_control({ sessionId, action: "screenshot" })` captures the hardware-decoded D3D11 visual tree via `PrintWindow(PW_RENDERFULLCONTENT)` in the background without stealing window focus, crops to the inner `GameViewer` stage HWND (excluding the outer UU Remote header bar), and trims symmetric letterbox/pillarbox black bars automatically.
- **Zoom into dense UI**: Pass `zoom: { x, y, width, height }` in `normalized_1000` (or `target_pixels`) to inspect small text, menus, or icons at native stream resolution before clicking.
- **1:1 Coordinate Mapping**: Keep `coordinateMode: "normalized_1000"` (`[0..1000]` across the trimmed remote desktop). Because black bars and the top UU Remote title bar are already stripped, `(0, 0)` is the remote desktop's top-left corner and `(1000, 1000)` is its bottom-right corner—even on negative multi-monitor coordinates or 225% DPI displays.
- **Coalesce clear actions, verify outcomes**: Batch deterministic steps via `actions: [...]` (for example click input -> `type` -> `submit: true`) with `observeAfter: true`, and inspect the returned screenshot before repeating any modifying action.
- **Avoid `Ctrl+Alt+*` local shortcuts**: `Ctrl+Alt+{Enter,G,F,P,U,Left,Right}` triggers UU Remote's local client overlay/fullscreen controls instead of the remote OS, and is blocked by default unless `allowClientHotkey: true` is explicitly requested.

## 4. Respect Human Takeover & High-Stakes Boundaries

- If the user clicks **Takeover** in the UU Remote workspace panel or physically moves the mouse beyond `takeoverThresholdPx` during active control, `uu_control` returns `code: "human_takeover_active"`.
- **Stop immediately** when `human_takeover_active` is reported—do not set `overrideHumanTakeover: true` unless the user explicitly instructs you to resume control. Never submit payments, destructive deletions, or external publications on a remote workstation without explicit user confirmation.

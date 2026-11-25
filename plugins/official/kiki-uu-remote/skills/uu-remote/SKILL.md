---
name: uu-remote
description: Discover, connect, preview, and operate NetEase UU Remote (UU远程 / GameViewer) desktop sessions, paired uuyc-cli devices, and Proxmox VE QEMU VM desktops over SSH + QMP (pve:<ssh_host>:<vmid>). Use when the user asks to view or control a remote PC/Mac over UU Remote or a Proxmox VE VM desktop, connect or disconnect a remote target, rescue an off-screen GameViewer window, or inspect remote sessions.
---

# UU Remote Control (`kiki-uu-remote`)

## Tool Selection

| Goal | Tool & Call |
| --- | --- |
| List open `uu:<hwnd>` windows, registered `pve:<ssh_host>:<vmid>` VMs & paired devices | `uu_sessions({ action: "list" })` (add `includeTerminals: true` only when inspecting `uuyc-cli term`) |
| Check client/CLI paths, URI registration, registered PVE targets, or CUA bus lease | `uu_status({ includeCliStatus: true })` |
| Connect / disconnect a paired UU workstation, register/remove a Proxmox VE VM, or rescue windows | `uu_launch({ action: "connect" \| "disconnect" \| "connect_device" \| "disconnect_device" \| "open_client" \| "recover_offscreen", deviceId })` (PVE accepts `deviceId: "pve:<ssh_host>:<vmid>"` or `pveHost` + `vmid`) |
| Screenshot, zoom crop, or inject mouse/keyboard/clipboard | `uu_control({ sessionId, action, actions, zoom, coordinateMode: "normalized_1000" })` |

## Pre-Flight & Execution Rules

1. **Inspect sessions first**: Call `uu_sessions()` before acting if you do not already have a live `uu:<hwnd>` or `pve:<ssh_host>:<vmid>` ID. Never omit `deviceId` on `disconnect` / `disconnect_device` (blocked to protect sibling sessions).
2. **Zero-focus 1:1 coordinates**: `uu_control({ action: "screenshot" })` captures `GameViewer` stages via `PrintWindow` (trimming symmetric black bars automatically) or Proxmox VE VM framebuffers directly via QMP `screendump` over SSH. Keep `coordinateMode: "normalized_1000"` (`(0, 0)` top-left to `(1000, 1000)` bottom-right); PVE targets map coordinates onto QEMU USB Tablet `[0..32767]` absolute events automatically.
3. **Zoom dense UI before clicking**: Pass `zoom: { x, y, width, height }` in `normalized_1000` to read small menus, table cells, or toolbar icons at native stream resolution.
4. **Batch clear steps**: Combine deterministic sequences in `actions: [...]` (e.g., click field -> `type` -> `submit: true`) with `observeAfter: true`, and verify the returned screenshot before repeating a state-changing action. Never submit payments, destructive deletions, or external publications without explicit user confirmation.

## Failure Recovery

- **No open session**: Call `uu_sessions({ action: "list" })` to find online `pairedDevices` or registered PVE VMs, then call `uu_launch({ action: "connect", deviceId: "<id or pve:host:vmid>" })` (or `action: "open_client"` if unpaired).
- **`state: "minimized"`**: Minimized Qt stages cannot render `PrintWindow` frames. Run `uu_control({ sessionId, action: "restore" })` before capturing or sending input.
- **`state: "offscreen"`**: Unplugged external monitors can leave `GameViewer` off-screen. Run `uu_launch({ action: "recover_offscreen" })` to move stranded windows onto the primary work area without stealing focus.
- **`Ctrl+Alt+*` shortcut rejected (UU Remote)**: `Ctrl+Alt+{Enter,G,F,P,U,Left,Right}` triggers UU Remote's local overlay/fullscreen UI rather than the remote OS. Use remote OS equivalents or menus; pass `allowClientHotkey: true` only when intentionally toggling the local client. (Proxmox VE QMP targets do not have a local overlay and pass `Ctrl+Alt+*` straight to the guest.)
- **`human_takeover_active` (HTTP 409)**: The user engaged **Takeover Control** in the UU Remote workspace panel or moved the physical mouse past `takeoverThresholdPx`. Stop immediately and yield to the user—never set `overrideHumanTakeover: true` unless the user explicitly asks you to resume.

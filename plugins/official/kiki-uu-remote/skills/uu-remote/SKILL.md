---
name: uu-remote
description: Discover, connect, preview, and operate NetEase UU Remote (UU远程 / GameViewer) sessions, Proxmox VE QEMU VMs (RFB 3.8 over SSH vncproxy with QMP/QGA fallback), and direct or SSH-tunneled VNC desktops (vnc:<host>:<port>). Use when viewing or controlling a remote desktop, connecting or disconnecting targets, rescuing off-screen GameViewer windows, or syncing remote clipboards.
---

# UU Remote Control (`kiki-uu-remote`)

## Tool Selection

| Goal | Tool & Call |
| --- | --- |
| List open `uu:<hwnd>` windows, `pve:<ssh_host>:<vmid>` VMs, `vnc:<host>:<port>` targets, and paired devices | `uu_sessions({ action: "list" })` (add `includeTerminals: true` only when inspecting `uuyc-cli term`) |
| Check client/CLI paths, URI registration, registered PVE/VNC targets, or CUA bus lease | `uu_status({ includeCliStatus: true })` |
| Connect / disconnect a paired UU device, PVE VM, or VNC host, or rescue windows | `uu_launch({ action: "connect" \| "disconnect" \| "connect_device" \| "disconnect_device" \| "open_client" \| "recover_offscreen", deviceId })` (PVE: `pveHost`+`vmid`; VNC: `vncHost`+`vncPort`+optional in-memory `vncPassword`/`sshHost`) |
| Screenshot, zoom crop, opt-in grid overlay, or inject coalesced mouse/keyboard/clipboard actions | `uu_control({ sessionId, action, actions, zoom, zoomRelative, overlay, screenshotId, settleMs, waitForSettle, dedupeUnchanged, coordinateMode: "normalized_1000" })` |

## Pre-Flight & Execution Rules

1. **Inspect sessions first**: Call `uu_sessions()` before acting unless you already have a live `uu:<hwnd>`, `pve:<ssh_host>:<vmid>`, or `vnc:<host>:<port>` ID. Never omit `deviceId` on `disconnect` / `disconnect_device`.
2. **Unified coordinates & zoom**: Keep `coordinateMode: "normalized_1000"` (`(0, 0)` top-left to `(1000, 1000)` bottom-right). Pass `zoom: { x, y, width, height }` to inspect dense UI at native resolution; pass `zoomRelative: true` when expressing follow-up coordinates relative to the last zoomed crop (matching `kiki-cua`). Use `overlay: "grid"` only when coordinate ticks help locate small targets.
3. **Geometry guard & honest effects**: Pass the prior `screenshotId` on high-stakes clicks to fail closed (`capture_geometry_mismatch`) if the remote display resized or shifted. Inspect `effect` (`confirmed`, `unverifiable`, `suspected_noop`, `refused`), `diff`, and the returned screenshot before repeating state-changing actions. Never submit payments, destructive deletions, or external publications without explicit user confirmation.
4. **Batch clear steps**: Combine ordered sequences in `actions: [...]` (e.g., click field -> `type` -> `submit: true`) with `observeAfter: true`. Consecutive input steps coalesce into a single RPC on UU Win32 and PVE QMP, and settle via RFB dirty-rect quiet windows on `pve-rfb`/`rfb`.
5. **VNC credentials**: `vncPassword` is held strictly in memory and never persisted to disk, logged, or echoed. After a plugin restart, reconnect with `uu_launch({ action: "connect", deviceId: "vnc:...", vncPassword: "..." })`.

## Failure Recovery

- **No open session**: Call `uu_sessions({ action: "list" })` to find online `pairedDevices` or registered PVE/VNC targets, then call `uu_launch({ action: "connect", deviceId: "<id>" })`.
- **`state: "minimized"`**: Minimized Qt windows cannot render `PrintWindow` frames. Run `uu_control({ sessionId, action: "restore" })` first.
- **`state: "offscreen"`**: Run `uu_launch({ action: "recover_offscreen" })` to move stranded `GameViewer` windows back onto the primary display without stealing focus.
- **`unicode_input_unsupported`**: The remote guest lacks both RFB `ExtendedClipboard` (PVE `clipboard=vnc` + `spice-vdagent`) and QEMU Guest Agent. Do not retry non-ASCII typing blindly; use ASCII input, enable an agent on the guest, or ask the user.
- **`capture_geometry_mismatch` (HTTP 409)**: The target display resized or shifted after the referenced `screenshotId`. Capture a fresh `uu_control({ action: "screenshot" })` before retrying.
- **`Ctrl+Alt+*` shortcut rejected (UU Remote)**: `Ctrl+Alt+{Enter,G,F,P,U,Left,Right}` triggers UU Remote's local overlay/fullscreen UI. Pass `allowClientHotkey: true` only when intentionally toggling the local client. (PVE and VNC sessions forward `Ctrl+Alt+*` directly to the guest.)
- **`human_takeover_active` (HTTP 409)**: Human Takeover immediately aborts in-flight agent batches and releases held keys/buttons. Stop and yield to the user; inspect `lastHumanSummary` once takeover is released.

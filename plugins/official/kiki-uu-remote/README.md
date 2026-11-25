# Kiki UU Remote (`kiki-uu-remote`)

Preview and operate NetEase UU Remote (`GameViewer.exe` + `uuyc-cli`), Proxmox VE QEMU VM desktops (`pve:<ssh_host>:<vmid>` via lossless RFB 3.8 over SSH `qm vncproxy` with automatic QMP/QGA fallback), and direct or SSH-tunneled VNC desktops (`vnc:<host>:<port>`), with live workspace streaming, Human Takeover abort/release, and `kiki.cua.provider.v1` bus integration.

## Capabilities

- **Zero-Dependency RFB 3.8 Primary Engine (`pve:` & `vnc:`)**: Uses vendored `rfb2@1.1.0` (MIT, zero runtime dependencies) with lossless encodings (ZRLE, Tight, CopyRect, Raw), QEMU Extended Key Event AT Set-1 scancodes, 2 MiB capped `ExtendedClipboard` UTF-8, dirty-rect settle detection, desktop resize invalidation, and automatic recovery across `qm vncproxy` idle disconnects without replaying mid-flight non-idempotent input.
- **PVE QMP Fallback & QGA Sidechannel**: Keeps `/var/run/qemu-server/<vmid>.qmp` strictly short-lived per request, uses `/dev/shm` with remote SHA-256 unchanged-frame skipping, caches `probeStatus` for 5 seconds, and lazily probes QEMU Guest Agent for clipboard/Unicode injection when `ExtendedClipboard` is unavailable.
- **Background Win32 Stage Capture (`uu:<hwnd>`)**: Captures `GameViewer` stages via `PrintWindow(PW_RENDERFULLCONTENT)` under `PER_MONITOR_AWARE_V2` without stealing focus, trims symmetric black bars, coalesces consecutive input steps into single `SendInput` batches, and releases stuck modifiers/buttons on takeover or abort.
- **Workspace Live Preview & Human Takeover**: Streams binary PNG frames over `openPanelStream` with SHA-256 unchanged-frame suppression, event-driven RFB dirty-rect pushes, lightweight `telemetry` messages, panel RPCs for PVE/VNC connect/disconnect and clipboard pull/push, immediate `AbortController` cancellation on Human Takeover, and debounced `lastHumanSummary` reporting.
- **CUA Provider Bus (`kiki.cua.provider.v1`)**: Publishes an authenticated `127.0.0.1` loopback endpoint with atomic lease heartbeats so `kiki-cua` can discover, observe (with `zoom` and opt-in `overlay: "grid"`), and control `uu:`, `pve:`, and `vnc:` targets.

## Requirements

- Node.js `>=24.15.0` (zero native compilation).
- For `uu:<hwnd>` sessions: NetEase UU Remote installed locally (`GameViewer.exe` and `uuyc-cli.exe` on Windows, or `/Applications/UURemote.app` on macOS; portal: <https://uuyc.163.com/>, WinGet ID: `NetEase.UURemote`). No NetEase binaries are redistributed.
- For `pve:<ssh_host>:<vmid>` sessions: Passwordless `ssh` (`BatchMode=yes`) to the Proxmox VE host with `python3` and `qm` access.
- For `vnc:<host>:<port>` sessions: Reachable VNC server (directly or via `sshHost` jump tunnel). VNC passwords stay in memory only and are never written to disk.

## Install for Local Development

From the `kiki-plugins` repository root inside Kiki:

```sh
/plugins install --trust ./plugins/official/kiki-uu-remote
/plugins enable kiki-uu-remote
```

## Tools

| Tool | Disclosure | Purpose |
| --- | --- | --- |
| `uu_status` | `inline` | Inspect local `GameViewer` / `uuyc-cli` status, URI schemes, registered PVE/VNC targets, Provider Bus lease, and active sessions |
| `uu_sessions` | `inline` | List `uu:<hwnd>`, `pve:<ssh_host>:<vmid>`, and `vnc:<host>:<port>` sessions plus paired devices; select default session; or toggle Human Takeover |
| `uu_control` | `inline` | Capture screenshots (zoom, opt-in `overlay: "grid"`, `dedupeUnchanged`) or execute coalesced mouse/keyboard/clipboard actions with `screenshotId` guard and settle detection |
| `uu_launch` | `deferred` | Open UU Remote client, connect/disconnect paired devices, PVE VMs, or VNC targets, open `uuremote://` URIs, or rescue off-screen windows |

## License

MIT (see `THIRD_PARTY_NOTICES.md` for bundled `rfb2` MIT notice and `keycodemapdb` attribution).

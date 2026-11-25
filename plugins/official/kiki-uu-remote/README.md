# Kiki UU Remote (`kiki-uu-remote`)

Preview and operate NetEase UU Remote (`GameViewer.exe` + `uuyc-cli`) and Proxmox VE QEMU VM (`SSH` + `QMP`) remote desktop sessions from Kiki, with live workspace streaming, zero-focus background screenshots, automatic black-bar cropping, Human Takeover lock, and `kiki.cua.provider.v1` provider bus registration.

## Capabilities

- **Background Win32 Stage Capture**: Captures the top-level `VideoMainWindow` via `PrintWindow(PW_RENDERFULLCONTENT)` under `PER_MONITOR_AWARE_V2` without stealing focus, crops directly to the inner `GameViewer` render stage (eliminating top header chrome offset), and trims symmetric letterbox or pillarbox bars while guarding dark or sleeping screens against false collapse.
- **Native Proxmox VE QMP Backend (`pve:<ssh_host>:<vmid>`)**: Connects over passwordless SSH to Proxmox VE QEMU UNIX QMP sockets (`/var/run/qemu-server/<vmid>.qmp`) via a persistent zero-dependency Python 3 bridge—capturing gzip-compressed P6 PPM screendumps decoded in pure JS into PNG (with native `zoom` cropping), injecting USB Tablet absolute pointer events (`0..32767`) and `send-key` keyboard chords/ASCII text, persisting registered targets in plugin `stateDir`, and streaming directly into both the `UU Remote` live workspace panel and the `kiki.cua.provider.v1` bus.
- **Official `uuyc-cli` Integration**: Discovers `uuyc-cli` across plugin settings, Windows Registry (`instDir`), standard installation directories, and `PATH` to inspect diagnostics, list online/offline paired workstations (`Remote Mac Studio`, `Office Workstation`), inspect remote terminal sessions, and connect or disconnect specific devices safely.
- **Workspace Live Preview & Direct Canvas Manipulation**: Streams remote desktop frames into Kiki's `UU Remote` workspace panel over `openPanelStream` (with `handlePanelRequest` fallback), provides one-click off-screen window rescue, and gates direct canvas control behind a single-click **Takeover Control (`Alt+T`)** toggle—supporting `object-fit: contain` inverse-mapped left/double/right/modifier clicks, drag trajectories, wheel scroll, direct keyboard chords, clipboard text paste, and immediate low-latency frame refresh.
- **CUA Provider Bus (`kiki.cua.provider.v1`)**: Publishes an authenticated `127.0.0.1` loopback provider endpoint and atomic heartbeat lease (`kiki-uu-remote.json`) so `kiki-cua` can discover, observe, zoom, and control `uu:<hwnd>` targets out of the box.

## Requirements

- NetEase UU Remote desktop client installed locally (`C:\Program Files\NetEase\GameViewer\bin\GameViewer.exe` and `bin\uuyc-cli.exe` on Windows, or `/Applications/UURemote.app` on macOS; portal: <https://uuyc.163.com/>, WinGet ID: `NetEase.UURemote`).
- No NetEase binaries are redistributed by this package.

## Install for Local Development

From the `kiki-plugins` repository root inside Kiki:

```sh
/plugins install --trust ./plugins/official/kiki-uu-remote
/plugins enable kiki-uu-remote
```

## Tools

| Tool | Disclosure | Purpose |
| --- | --- | --- |
| `uu_status` | `inline` | Check local `GameViewer` / `uuyc-cli` installation, URI schemes, `uuyc-cli status --json`, Provider Bus lease, and active session counts |
| `uu_sessions` | `inline` | List `uu:<hwnd>` streaming windows, paired `uuyc-cli` devices, and remote terminals; select default session; or lock/unlock Human Takeover |
| `uu_control` | `inline` | Capture background screenshots (with black-bar trim + optional `zoom`) or inject mouse, keyboard, clipboard, focus, and restore actions |
| `uu_launch` | `deferred` | Open UU Remote client, connect/disconnect a specific `deviceId` via `uuyc-cli`, open `uuremote://` URIs, or rescue off-screen windows |

## License

MIT

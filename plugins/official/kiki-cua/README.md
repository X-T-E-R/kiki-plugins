# Kiki Computer Use (`kiki-cua`)

Unified native desktop and cross-plugin remote computer-use control for Kiki, paired with a live paper-and-ink `Computer Preview` workspace panel.

## Capabilities

- **Zero-addon OS drivers**:
  - **Windows (`win32`)**: Persistent PowerShell + compiled C# bridge with `PER_MONITOR_AWARE_V2` DPI awareness, negative-offset multi-monitor virtual desktop precision (`MOUSEEVENTF_VIRTUALDESK` `Int64` `(vw - 1)` / `(vh - 1)` mapping), sub-100ms 4K `HighQualityBicubic` capture, bounded 750ms UI Automation inspection, UIPI elevated-window detection, scancode chord injection with guaranteed `ReleaseAllInputs` cleanup, and `Win+V`-excluded clipboard paste.
  - **macOS & Linux**: Built-in `screencapture` / CoreGraphics JXA on macOS and `grim` / `import` + `xdotool` / `wmctrl` on Linux.
- **Cross-plugin Remote Target Provider Bus (`kiki.cua.provider.v1`)**:
  - Discovers companion Remote Display/Input Target Providers (for example `kiki-uu-remote`) via atomic `0600` loopback lease files (`^http://127\.0\.0\.1:\d{2,5}$` + constant-time `Bearer` authentication), aggregating local monitors and remote desktops under one target selector.
- **Human-Takeover Guard**:
  - Manual lock toggle in `cua_targets` and the `Computer Preview` panel, automatic lock when clicking directly on the live preview canvas, and automatic physical mouse displacement detection (`takeoverThresholdPx`, default `48` px) on local displays.

## Tools

| Tool | Disclosure | Purpose |
| --- | --- | --- |
| `cua_targets` | `inline` | `list`, `select`, or toggle `takeover` across `local:primary`, `local:monitor-*`, `local:window:<hwnd>`, and remote `kiki.cua.provider.v1` targets. |
| `cua_observe` | `inline` | Capture PNG screenshot, cursor coordinates, foreground window metadata, native full-resolution `zoom` crops before scaling, and optional `grid` / `som` overlays. |
| `cua_act` | `inline` | Execute `1..16` deterministic actions (`click`, `move`, `mouse_down`, `mouse_up`, `drag`, `scroll`, `type`, `key`, `hold_key`, `wait`, `clipboard_get`, `clipboard_set`) with `zoomRelative` support and post-action screenshot capture. |
| `cua_windows` | `deferred` | `list`, `focus`, or `restore` top-level desktop windows with DPI, bounds, process name, and UIPI elevation metadata. |

## Install Locally

From the `kiki-plugins` repository root:

```sh
/plugins install --trust ./plugins/official/kiki-cua
/plugins enable kiki-cua
```

## Development Checks

```sh
node plugins/official/kiki-cua/scripts/sync-manifest.mjs --check
node --test plugins/official/kiki-cua/test/cua.test.mjs
```

## License

MIT

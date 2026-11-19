# kiki-v42

Official Kiki plugin (`kiki-v42`) bridging Vibe42 remote Computers, Workspaces, coding Agent seats (`AgentView` + `tmux`/`psmux`), copy-on-write (COW) workspace copies, persistent remote desktop & mobile screens, and TCP port tunnels into Kiki.

## Capabilities

- **Cross-Platform Companion & Session Auto-Discovery**
  - Auto-discovers the installed Vibe42 Companion binary and matching `--companion-root` across Windows (`%LOCALAPPDATA%\ai.vibecafe.v42.companion`), macOS (`~/.v42`, `~/Library/Application Support/ai.vibecafe.v42.companion`, `/Applications/Vibe42.app`), and Linux (`~/.v42`, `~/.local/share/ai.vibecafe.v42.companion`), even under stripped plugin environments.
  - Identifies itself with `--agent-name kiki` (`V42_AGENT_NAME=kiki`), probes `whoami` across installed channels, and gracefully adapts between Companion CLI releases (`resources` fallback + full `computer`/`term`/`desktop`/`mobile` subcommands).
- **5 High-Level Semantic Tools**
  - `v42_fleet` — Inspect signed-in account, online Computers, Workspaces, leased/unmanaged coding seats, mobile devices, memos, and active port forwards.
  - `v42_seat_run` — Dispatch or steer remote coding seats (`claude-code`, `codex`, `opencode`, `omp`, `agy`, `grok`, `kiki`), pin/unpin targets into the session lease, interrupt, or adjust seat controls (`wait_mode: "auto" | "async" | "turn"`, exit-8 `wait_timeout` handling, 64-slot idempotency ring, and `409 human_controlling` takeover protection).
  - `v42_seat_inspect` — Read incremental turns/rows via `since_cursor`, expand folded `more` blocks, inspect subagents, pull remote media as native vision attachments, inspect COW `copy_diff`, or read terminal scrollback.
  - `v42_seat_resolve` — Answer non-privileged `questions` or run COW copy actions (`status`, `save_snapshot`, `apply_to_workspace`, `push`). Remote `approval` and `login` prompts remain strictly human-only in the Workbench panel.
  - `v42_env_transfer` — Push/pull/sync files across admitted local workspace paths and remote Computers (with in-flight dedup and stale `transfer-*.lock` pruning), capture remote desktop or mobile screenshots, and manage `127.0.0.1` port forwards.
- **Route C Pinned-Only Lease & Wide-Stage `guiSlots`**
  - Opens in `PreviewWorkspace` via `composer-toolbar`, live `status-capsule` (when targets are leased), and `/v42-workbench`.
  - Only seats, desktops, mobile devices, and port tunnels created by Kiki or explicitly pinned appear in `E5:prompt-context` (`<= 2 KiB`) and `status-capsule`.
- **CUA Remote Target Provider Bus v1 (`kiki.cua.provider.v1`)**
  - Publishes an atomic `0o600` provider lease (`<busDir>/kiki-v42.json`) and authenticated `127.0.0.1` HTTP server exposing `v42:<computer>:desktop` and `v42:<computer>:mobile:<deviceId>` targets with native PNG `zoom` cropping, coordinate mapping, and shared Human Takeover Leases.
- **Paper-and-Ink Workbench (`panel.html` + `shared/panel-kit/`)**
  - Live `Fleet` overview (Computers, Workspaces, Active Seats, Port Forwards with 1-click filter/pin/open), plus `Chat`, `Terminal`, `Desktop`, `Mobile`, and `Ports` surfaces synced to Kiki's `shared/panel-kit/`.

## Verification

```bash
node plugins/official/kiki-v42/scripts/sync-manifest.mjs --check
npm run sync:panels -- --check
npm run check -- kiki-v42
```

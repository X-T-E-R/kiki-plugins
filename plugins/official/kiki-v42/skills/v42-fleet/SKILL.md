---
name: v42-fleet
description: Orchestrate remote Vibe42 Computers, coding Agent seats, COW workspace copies, remote desktop/mobile screens, and TCP port forwards through kiki-v42. Use when dispatching or inspecting remote coding agents, transferring workspace files across Vibe42 machines, forwarding remote dev ports, or coordinating remote desktop and mobile screens.
---

# Vibe42 Remote Fleet & Workbench (`v42-fleet`)

Operate remote Vibe42 Computers, coding Agent seats, isolated COW workspace copies, remote desktops, mobile devices, and local TCP port tunnels cleanly without terminal-scraping noise.

## Mental Model & Conventions

- **Identity**: `kiki-v42` automatically identifies itself with `--agent-name kiki` (`V42_AGENT_NAME=kiki`) and resolves the signed-in Companion `--companion-root` across Windows, macOS, and Linux.
- **Targets & IDs**:
  - `<computer>` and `<workspace>` accept either a UUID (`i-...`) or a name (`Studio Mac Mini`, `dev-box`).
  - Terminal targets use window ID (`@3`), pane ID (`%5`), or `<session>:@3`. A seat reference is `<computer>:<target>` (e.g. `i-36c3b2b6:@3` or `mac-mini:%5`).
- **Wait instead of polling**: `v42_seat_run` uses `v42 term wait --until done` under the hood. `--until done` keeps waiting while an agent is blocked on confirmation or in error. Exit code `8` (`wait_timeout`) is normal, not a crash: inspect status (`v42_seat_inspect`) before waiting or steering again.
- **Official `v42` exit codes**:
  - `0`: success
  - `2`: usage error, `confirmation_required` (`--yes` missing), or `terminal_busy` (`--force` missing)
  - `3`: not signed in or session expired (`v42 login`)
  - `4`: permission denied
  - `5`: local storage or Companion I/O failure
  - `6`: invalid request, not found, or conflict
  - `7`: network/remote failure or timeout
  - `8`: `v42 term wait` timed out (`wait_timeout`)

## Tool Workflow

1. **Discover Fleet & Leased Targets (`v42_fleet`)**
   - Call `v42_fleet({ scope: "summary" })` to inspect signed-in account, online Computers, Workspaces, active port tunnels, and coding seats (`leased: true | false`).
   - Narrow queries with `scope: "workspaces" | "seats" | "devices" | "memos" | "forwards"` and optional `computer` / `workspace` / `status_filter`.
   - Only leased targets (created by Kiki or pinned via `v42_seat_run({ action: "pin" })`) stay in `<v42-context>` (`E5:prompt-context`) and the session `status-capsule`. Do not pin dozens of unrelated background shells.
   - Open the Workbench in the wide `PreviewWorkspace` stage via the composer toolbar (`Vibe42` / `远端工位`), the active `status-capsule`, or `/v42-workbench`.

2. **Dispatch, Steer, or Pin Seats (`v42_seat_run`)**
   - Create a seat and send work in one call:
     `v42_seat_run({ action: "dispatch", computer: "<id>", workspace: "<ws>", agent: "claude-code", prompt: "...", wait_mode: "auto", idempotency_key: "step-1" })`
   - `wait_mode: "auto"` waits up to ~25s (`--until done`); if the turn is still running (exit `8`), it returns `{ background: true, wait_timed_out: true, status: "working", seat_ref, session, cursor }`.
   - Pass `expected_session` and `idempotency_key` when steering an existing `seat_ref`.
   - Pin an existing seat, desktop, or mobile device into the session lease with `action: "pin"` (`"<computer>:@N"`, `"<computer>:%N"`, `"<computer>:desktop"`, or `"<computer>:mobile:<deviceId>"`).

3. **Incremental Inspection (`v42_seat_inspect`)**
   - Check progress with `v42_seat_inspect({ seat_ref, mode: "turns", since_cursor })` rather than re-reading full transcripts or polling in tight loops.
   - Use `mode: "copy_diff"` to review COW copy edits before applying, `mode: "media"` to pull remote images as vision attachments, and `mode: "terminal_screen"` for raw CLI output.

4. **Questions, Approvals & COW Copies (`v42_seat_resolve`)**
   - **Never self-approve remote `approval`, `permission`, or `login` prompts.** `v42_seat_resolve` allows only `resolution.kind: "answers" | "dismiss"` for non-privileged clarifying questions. When blocked on approval or sign-in, state the pending action and ask the user to click **Allow once** or **Deny** in the Workbench panel.
   - Manage isolated COW copies with `copy_action: "status" | "save_snapshot" | "apply_to_workspace" | "push"`. Only apply changes back to the workspace when the user explicitly asks.

5. **Files, Screens & Port Tunnels (`v42_env_transfer` & CUA Bus)**
   - Transfer files between admitted local workspace paths and remote machines with `pull`, `push`, or `sync_to_remote` (do not loop retries on failed transfers).
   - Forward remote loopback web/API ports to `127.0.0.1` with `port_forward_start` before inspecting remote services locally.
   - Capture one-shot frames via `desktop_screenshot` / `mobile_screenshot`, or operate `v42:<computer>:desktop` and `v42:<computer>:mobile:<deviceId>` through `kiki-cua` (`kiki.cua.provider.v1`) or the Workbench's **Interactive** canvas mode.

## Safety Rules on Shared Team Computers

- **Leave teammate terminals alone**: Shared Team Computers (such as team Mac Minis or build boxes) run active human and agent sessions. Never send input to, interrupt, close, or rename terminals you did not create unless the user explicitly names that target.
- **No unprompted destructive flags**: Never force-close busy/unknown terminals (`terminal_busy`, exit `2`) or push/apply COW edits without explicit user approval.
- **Look before acting on remote desktops**: Capture a screenshot before clicking or typing on a real desktop; never type passwords into a desktop or unlock a locked machine unprompted.

## Fast Error Recovery

- **`ENOENT`**: Install Vibe42 Companion, set `v42BinPath` in Kiki Plugin Settings, or export `KIKI_V42_BIN`.
- **`not_logged_in` (exit `3`)**: Ask the user to sign in via the Vibe42 desktop app or run `v42 login`; if using a non-default channel, set `companionRoot` in Plugin Settings.
- **`cli_upgrade_required`**: The discovered `v42` binary is an older release missing the requested subcommand (for example `term read`, `desktop`, or `mobile`); upgrade Vibe42 Companion or point `v42BinPath` at a newer `v42` CLI.
- **`409 human_controlling` / `human_takeover_active`**: A human is operating the seat or Interactive canvas in the Workbench. Stop mutating that target and wait for **Hand back** unless explicitly instructed to set `override_human_lease: true`.
- **`409 session_changed`**: Call `v42_seat_inspect({ seat_ref, mode: "turns" })` to refresh `session` before sending further instructions.
- **`403 path_not_admitted`**: Use a workspace-relative `local_path` or ask the user to approve the external directory first.
